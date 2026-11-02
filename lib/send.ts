import crypto from 'crypto';
import type { gmail_v1 } from 'googleapis';
import { sql, withTransaction, logEvent, assertUserScope } from './db';
import { autoPause, pauseAfterConsecutiveFailures, pauseForLostGmailAccess, sendCap } from './ramp';
import {
  getGmailClientForUser,
  buildMimeMessage,
  sendGmailRawMessage,
  searchSentMailByMessageId,
  httpStatusOf,
} from './gmail';
import { sendTelegramMessage } from './telegram';
import { claimApplications } from './claims';

// See docs/send-safety.md for the invariants this module maintains and how they are tested.

export interface SendAttemptRecord {
  id: string;
  user_id: string;
  application_id: string;
  state: 'reserved' | 'sending' | 'sent' | 'failed' | 'send_unknown' | 'released';
  recipient: string;
  recipient_domain: string;
  rfc_message_id: string;
  subject: string;
  body_hash: string;
  resume_blob_url: string;
  resume_sha256: string;
  reserved_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  error: string | null;
  reconcile_checks: number;
  last_reconcile_at: Date | null;
  resolved_by: string | null;
}

export type AuthorizeSendResult =
  | { outcome: 'reserved'; attemptId: string }
  | { outcome: 'dry_run' }
  | { outcome: 'skipped'; reason: string };

export type SendOutcome = 'sent' | 'failed' | 'released' | 'send_unknown' | 'aborted';

const DOMAIN_DAILY_LIMIT = 2;
const MAX_CONFIRMED_FAILURES = 3;
const MIN_SPACING_SECONDS = 120;
const MAX_SPACING_SECONDS = 480;

/**
 * Extracts recipient domain from an email address.
 */
export function extractDomain(email: string): string {
  const parts = email.split('@');
  return parts.length > 1 ? parts[1].toLowerCase().trim() : '';
}

/**
 * Helper to compute SHA-256 hash.
 */
export function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Generates an RFC 2822 compliant Message-ID.
 */
export function generateRfcMessageId(domain: string = 'jobappagent.internal'): string {
  const random = crypto.randomUUID();
  const timestamp = Date.now();
  return `<${timestamp}.${random}@${domain}>`;
}

/**
 * Checks whether current time in candidate's timezone falls within send window.
 */
export function isWithinSendWindow(timezone: string, windowStart: number, windowEnd: number): boolean {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: 'numeric',
      hour12: false,
    });
    const currentHour = parseInt(formatter.format(new Date()), 10);
    return currentHour >= windowStart && currentHour < windowEnd;
  } catch {
    // Default fallback to UTC
    const utcHour = new Date().getUTCHours();
    return utcHour >= windowStart && utcHour < windowEnd;
  }
}

function randomSpacingSeconds(): number {
  return Math.floor(Math.random() * (MAX_SPACING_SECONDS - MIN_SPACING_SECONDS + 1)) + MIN_SPACING_SECONDS;
}

interface DryRunPreview {
  chatId: number;
  recipient: string;
  subject: string;
  fitScore: number | null;
  resumeMode: string;
  body: string;
}

type AuthorizationDecision =
  | { outcome: 'reserved'; attemptId: string; recipient: string; rfcMessageId: string }
  | { outcome: 'dry_run'; preview: DryRunPreview }
  | { outcome: 'skipped'; reason: string };

/**
 * Decides whether this application may be sent now and, if so, commits a durable reservation.
 * Every check and the reservation happen in one transaction that holds this account's
 * send_state row lock, so two workers can never both take the last slot.
 */
