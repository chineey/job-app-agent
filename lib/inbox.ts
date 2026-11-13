import type { gmail_v1 } from 'googleapis';
import { sql, logEvent } from './db';
import { createGmailDraft, getThreadInboundMessages, searchBounces } from './gmail';
import { classifyRecruiterReply, generateReplyDraft } from './gemini';
import { pauseOnHighBounceRate } from './ramp';
import { sendTelegramMessage } from './telegram';
import type { MasterFacts } from './schemas';

// Inbox scan for one user. The agent reads only bounce notices and the threads its own applications
// started, and it only ever creates drafts: nothing here sends email. See docs/inbox-and-drafts.md.

/** Threads checked per user per run; the rest wait their turn (oldest check first). */
const THREADS_PER_RUN = 10;

export interface InboxUser {
  id: string;
  telegram_chat_id: number;
  gmail_address: string;
  availability_note: string | null;
}

export interface ScanCounts {
  bounces: number;
  replies: number;
  drafts: number;
}

export async function scanUserInbox(gmail: gmail_v1.Gmail, user: InboxUser): Promise<ScanCounts> {
  const bounces = await processBounces(gmail, user);
  const { replies, drafts } = await processReplies(gmail, user);
  return { bounces, replies, drafts };
}

/**
 * Marks the one application each bounce notice belongs to: the latest one sent to that address
 * before the notice arrived. A later send to the same address is not blamed for an old bounce.
 */
async function processBounces(gmail: gmail_v1.Gmail, user: InboxUser): Promise<number> {
  let marked = 0;
  for (const bounce of await searchBounces(gmail)) {
    const [bounced] = (await sql`
      update applications
      set status = 'bounced', status_reason = 'mailer_daemon_bounce', updated_at = now()
      where id = (
        select id from applications
        where user_id = ${user.id} and status = 'sent' and applied_at < ${bounce.receivedAt}
          and (gmail_thread_id = ${bounce.threadId} or ${bounce.snippet} ilike '%' || contact_email || '%')
        order by applied_at desc
        limit 1
      )
      returning id, contact_email
    `) as Array<{ id: string; contact_email: string }>;
    if (!bounced) continue;

    marked++;
    await logEvent(user.id, 'application_bounced', { bounceId: bounce.id }, null, bounced.id);
    await sendTelegramMessage(
      user.telegram_chat_id,
      `⚠️ *Delivery Bounce Detected*\nAn application to \`${bounced.contact_email}\` bounced.`
    );
    await pauseOnHighBounceRate(user.id);
  }
  return marked;
}

interface ThreadToCheck {
  id: string;
  contact_email: string;
  email_subject: string | null;
  gmail_thread_id: string;
  last_inbound_message_id: string | null;
  facts: MasterFacts | null;
}

/**
 * Handles the newest recruiter message in each application thread once: classify it, draft a reply
 * where one is useful, and alert the user. Threads that already got a reply stay in rotation, so a
 * second message from the recruiter is still seen.
 */
async function processReplies(gmail: gmail_v1.Gmail, user: InboxUser): Promise<{ replies: number; drafts: number }> {
  const threads = (await sql`
    select a.id, a.contact_email, a.email_subject, a.gmail_thread_id, a.last_inbound_message_id, f.facts
    from applications a
    left join facts_versions f on f.id = a.facts_version_id
    where a.user_id = ${user.id} and a.status in ('sent', 'replied') and a.gmail_thread_id is not null
    order by a.thread_checked_at asc nulls first, a.applied_at desc
    limit ${THREADS_PER_RUN}
  `) as ThreadToCheck[];

  let replies = 0;
  let drafts = 0;
  for (const thread of threads) {
    const inbound = await getThreadInboundMessages(gmail, thread.gmail_thread_id, user.gmail_address);
    await sql`update applications set thread_checked_at = now() where id = ${thread.id}`;

    const newest = inbound.at(-1);
    if (!newest || newest.id === thread.last_inbound_message_id) continue;

    // Claim the message before any side effect, so overlapping scans handle it once.
    const claimed = await sql`
      update applications set last_inbound_message_id = ${newest.id}
      where id = ${thread.id} and last_inbound_message_id is not distinct from ${thread.last_inbound_message_id}
      returning id
    `;
    if (claimed.length === 0) continue;
    replies++;

    let classification;
    try {
      classification = await classifyRecruiterReply(newest.text || newest.snippet);
    } catch (err) {
      // Never lose a reply because classification failed: tell the user to read it themselves.
      console.error(`Could not classify reply on application ${thread.id}:`, err);
      await sendTelegramMessage(
        user.telegram_chat_id,
        `📬 *New reply from* \`${newest.from}\`\n\n"${newest.snippet}"\n\n_Open Gmail to read it._`
      );
      continue;
    }

    if (classification.category === 'auto') {
      continue;
    }

    if (classification.category === 'rejection') {
      await sql`
        update applications
        set status = 'closed_by_employer', reply_type = 'rejection', last_reply_at = now(), updated_at = now()
        where id = ${thread.id}
      `;
      await sendTelegramMessage(
        user.telegram_chat_id,
        `ℹ️ Rejection notice received from \`${thread.contact_email}\`. Application marked closed.`
      );
      continue;
    }

    let draftBody: string | null = null;
    let draftId: string | null = null;
    const wantsDraft = ['interview', 'assessment', 'question'].includes(classification.category);
    if (wantsDraft && thread.facts) {
      const draft = await generateReplyDraft(newest.text, thread.facts, user.availability_note || undefined);
      const created = await createGmailDraft(gmail, {
        to: newest.from,
        from: user.gmail_address,
        subject: `Re: ${thread.email_subject || 'Application'}`,
        bodyText: draft.reply_body,
        threadId: thread.gmail_thread_id,
        inReplyTo: newest.messageIdHeader || null,
      });
      draftBody = draft.reply_body;
      draftId = created.id;
      drafts++;
    }

    await sql`
      update applications
      set status = 'replied', reply_type = ${classification.category}, reply_draft_id = coalesce(${draftId}, reply_draft_id),
          last_reply_at = now(), updated_at = now()
      where id = ${thread.id}
    `;
    await logEvent(user.id, 'recruiter_reply', { category: classification.category, draftId }, null, thread.id);
    await sendTelegramMessage(
      user.telegram_chat_id,
      `📬 *Recruiter Reply: ${classification.category.toUpperCase()}!*\n\n` +
        `*From:* \`${newest.from}\`\n` +
        `*Summary:* ${classification.summary}\n\n` +
        `*Message Snippet:*\n"${newest.snippet}"\n\n` +
        (draftBody ? `*Drafted Reply in Gmail:*\n\`\`\`\n${draftBody}\n\`\`\`\n\n_Review and send it yourself from Gmail._` : '')
    );
  }
  return { replies, drafts };
}
