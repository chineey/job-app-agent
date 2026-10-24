import { NextRequest, NextResponse } from 'next/server';
import { authorizeCronRequest, unauthorizedResponse } from '@/lib/auth';
import { sql, logEvent } from '@/lib/db';
import { getGmailClientForUser, createGmailDraft } from '@/lib/gmail';
import { sendTelegramMessage } from '@/lib/telegram';
import { MasterFacts } from '@/lib/schemas';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!authorizeCronRequest(req)) {
    return unauthorizedResponse();
  }

  try {
    // Select sent applications 7+ days old with no replies and no follow-up draft created
    const candidateApps = (await sql`
      select a.*, u.telegram_chat_id, u.gmail_address, f.facts
      from applications a
      join users u on a.user_id = u.id
      left join facts_versions f on a.facts_version_id = f.id
      where a.status = 'sent'
        and a.applied_at <= now() - interval '7 days'
        and a.reply_type is null
        and a.followup_draft_id is null
        and a.gmail_thread_id is not null
        and u.gmail_status = 'connected'
      limit 10;
    `) as Array<{
      id: string;
      user_id: string;
      contact_email: string;
      email_subject: string;
      gmail_thread_id: string;
      applied_at: string;
      telegram_chat_id: number;
      gmail_address: string;
      facts: MasterFacts | null;
    }>;

    let followupsDrafted = 0;

    for (const app of candidateApps) {
      try {
        const { gmail } = await getGmailClientForUser(app.user_id);
        const candidateName = app.facts?.identity.name || 'Candidate';

        const followUpBody = [
          `Hi team,`,
          '',
          `I am following up on my application submitted on ${new Date(app.applied_at).toLocaleDateString()} for the role referenced in the subject.`,
          '',
          `I remain very interested in the position and would welcome the opportunity to discuss how my engineering background aligns with your current team priorities.`,
          '',
          `Best regards,`,
          candidateName,
        ].join('\n');

        const draftRes = await createGmailDraft(gmail, {
          to: app.contact_email,
          from: app.gmail_address,
          subject: `Following Up: ${app.email_subject || 'Application'}`,
          bodyText: followUpBody,
          threadId: app.gmail_thread_id,
        });

        await sql`
          update applications
          set followup_draft_id = ${draftRes.id}, updated_at = now()
          where id = ${app.id};
        `;

        await logEvent(app.user_id, 'followup_draft_created', { applicationId: app.id, draftId: draftRes.id });

        if (app.telegram_chat_id) {
          await sendTelegramMessage(
            app.telegram_chat_id,
            `⏳ *7-Day Follow-Up Draft Created*\n\n` +
              `*To:* \`${app.contact_email}\`\n` +
              `*Subject:* Following Up: ${app.email_subject}\n\n` +
              `A polite follow-up inquiry has been prepared as a draft in your Gmail thread. You can review and send it directly from your Gmail account.`
          );
        }

        followupsDrafted++;
      } catch (err) {
        console.error(`Follow-up draft failed for application ${app.id}:`, err);
      }
    }

    return NextResponse.json({
      ok: true,
      eligibleApplications: candidateApps.length,
      followupsDrafted,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('Followups cron error:', err);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