export async function authorizeSend(
  userId: string,
  applicationId: string,
  claimToken: string
): Promise<AuthorizeSendResult> {
  assertUserScope(userId);

  const decision = await withTransaction(async (tx): Promise<AuthorizationDecision> => {
    await tx`insert into send_state (user_id) values (${userId}) on conflict (user_id) do nothing`;
    const [sendState] = (await tx`
      select next_send_at > now() as too_soon from send_state where user_id = ${userId} for update
    `) as Array<{ too_soon: boolean }>;

    const [globalPause] = (await tx`
      select value from global_settings where key = 'global_paused'
    `) as Array<{ value: string }>;
    if (globalPause?.value === 'true') {
      return { outcome: 'skipped', reason: 'System is globally paused.' };
    }

    const [account] = (await tx`
      select u.status, u.gmail_status, u.gmail_address, u.telegram_chat_id,
             s.paused, s.dry_run, s.timezone, s.send_window_start, s.send_window_end,
             s.ramp_stage, s.current_cap, s.max_cap, s.resume_mode
      from users u
      join user_settings s on s.user_id = u.id
      where u.id = ${userId}
    `) as Array<{
      status: string;
      gmail_status: string;
      gmail_address: string | null;
      telegram_chat_id: number;
      paused: boolean;
      dry_run: boolean;
      timezone: string;
      send_window_start: number;
      send_window_end: number;
      ramp_stage: number;
      current_cap: number;
      max_cap: number;
      resume_mode: string;
    }>;
    if (!account || account.status !== 'active' || account.gmail_status !== 'connected' || account.paused) {
      return { outcome: 'skipped', reason: 'User not active, paused, or Gmail not connected.' };
    }

    // Filtering by this worker's claim_token means a worker whose lease was taken over finds no row.
    const [app] = (await tx`
      select id, contact_email, email_subject, email_body, resume_blob_url, status, attempts, fit_score
      from applications
      where id = ${applicationId} and user_id = ${userId} and claim_token = ${claimToken}
      for update
    `) as Array<{
      id: string;
      contact_email: string | null;
      email_subject: string | null;
      email_body: string | null;
      resume_blob_url: string | null;
      status: string;
      attempts: number;
      fit_score: number | null;
    }>;
    if (!app) {
      return { outcome: 'skipped', reason: 'Application not found or claim token expired.' };
    }
    if (app.status !== 'verified' && app.status !== 'ready') {
      return { outcome: 'skipped', reason: `Application status is '${app.status}', expected 'verified' or 'ready'.` };
    }
    if (app.attempts >= MAX_CONFIRMED_FAILURES) {
      return { outcome: 'skipped', reason: 'Maximum application send attempts exceeded.' };
    }
    if (!app.contact_email) {
      return { outcome: 'skipped', reason: 'Application has no recipient.' };
    }

    // One active or uncertain attempt per account. An uncertain send blocks the account until settled.
    const [liveAttempt] = (await tx`
      select state from send_attempts
      where user_id = ${userId} and state in ('reserved', 'sending', 'send_unknown')
      limit 1
    `) as Array<{ state: string }>;
    if (liveAttempt) {
      return { outcome: 'skipped', reason: `Account already has an active or uncertain attempt (${liveAttempt.state}).` };
    }

    if (sendState.too_soon) {
      return { outcome: 'skipped', reason: 'Minimum send spacing interval not yet reached.' };
    }
    if (!isWithinSendWindow(account.timezone, account.send_window_start, account.send_window_end)) {
      return { outcome: 'skipped', reason: 'Current time is outside candidate send window.' };
    }

    const recipient = app.contact_email;
    const recipientDomain = extractDomain(recipient);

    if (account.dry_run) {
      // Each application is previewed once, so the 5-preview gate counts distinct drafts.
      const firstPreview = await tx`
        update applications set dry_run_previewed_at = now()
        where id = ${app.id} and dry_run_previewed_at is null
        returning id
      `;
      if (firstPreview.length === 0) {
        return { outcome: 'skipped', reason: 'Already previewed in dry run.' };
      }
      await tx`update user_settings set dry_run_drafts_shown = dry_run_drafts_shown + 1 where user_id = ${userId}`;
      return {
        outcome: 'dry_run',
        preview: {
          chatId: account.telegram_chat_id,
          recipient,
          subject: app.email_subject || 'Application',
          fitScore: app.fit_score,
          resumeMode: account.resume_mode,
          body: app.email_body || '(No body content)',
        },
      };
    }

    // Today in the candidate's timezone. Failed and released attempts do not use a slot.
    const [today] = (await tx`
      select (count(*))::int as total,
             (count(*) filter (where recipient_domain = ${recipientDomain}))::int as to_domain
      from send_attempts
      where user_id = ${userId}
        and state in ('reserved', 'sending', 'sent', 'send_unknown')
        and (reserved_at at time zone ${account.timezone})::date = (now() at time zone ${account.timezone})::date
    `) as Array<{ total: number; to_domain: number }>;
    const cap = sendCap(account);
    if (today.total >= cap) {
      return { outcome: 'skipped', reason: `Daily send cap reached (${cap}).` };
    }
    if (today.to_domain >= DOMAIN_DAILY_LIMIT) {
      return { outcome: 'skipped', reason: `Daily domain limit reached for ${recipientDomain} (max ${DOMAIN_DAILY_LIMIT}).` };
    }

    const rfcMessageId = generateRfcMessageId(extractDomain(account.gmail_address ?? '') || undefined);
    const [attempt] = (await tx`
      insert into send_attempts (
        user_id, application_id, state, recipient, recipient_domain,
        rfc_message_id, subject, body_hash, resume_blob_url, resume_sha256
      ) values (
        ${userId}, ${app.id}, 'reserved', ${recipient}, ${recipientDomain},
        ${rfcMessageId}, ${app.email_subject || 'Job Application'}, ${sha256(app.email_body || '')},
        ${app.resume_blob_url || ''}, ${sha256(app.resume_blob_url || '')}
      )
      returning id
    `) as Array<{ id: string }>;

    await tx`update applications set status = 'sending', updated_at = now() where id = ${app.id}`;
    await tx`update send_state set active_attempt_id = ${attempt.id}, updated_at = now() where user_id = ${userId}`;

    return { outcome: 'reserved', attemptId: attempt.id, recipient, rfcMessageId };
  });

  if (decision.outcome === 'dry_run') {
    const { preview } = decision;
    await sendTelegramMessage(
      preview.chatId,
      `📋 *[DRY RUN PREVIEW - NOT SENT]*\n\n` +
        `*To:* \`${preview.recipient}\`\n` +
        `*Subject:* ${preview.subject}\n` +
        `*Fit Score:* ${preview.fitScore ?? 'N/A'}/100\n` +
        `*Resume Mode:* \`${preview.resumeMode}\`\n\n` +
        `*Body Preview:*\n${preview.body}\n\n` +
        `_Dry run is ON. Nothing was sent from your Gmail._`
    );
    return { outcome: 'dry_run' };
  }

  if (decision.outcome === 'reserved') {
    await logEvent(
      userId,
      'send_attempt_reserved',
      { attemptId: decision.attemptId, recipient: decision.recipient, rfcMessageId: decision.rfcMessageId },
      null,
      applicationId
    );
    return { outcome: 'reserved', attemptId: decision.attemptId };
  }

  return decision;
}

