import { sql, logEvent, assertUserScope } from './db';

// A user's own applications, as Telegram commands see them. Every query is scoped by user_id.

/** Statuses an application can be skipped from: anything before it is reserved for sending or settled. */
const SKIPPABLE = ['queued', 'extracted', 'matched', 'drafted', 'verified', 'ready', 'link_ready', 'needs_manual'];

/**
 * Skips one of the user's applications that has not been reserved for sending. Returns the status it
 * had, or null if there is no such application or it is past the point where skipping applies.
 */
export async function skipApplication(userId: string, applicationId: string): Promise<string | null> {
  assertUserScope(userId);
  // One conditional update: a send worker that reserves the row first leaves it 'sending', which is not skippable.
  const [skipped] = (await sql`
    update applications a
    set status = 'skipped', status_reason = 'user_skip', updated_at = now()
    from applications before
    where a.id = ${applicationId} and a.user_id = ${userId} and a.status = any(${SKIPPABLE})
      and before.id = a.id
    returning before.status as previous_status
  `) as Array<{ previous_status: string }>;
  if (!skipped) return null;
  await logEvent(userId, 'application_skipped', { previousStatus: skipped.previous_status }, null, applicationId);
  return skipped.previous_status;
}

export async function recentSends(
  userId: string
): Promise<Array<{ contact_email: string; email_subject: string | null; applied_at: string }>> {
  assertUserScope(userId);
  return (await sql`
    select contact_email, email_subject, applied_at::text as applied_at
    from applications
    where user_id = ${userId} and imported = false and applied_at is not null and route = 'email'
      and status in ('sent', 'replied', 'bounced', 'closed_by_employer')
    order by applied_at desc
    limit 5
  `) as Array<{ contact_email: string; email_subject: string | null; applied_at: string }>;
}

export async function openDrafts(
  userId: string
): Promise<Array<{ contact_email: string; kind: 'reply' | 'follow-up'; gmail_thread_id: string }>> {
  assertUserScope(userId);
  return (await sql`
    select contact_email, case when reply_draft_id is not null then 'reply' else 'follow-up' end as kind, gmail_thread_id
    from applications
    where user_id = ${userId} and gmail_thread_id is not null
      and (reply_draft_id is not null or followup_draft_id is not null)
      and status in ('sent', 'replied')
    order by coalesce(last_reply_at, applied_at) desc
    limit 10
  `) as Array<{ contact_email: string; kind: 'reply' | 'follow-up'; gmail_thread_id: string }>;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const IMPORT_LIMIT = 50;

/**
 * Records addresses the user already applied to outside the agent, so the 30-day contact check
 * does not apply to them again. Returns how many were new; invalid entries are returned for the reply.
 */
export async function importPastRecipients(
  userId: string,
  entries: string[]
): Promise<{ imported: number; alreadyKnown: number; invalid: string[] }> {
  assertUserScope(userId);
  const emails = [...new Set(entries.map((entry) => entry.trim().toLowerCase()).filter((e) => EMAIL_PATTERN.test(e)))];
  const invalid = entries.filter((entry) => !EMAIL_PATTERN.test(entry.trim()));

  const inserted = await sql`
    insert into applications (user_id, imported, contact_email, route, status, applied_at)
    select ${userId}, true, email, 'email', 'sent', now()
    from unnest(${emails}::text[]) as email
    where not exists (
      select 1 from applications a where a.user_id = ${userId} and lower(a.contact_email) = email
    )
    returning id
  `;
  await logEvent(userId, 'past_recipients_imported', { count: inserted.length });
  return { imported: inserted.length, alreadyKnown: emails.length - inserted.length, invalid };
}
