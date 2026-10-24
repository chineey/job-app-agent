import { NextRequest, NextResponse } from 'next/server';
import { authorizeCronRequest, unauthorizedResponse } from '@/lib/auth';
import { sql, logEvent } from '@/lib/db';
import { getGmailClientForUser, searchBounces, getThreadInboundMessages, createGmailDraft } from '@/lib/gmail';
import { classifyRecruiterReply, generateReplyDraft } from '@/lib/gemini';
import { autoPauseUser, getUserSettings } from '@/lib/users';
import { sendTelegramMessage } from '@/lib/telegram';
import { MasterFacts } from '@/lib/schemas';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!authorizeCronRequest(req)) {
    return unauthorizedResponse();
  }

  try {
    // Select up to 5 active connected users in rotation
    const users = (await sql`
      select id, telegram_chat_id, gmail_address
      from users
      where status = 'active' and gmail_status = 'connected'
      order by last_inbox_scan_at asc nulls first
      limit 5;
    `) as Array<{ id: string; telegram_chat_id: number; gmail_address: string }>;

    let totalBouncesFound = 0;
    let totalRepliesFound = 0;
    let totalDraftsCreated = 0;

    for (const user of users) {
      try {
        const { gmail } = await getGmailClientForUser(user.id);
        const settings = await getUserSettings(user.id);

        // 1. Process Bounces
        const bounces = await searchBounces(gmail);
        for (const b of bounces) {
          // Attempt to match by threadId or recipient snippet
          const matchRows = (await sql`
            update applications
            set status = 'bounced', status_reason = 'mailer_daemon_bounce', updated_at = now()
            where user_id = ${user.id} and status = 'sent' and (gmail_thread_id = ${b.threadId} or ${b.snippet} ilike '%' || contact_email || '%')
            returning id, contact_email;
          `) as Array<{ id: string; contact_email: string }>;

          if (matchRows.length > 0) {
            totalBouncesFound += matchRows.length;
            await logEvent(user.id, 'application_bounced', { bounceId: b.id, snippet: b.snippet });

            // Check bounce rate for auto-pause (over last 20 sends)
            const recentSends = (await sql`
              select status from applications
              where user_id = ${user.id} and applied_at is not null
              order by applied_at desc limit 20;
            `) as Array<{ status: string }>;

            const bouncedCount = recentSends.filter((s) => s.status === 'bounced').length;
            const bounceRate = recentSends.length > 0 ? (bouncedCount / recentSends.length) * 100 : 0;

            if (bounceRate > 5 && recentSends.length >= 10) {
              await autoPauseUser(user.id, `Elevated bounce rate (${Math.round(bounceRate)}%)`);
              if (user.telegram_chat_id) {
                await sendTelegramMessage(
                  user.telegram_chat_id,
                  `🚨 *Auto-Pause Activated: High Bounce Rate*\n\n` +
                    `Your recent bounce rate reached ${Math.round(bounceRate)}%. Sends are temporarily paused to protect your email domain reputation.`
                );
              }
            } else if (user.telegram_chat_id) {
              await sendTelegramMessage(
                user.telegram_chat_id,
                `⚠️ *Delivery Bounce Detected*\nAn application to \`${matchRows[0].contact_email}\` bounced.`
              );
            }
          }
        }

        // 2. Process Inbound Recruiter Replies
        const sentApps = (await sql`
          select a.*, f.facts
          from applications a
          left join facts_versions f on a.facts_version_id = f.id
          where a.user_id = ${user.id} and a.status = 'sent' and a.gmail_thread_id is not null
          limit 10;
        `) as Array<{
          id: string;
          contact_email: string;
          email_subject: string;
          gmail_thread_id: string;
          facts: MasterFacts | null;
        }>;

        for (const app of sentApps) {
          const inboundMsgs = await getThreadInboundMessages(gmail, app.gmail_thread_id, user.gmail_address);
          if (inboundMsgs.length === 0) continue;

          const latestMsg = inboundMsgs[inboundMsgs.length - 1];
          totalRepliesFound++;

          // Classify reply with Gemini
          const classification = await classifyRecruiterReply(latestMsg.text || latestMsg.snippet);

          if (classification.category === 'auto') {
            continue; // Skip automatic out-of-office receipts
          }

          if (classification.category === 'rejection') {
            await sql`
              update applications
              set status = 'closed_by_employer', reply_type = 'rejection', last_reply_at = now()
              where id = ${app.id};
            `;
            if (user.telegram_chat_id) {
              await sendTelegramMessage(
                user.telegram_chat_id,
                `ℹ️ Rejection notice received from \`${app.contact_email}\`. Application marked closed.`
              );
            }
            continue;
          }

          // If interview, assessment, or question: draft response
          let draftBody = '';
          if (app.facts) {
            const draftRes = await generateReplyDraft(latestMsg.text, app.facts, settings?.availability_note || undefined);
            draftBody = draftRes.reply_body;

            const draftResult = await createGmailDraft(gmail, {
              to: latestMsg.from,
              from: user.gmail_address,
              subject: `Re: ${app.email_subject || 'Application'}`,
              bodyText: draftBody,
              threadId: app.gmail_thread_id,
            });

            await sql`
              update applications
              set status = 'replied',
                  reply_type = ${classification.category},
                  reply_draft_id = ${draftResult.id},
                  last_reply_at = now()
              where id = ${app.id};
            `;

            totalDraftsCreated++;
          }

          // Telegram High-Priority Notification
          if (user.telegram_chat_id) {
            await sendTelegramMessage(
              user.telegram_chat_id,
              `📬 *Recruiter Reply: ${classification.category.toUpperCase()}!*\n\n` +
                `*From:* \`${latestMsg.from}\`\n` +
                `*Summary:* ${classification.summary}\n\n` +
                `*Message Snippet:*\n"${latestMsg.snippet}"\n\n` +
                (draftBody ? `*Drafted Reply in Gmail:*\n\`\`\`\n${draftBody}\n\`\`\`\n\n_Review and send directly from Gmail._` : '')
            );
          }
        }

        // Mark user scanned
        await sql`
          update users set last_inbox_scan_at = now() where id = ${user.id};
        `;
      } catch (userErr) {
        console.error(`Inbox scan error for user ${user.id}:`, userErr);
      }
    }

    return NextResponse.json({
      ok: true,
      scannedUsers: users.length,
      bouncesFound: totalBouncesFound,
      repliesFound: totalRepliesFound,
      draftsCreated: totalDraftsCreated,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('Inbox cron error:', err);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