interface AttemptForSend {
  id: string;
  user_id: string;
  application_id: string;
  recipient: string;
  subject: string;
  rfc_message_id: string;
  resume_blob_url: string;
  email_body: string | null;
  fit_score: number | null;
  gmail_address: string | null;
  telegram_chat_id: number;
}

/**
 * Delivers a reserved attempt. Everything that can fail without Gmail seeing the message
 * (token refresh, resume download) happens before the attempt is marked 'sending'.
 */
export async function executeSend(userId: string, attemptId: string): Promise<SendOutcome> {
  assertUserScope(userId);

  const [attempt] = (await sql`
    select a.id, a.user_id, a.application_id, a.recipient, a.subject, a.rfc_message_id, a.resume_blob_url,
           app.email_body, app.fit_score, u.gmail_address, u.telegram_chat_id
    from send_attempts a
    join applications app on app.id = a.application_id
    join users u on u.id = a.user_id
    where a.id = ${attemptId} and a.user_id = ${userId} and a.state = 'reserved'
  `) as AttemptForSend[];
  if (!attempt) {
    return 'aborted';
  }

  let gmail: gmail_v1.Gmail;
  try {
    const client = await getGmailClientForUser(userId);
    await client.auth.getAccessToken();
    gmail = client.gmail;
  } catch (err) {
    const status = httpStatusOf(err);
    if (status !== null && status >= 400 && status < 500) {
      await recordConfirmedFailure(attempt, `Gmail authorization rejected (${status})`, 'reserved');
      await handleGmailAuthLoss(attempt);
      return 'failed';
    }
    // Gmail was never contacted, so the slot can be released without counting a failure.
    await releaseUnstartedAttempt(attempt, `Could not obtain Gmail access token: ${errorMessage(err)}`);
    return 'released';
  }

  let resume: Buffer;
  try {
    if (!attempt.resume_blob_url) {
      throw new Error('Application has no resume URL.');
    }
    const res = await fetch(attempt.resume_blob_url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Resume download returned HTTP ${res.status}.`);
    }
    resume = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // Never send an application without its resume.
    await recordConfirmedFailure(attempt, `Resume unavailable: ${errorMessage(err)}`, 'reserved');
    return 'failed';
  }

  const rawMime = buildMimeMessage({
    from: attempt.gmail_address ?? '',
    to: attempt.recipient,
    subject: attempt.subject,
    bodyText: attempt.email_body || '',
    rfcMessageId: attempt.rfc_message_id,
    pdfAttachment: { filename: 'Resume.pdf', contentBuffer: resume },
  });

  const started = await sql`
    update send_attempts
    set state = 'sending', started_at = now()
    where id = ${attempt.id} and user_id = ${userId} and state = 'reserved'
    returning id
  `;
  if (started.length === 0) {
    return 'aborted';
  }

  let sendResult: { id: string; threadId: string };
  try {
    sendResult = await sendGmailRawMessage(gmail, rawMime);
  } catch (err) {
    const status = httpStatusOf(err);
    if (status !== null && status >= 400 && status < 500) {
      await recordConfirmedFailure(attempt, `Gmail rejected the message (${status}): ${errorMessage(err)}`, 'sending');
      if (status === 401) {
        await handleGmailAuthLoss(attempt);
      } else if (status === 403) {
        await autoPause(userId, 'Gmail refused to send (403). This usually means a sending limit or a problem with the account.');
      }
      return 'failed';
    }
    // No response or a 5xx: Gmail may have accepted the message. Reconciliation decides.
    await recordUncertain(attempt, errorMessage(err));
    return 'send_unknown';
  }

  const recorded = await recordSent(attempt, {
    gmailMessageId: sendResult.id,
    gmailThreadId: sendResult.threadId,
    sentAt: new Date(),
    fromStates: ['sending', 'send_unknown'],
    resolvedBy: null,
  });
  if (!recorded) {
    await reportOutcomeConflict(attempt, 'sent');
    return 'sent';
  }

  await logEvent(userId, 'send_attempt_success', { attemptId, messageId: sendResult.id }, null, attempt.application_id);
  await sendTelegramMessage(
    attempt.telegram_chat_id,
    `🚀 *Application Sent!*\n\n` +
      `*To:* \`${attempt.recipient}\`\n` +
      `*Subject:* ${attempt.subject}\n` +
      `*Fit Score:* ${attempt.fit_score ?? 'N/A'}/100\n` +
      `*Message ID:* \`${sendResult.id}\`\n\n` +
      `*Email Body:*\n${attempt.email_body}`
  );
  return 'sent';
}

type AttemptRef = Pick<AttemptForSend, 'id' | 'user_id' | 'application_id' | 'recipient' | 'telegram_chat_id'>;

/**
 * Marks an attempt and its application sent. Returns false, and changes nothing, if the attempt
 * is no longer in one of `fromStates` (someone else already settled it).
 */
async function recordSent(
  attempt: AttemptRef,
  outcome: {
    gmailMessageId: string | null;
    gmailThreadId: string | null;
    sentAt: Date;
    fromStates: SendAttemptRecord['state'][];
    resolvedBy: string | null;
  }
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const updated = await tx`
      update send_attempts
      set state = 'sent',
          gmail_message_id = ${outcome.gmailMessageId},
          gmail_thread_id = ${outcome.gmailThreadId},
          finished_at = now(),
          resolved_by = ${outcome.resolvedBy}
      where id = ${attempt.id} and state = any(${outcome.fromStates})
      returning id
    `;
    if (updated.length === 0) {
      return false;
    }

    await tx`
      update applications
      set status = 'sent',
          gmail_message_id = ${outcome.gmailMessageId},
          gmail_thread_id = ${outcome.gmailThreadId},
          applied_at = ${outcome.sentAt},
          follow_up_at = ${outcome.sentAt}::timestamptz + interval '7 days',
          updated_at = now()
      where id = ${attempt.application_id}
    `;
    await tx`
      update send_state
      set active_attempt_id = null,
          next_send_at = greatest(next_send_at, now() + ${randomSpacingSeconds()}::double precision * interval '1 second'),
          updated_at = now()
      where user_id = ${attempt.user_id}
    `;
    return true;
  });
}

