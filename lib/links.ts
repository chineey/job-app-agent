import { sql, logEvent } from './db';
import { sendTelegramDocument, sendTelegramMessage } from './telegram';

// Link and form applications: the agent never opens or fills the form. It sends the user a card
// with the apply link, cover note and resume, once, and a reminder before the deadline.
// See docs/link-applications.md.

const BATCH = 20;

interface LinkApplication {
  id: string;
  user_id: string;
  telegram_chat_id: number;
  fit_score: number | null;
  gaps: string[] | null;
  cover_note: string | null;
  resume_blob_url: string | null;
  role: string | null;
  company: string | null;
  location: string | null;
  remote: boolean | null;
  salary: string | null;
  deadline: string | null;
  post_url: string;
  apply_link: string | null;
  apply_link_domain: string | null;
}

/** Sends new link applications and due reminders. Paused or inactive users are skipped until they return. */
export async function dispatchLinkApplications(): Promise<{ notified: number; reminded: number }> {
  // Reminders first: a card sent in this same run must not also produce a reminder.
  const reminded = await sendDeadlineReminders();

  const waiting = (await sql`
    select a.id
    from applications a
    join users u on u.id = a.user_id
    join user_settings s on s.user_id = a.user_id
    where a.status = 'link_ready' and a.link_notified_at is null and u.status = 'active' and s.paused = false
    order by a.created_at
    limit ${BATCH}
  `) as Array<{ id: string }>;

  let notified = 0;
  for (const { id } of waiting) {
    // Claim first so overlapping runs send a card once; give the claim back if Telegram refused it.
    const [app] = (await sql`
      update applications a
      set link_notified_at = now()
      from users u, jobs j
      where a.id = ${id} and a.link_notified_at is null and u.id = a.user_id and j.id = a.job_id
      returning a.id, a.user_id, u.telegram_chat_id, a.fit_score, a.gaps, a.cover_note, a.resume_blob_url,
                j.role, j.company, j.location, j.remote, j.salary, j.deadline::text as deadline, j.post_url,
                j.apply_link, j.apply_link_domain
    `) as LinkApplication[];
    if (!app) continue;

    if (!(await sendTelegramMessage(app.telegram_chat_id, linkCard(app)))) {
      await sql`update applications set link_notified_at = null where id = ${app.id}`;
      continue;
    }
    await sendResume(app);
    await logEvent(app.user_id, 'link_application_notified', {}, null, app.id);
    notified++;
  }
  return { notified, reminded };
}

/**
 * One reminder when a waiting link application's deadline is less than 48 hours away, but only if its
 * card went out before that window began (a card sent inside it is already marked urgent).
 */
async function sendDeadlineReminders(): Promise<number> {
  const due = (await sql`
    update applications a
    set link_reminded_at = now()
    from users u, jobs j
    where a.status = 'link_ready' and a.link_reminded_at is null and a.link_notified_at is not null
      and u.id = a.user_id and u.status = 'active' and j.id = a.job_id and j.deadline is not null
      and now() >= (j.deadline::timestamptz + interval '1 day') - interval '48 hours'
      and now() < j.deadline::timestamptz + interval '1 day'
      and a.link_notified_at < (j.deadline::timestamptz + interval '1 day') - interval '48 hours'
    returning a.id, u.telegram_chat_id, j.role, j.company, j.deadline::text as deadline
  `) as Array<{ id: string; telegram_chat_id: number; role: string | null; company: string | null; deadline: string }>;

  for (const app of due) {
    await sendTelegramMessage(
      app.telegram_chat_id,
      `⏰ *Deadline in under 48 hours:* ${app.role ?? 'Role'} at ${app.company ?? 'company'} (closes ${app.deadline}).\n\n` +
        `When you have applied, send \`/done ${app.id}\`.`
    );
  }
  return due.length;
}

function linkCard(app: LinkApplication): string {
  const hoursLeft = app.deadline ? (new Date(`${app.deadline}T23:59:59Z`).getTime() - Date.now()) / 3_600_000 : null;
  const deadline =
    app.deadline === null
      ? '📅 *Deadline:* none listed'
      : hoursLeft !== null && hoursLeft <= 48
        ? `🚨 *DEADLINE URGENT:* \`${app.deadline}\``
        : `📅 *Deadline:* ${app.deadline}`;

  return [
    `💼 *New Job Opportunity (Manual Apply)*`,
    '',
    `*Role:* ${app.role ?? 'Unknown'}`,
    `*Company:* ${app.company ?? 'Unknown'}`,
    `*Location:* ${app.remote ? 'Remote' : app.location || 'Not stated'}`,
    app.salary ? `*Salary:* ${app.salary}` : '',
    deadline,
    `*Fit Score:* ${app.fit_score ?? 'N/A'}/100`,
    app.gaps && app.gaps.length > 0 ? `*Identified Gaps:* ${app.gaps.join(', ')}` : '',
    '',
    // The domain is shown on its own so a lookalike link is easy to spot before clicking.
    `🔗 *Apply at:* \`${app.apply_link_domain ?? 'unknown domain'}\``,
    app.apply_link ?? '',
    `🐦 *Original Post:* ${app.post_url}`,
    '',
    `📝 *Suggested Cover Note:*`,
    '```',
    app.cover_note || 'I am excited to submit my application for this role.',
    '```',
    '',
    `_Apply at the link above, then mark it submitted:_`,
    `\`/done ${app.id}\``,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** The resume goes as its own document: a card is usually longer than Telegram's 1024-character caption limit. */
async function sendResume(app: LinkApplication): Promise<void> {
  if (!app.resume_blob_url) return;
  try {
    const res = await fetch(app.resume_blob_url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Resume download returned HTTP ${res.status}.`);
    const company = (app.company ?? 'Application').replace(/[^A-Za-z0-9]+/g, '_');
    await sendTelegramDocument(
      app.telegram_chat_id,
      Buffer.from(await res.arrayBuffer()),
      `${company}_Resume.pdf`,
      `Resume for ${app.role ?? 'this role'}`
    );
  } catch (err) {
    console.error(`Could not attach the resume for link application ${app.id}:`, err);
    await sendTelegramMessage(app.telegram_chat_id, `⚠️ The resume for \`/done ${app.id}\` could not be attached.`);
  }
}

/** Lists the user's waiting link applications, soonest deadline first. */
export async function waitingLinkApplications(
  userId: string
): Promise<Array<{ id: string; role: string | null; company: string | null; apply_link_domain: string | null; deadline: string | null }>> {
  return (await sql`
    select a.id, j.role, j.company, j.apply_link_domain, j.deadline::text as deadline
    from applications a
    join jobs j on j.id = a.job_id
    where a.user_id = ${userId} and a.status = 'link_ready'
    order by j.deadline asc nulls last, a.created_at
  `) as Array<{ id: string; role: string | null; company: string | null; apply_link_domain: string | null; deadline: string | null }>;
}

/** Marks one of the user's own waiting link applications as applied. Returns false if there is none with that id. */
export async function markLinkApplied(userId: string, applicationId: string): Promise<boolean> {
  const updated = await sql`
    update applications
    set status = 'applied_manually', applied_at = now(), updated_at = now()
    where id = ${applicationId} and user_id = ${userId} and status = 'link_ready'
    returning id
  `;
  if (updated.length > 0) {
    await logEvent(userId, 'link_application_done', {}, null, applicationId);
  }
  return updated.length > 0;
}