/**
 * Records a definite non-delivery: Gmail rejected the message, or it was never contacted.
 * The application returns to 'ready' until it has failed MAX_CONFIRMED_FAILURES times.
 */
async function recordConfirmedFailure(
  attempt: AttemptRef,
  error: string,
  fromState: 'reserved' | 'sending'
): Promise<void> {
  const recorded = await withTransaction(async (tx) => {
    const updated = await tx`
      update send_attempts
      set state = 'failed', error = ${error}, finished_at = now()
      where id = ${attempt.id} and state = ${fromState}
      returning id
    `;
    if (updated.length === 0) {
      return false;
    }

    await tx`
      update applications
      set attempts = attempts + 1,
          status = case when attempts + 1 >= ${MAX_CONFIRMED_FAILURES} then 'failed' else 'ready' end,
          updated_at = now()
      where id = ${attempt.application_id} and status = 'sending'
    `;
    await tx`
      update send_state set active_attempt_id = null, updated_at = now()
      where user_id = ${attempt.user_id}
    `;
    return true;
  });

  if (!recorded) {
    await reportOutcomeConflict(attempt, 'failed');
    return;
  }
  await logEvent(attempt.user_id, 'send_attempt_confirmed_failure', { attemptId: attempt.id, error }, null, attempt.application_id);
  await pauseAfterConsecutiveFailures(attempt.user_id);
}

/** Frees a reserved slot that never reached Gmail, without counting it as a failure. */
async function releaseUnstartedAttempt(attempt: AttemptRef, reason: string): Promise<void> {
  await withTransaction(async (tx) => {
    const updated = await tx`
      update send_attempts
      set state = 'released', error = ${reason}, finished_at = now()
      where id = ${attempt.id} and state = 'reserved' and started_at is null
      returning id
    `;
    if (updated.length === 0) {
      return;
    }
    await tx`update applications set status = 'ready', updated_at = now() where id = ${attempt.application_id} and status = 'sending'`;
    await tx`update send_state set active_attempt_id = null, updated_at = now() where user_id = ${attempt.user_id}`;
  });
  await logEvent(attempt.user_id, 'send_attempt_released', { attemptId: attempt.id, reason }, null, attempt.application_id);
}

/** Gmail may or may not have the message. The account stays blocked until reconciliation settles it. */
async function recordUncertain(attempt: AttemptRef, error: string): Promise<void> {
  const recorded = await withTransaction(async (tx) => {
    const updated = await tx`
      update send_attempts set state = 'send_unknown', error = ${error}
      where id = ${attempt.id} and state = 'sending'
      returning id
    `;
    if (updated.length === 0) {
      return false;
    }
    await tx`
      update applications set status = 'send_unknown', updated_at = now()
      where id = ${attempt.application_id} and status = 'sending'
    `;
    return true;
  });

  if (!recorded) {
    await reportOutcomeConflict(attempt, 'send_unknown');
    return;
  }
  await logEvent(attempt.user_id, 'send_attempt_uncertain', { attemptId: attempt.id, error }, null, attempt.application_id);
}

async function handleGmailAuthLoss(attempt: AttemptRef): Promise<void> {
  await pauseForLostGmailAccess(attempt.user_id);
}

/**
 * A worker finished after the attempt had already been settled elsewhere (reconciliation or /resolve).
 * Overwriting could hide a real send or make a sent application sendable again, so report instead.
 */
async function reportOutcomeConflict(attempt: AttemptRef, workerOutcome: string): Promise<void> {
  const [current] = (await sql`select state from send_attempts where id = ${attempt.id}`) as Array<{ state: string }>;
  const detail = { attemptId: attempt.id, workerOutcome, recordedState: current?.state ?? null };
  console.error('Send outcome conflict:', detail);
  await logEvent(attempt.user_id, 'send_outcome_conflict', detail, null, attempt.application_id);
  await sendTelegramMessage(
    attempt.telegram_chat_id,
    `⚠️ *Send record conflict*\n\nAn email to \`${attempt.recipient}\` finished as \`${workerOutcome}\`, ` +
      `but it had already been recorded as \`${detail.recordedState}\`. Please check your Gmail Sent folder.`
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Settles attempts whose outcome is unknown by looking for their RFC Message-ID in the sender's Sent mail.
 * Never sends and never releases a slot: only a found message or a user's /resolve settles an attempt.
 */
export async function reconcileUncertainSends(): Promise<{
  checked: number;
  reconciled: number;
  inconclusive: number;
}> {
  const candidateAttempts = (await sql`
    select a.id, a.user_id, a.application_id, a.recipient, a.rfc_message_id,
           a.reserved_at, a.reconcile_checks, u.telegram_chat_id
    from send_attempts a
    join users u on a.user_id = u.id
    where (a.state = 'send_unknown')
       or (a.state = 'sending' and a.started_at < now() - interval '2 minutes')
    order by a.reserved_at asc
  `) as Array<AttemptRef & { rfc_message_id: string; reserved_at: Date; reconcile_checks: number }>;

  let reconciled = 0;
  let inconclusive = 0;

  for (const attempt of candidateAttempts) {
    try {
      const { gmail } = await getGmailClientForUser(attempt.user_id);
      const sentMsg = await searchSentMailByMessageId(gmail, attempt.rfc_message_id);

      if (sentMsg) {
        const recorded = await recordSent(attempt, {
          gmailMessageId: sentMsg.id,
          gmailThreadId: sentMsg.threadId,
          sentAt: new Date(parseInt(sentMsg.internalDate, 10)),
          fromStates: ['sending', 'send_unknown'],
          resolvedBy: 'auto',
        });
        if (recorded) {
          reconciled++;
          await logEvent(attempt.user_id, 'send_attempt_reconciled', { attemptId: attempt.id }, null, attempt.application_id);
          await sendTelegramMessage(
            attempt.telegram_chat_id,
            `✅ *Delivery Reconciled!*\n\nApplication to \`${attempt.recipient}\` was confirmed sent via Sent mail verification.`
          );
        }
        continue;
      }

      await withTransaction(async (tx) => {
        await tx`
          update send_attempts
          set state = 'send_unknown',
              reconcile_checks = reconcile_checks + 1,
              last_reconcile_at = now()
          where id = ${attempt.id} and state in ('sending', 'send_unknown')
        `;
        await tx`
          update applications set status = 'send_unknown', updated_at = now()
          where id = ${attempt.application_id} and status = 'sending'
        `;
      });

      // Gmail search can lag; ask the user only once automatic checks are inconclusive.
      const ageMinutes = (Date.now() - new Date(attempt.reserved_at).getTime()) / (1000 * 60);
      if (ageMinutes >= 30 || attempt.reconcile_checks >= 15) {
        inconclusive++;
        if (attempt.reconcile_checks % 5 === 0) {
          await sendTelegramMessage(
            attempt.telegram_chat_id,
            `⚠️ *Uncertain Send Alert*\n\n` +
              `An email to \`${attempt.recipient}\` has an uncertain delivery outcome.\n` +
              `Attempt ID: \`${attempt.id}\`\n\n` +
              `Please check your Gmail Sent folder and resolve:\n` +
              `• If sent: \`/resolve ${attempt.id} sent\`\n` +
              `• If not sent: \`/resolve ${attempt.id} notsent\``
          );
        }
      }
    } catch (err) {
      console.error(`Reconciliation error on attempt ${attempt.id}:`, err);
    }
  }

  return { checked: candidateAttempts.length, reconciled, inconclusive };
}

/**
 * Lets a user settle one of their own uncertain attempts after checking their Sent folder.
 */
export async function resolveSendAttempt(
  userId: string,
  attemptId: string,
  action: 'sent' | 'notsent',
  resolvedBy: string
): Promise<{ success: boolean; message: string }> {
  assertUserScope(userId);

  const [attempt] = (await sql`
    select a.id, a.user_id, a.application_id, a.recipient, a.state, u.telegram_chat_id
    from send_attempts a
    join users u on u.id = a.user_id
    where a.id = ${attemptId} and a.user_id = ${userId}
  `) as Array<AttemptRef & { state: SendAttemptRecord['state'] }>;
  if (!attempt) {
    return { success: false, message: 'Send attempt not found.' };
  }
  if (attempt.state !== 'send_unknown') {
    return { success: false, message: `Attempt is '${attempt.state}'. Only uncertain sends can be resolved.` };
  }

  if (action === 'sent') {
    const recorded = await recordSent(attempt, {
      gmailMessageId: null,
      gmailThreadId: null,
      sentAt: new Date(),
      fromStates: ['send_unknown'],
      resolvedBy,
    });
    if (!recorded) {
      return { success: false, message: 'Attempt was settled by another process. Run /last to check.' };
    }
    await logEvent(userId, 'send_attempt_resolved', { attemptId, action, resolvedBy }, null, attempt.application_id);
    return { success: true, message: `Attempt ${attemptId} marked as sent.` };
  }

  const released = await withTransaction(async (tx) => {
    const updated = await tx`
      update send_attempts
      set state = 'released', resolved_by = ${resolvedBy}, finished_at = now()
      where id = ${attemptId} and user_id = ${userId} and state = 'send_unknown'
      returning id
    `;
    if (updated.length === 0) {
      return false;
    }
    await tx`
      update applications set status = 'ready', updated_at = now()
      where id = ${attempt.application_id} and status = 'send_unknown'
    `;
    await tx`update send_state set active_attempt_id = null, updated_at = now() where user_id = ${userId}`;
    return true;
  });
  if (!released) {
    return { success: false, message: 'Attempt was settled by another process. Run /last to check.' };
  }
  await logEvent(userId, 'send_attempt_resolved', { attemptId, action, resolvedBy }, null, attempt.application_id);
  return { success: true, message: `Attempt ${attemptId} released. Application reset to ready.` };
}

export interface SendPassResult {
  reconciliation: Awaited<ReturnType<typeof reconcileUncertainSends>>;
  claimed: number;
  dryRuns: number;
  skipped: number;
  errors: number;
  outcomes: Record<SendOutcome, number>;
}

/**
 * One pass of the send pipeline for all users: settle uncertain sends, then try every claimed
 * application under every cap and lock. One application's unexpected error is logged and counted;
 * it does not stop the others.
 */
export async function runSendPass(): Promise<SendPassResult> {
  const reconciliation = await reconcileUncertainSends();

  // Up to 3 applications per user, 15 in total, from each input status.
  const verifiedApps = await claimApplications('verified', 15, 3, 'send_worker');
  const readyApps = await claimApplications('ready', 15, 3, 'send_worker');
  const claimed = [...verifiedApps, ...readyApps];

  const result: SendPassResult = {
    reconciliation,
    claimed: claimed.length,
    dryRuns: 0,
    skipped: 0,
    errors: 0,
    outcomes: { sent: 0, failed: 0, released: 0, send_unknown: 0, aborted: 0 },
  };

  for (const app of claimed) {
    if (!app.claim_token) continue;
    try {
      const authorization = await authorizeSend(app.user_id, app.id, app.claim_token);
      if (authorization.outcome === 'dry_run') {
        result.dryRuns++;
      } else if (authorization.outcome === 'skipped') {
        result.skipped++;
      } else {
        result.outcomes[await executeSend(app.user_id, authorization.attemptId)]++;
      }
    } catch (err) {
      result.errors++;
      console.error(`Send pass error on application ${app.id}:`, err);
    }
  }
  return result;
}
