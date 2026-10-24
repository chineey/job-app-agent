import crypto from 'crypto';
import { sql, logEvent, assertUserScope } from './db';
import { getUserById, getUserSettings, autoPauseUser } from './users';
import { getGmailClientForUser, buildMimeMessage, sendGmailRawMessage, searchSentMailByMessageId } from './gmail';
import { sendTelegramMessage } from './telegram';

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
  reserved_at: string;
  started_at: string | null;
  finished_at: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  error: string | null;
  reconcile_checks: number;
  last_reconcile_at: string | null;
  resolved_by: string | null;
}

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

/**
 * Authorizes a send attempt by serializing on send_state row lock.
 * Returns the committed send_attempt ID or reasons why authorization failed.
 */
export async function authorizeSend(
  userId: string,
  applicationId: string,
  claimToken: string
): Promise<{
  authorized: boolean;
  attemptId?: string;
  isDryRun?: boolean;
  reason?: string;
}> {
  assertUserScope(userId);

  // 1. Check Global Pause
  const globalPausedRow = (await sql`
    select value from global_settings where key = 'global_paused' limit 1;
  `) as { value: string }[];
  if (globalPausedRow.length > 0 && globalPausedRow[0].value === 'true') {
    return { authorized: false, reason: 'System is globally paused.' };
  }

  // 2. Lock send_state row for this user (Serialization Point)
  await sql`
    insert into send_state (user_id) values (${userId}) on conflict (user_id) do nothing;
  `;
  const sendStateRows = (await sql`
    select * from send_state where user_id = ${userId} for update;
  `) as Array<{ user_id: string; active_attempt_id: string | null; next_send_at: string }>;

  const sendState = sendStateRows[0];

  // 3. Check User and Settings
  const user = await getUserById(userId);
  const settings = await getUserSettings(userId);
  if (!user || user.status !== 'active' || user.gmail_status !== 'connected' || !settings || settings.paused) {
    return { authorized: false, reason: 'User not active, paused, or Gmail not connected.' };
  }

  // 4. Check Spacing and Send Window
  if (new Date() < new Date(sendState.next_send_at)) {
    return { authorized: false, reason: 'Minimum send spacing interval not yet reached.' };
  }
  if (!isWithinSendWindow(settings.timezone, settings.send_window_start, settings.send_window_end)) {
    return { authorized: false, reason: 'Current time is outside candidate send window.' };
  }

  // 5. Account state: Ensure no attempt is currently reserved, sending, or send_unknown
  const activeAttempts = (await sql`
    select id, state from send_attempts
    where user_id = ${userId} and state in ('reserved', 'sending', 'send_unknown')
    limit 1;
  `) as Array<{ id: string; state: string }>;

  if (activeAttempts.length > 0) {
    return {
      authorized: false,
      reason: `Account already has an active or uncertain attempt (${activeAttempts[0].state}).`,
    };
  }

  // 6. Check Application Eligibility
  const appRows = (await sql`
    select * from applications
    where id = ${applicationId} and user_id = ${userId} and claim_token = ${claimToken}
    limit 1;
  `) as Array<{
    id: string;
    contact_email: string;
    email_subject: string;
    email_body: string;
    resume_blob_url: string;
    status: string;
    attempts: number;
    fit_score: number;
    gaps: string[];
  }>;

  if (appRows.length === 0) {
    return { authorized: false, reason: 'Application not found or claim token expired.' };
  }

  const app = appRows[0];
  if (app.status !== 'verified' && app.status !== 'ready') {
    return { authorized: false, reason: `Application status is '${app.status}', expected 'verified' or 'ready'.` };
  }
  if (app.attempts >= 3) {
    return { authorized: false, reason: 'Maximum application send attempts exceeded.' };
  }

  const recipient = app.contact_email;
  const recipientDomain = extractDomain(recipient);

  // 7. Check Daily Cap in Candidate's Timezone
  // Count includes reserved, sending, sent, send_unknown today
  const todayAttemptsRows = (await sql`
    select count(*)::int as count
    from send_attempts
    where user_id = ${userId}
      and state in ('reserved', 'sending', 'sent', 'send_unknown')
      and (reserved_at at time zone ${settings.timezone})::date = (now() at time zone ${settings.timezone})::date;
  `) as { count: number }[];

  if (todayAttemptsRows[0].count >= settings.current_cap) {
    return { authorized: false, reason: `Daily send cap reached (${settings.current_cap}).` };
  }

  // 8. Check Recipient Domain Cap (at most 2 attempts per domain today)
  const domainAttemptsRows = (await sql`
    select count(*)::int as count
    from send_attempts
    where user_id = ${userId}
      and recipient_domain = ${recipientDomain}
      and state in ('reserved', 'sending', 'sent', 'send_unknown')
      and (reserved_at at time zone ${settings.timezone})::date = (now() at time zone ${settings.timezone})::date;
  `) as { count: number }[];

  if (domainAttemptsRows[0].count >= 2) {
    return { authorized: false, reason: `Daily domain limit reached for ${recipientDomain} (max 2).` };
  }

  // 9. Dry-Run Handling
  if (settings.dry_run) {
    // Increment dry run draft count
    await sql`
      update user_settings
      set dry_run_drafts_shown = dry_run_drafts_shown + 1
      where user_id = ${userId};
    `;

    // Dispatch Telegram DRY RUN preview card
    if (user.telegram_chat_id) {
      await sendTelegramMessage(
        user.telegram_chat_id,
        `📋 *[DRY RUN PREVIEW - NOT SENT]*\n\n` +
          `*To:* \`${recipient}\`\n` +
          `*Subject:* ${app.email_subject || 'Application'}\n` +
          `*Fit Score:* ${app.fit_score ?? 'N/A'}/100\n` +
          `*Resume Mode:* \`${settings.resume_mode}\`\n\n` +
          `*Body Preview:*\n${app.email_body || '(No body content)'}\n\n` +
          `_Dry run is ON. Nothing was sent from your Gmail._`
      );
    }

    return { authorized: false, isDryRun: true, reason: 'Dry run mode active.' };
  }

  // 10. Commit Reservation
  const rfcMessageId = generateRfcMessageId(recipientDomain || 'jobappagent.internal');
  const bodyHash = sha256(app.email_body || '');
  const resumeHash = sha256(app.resume_blob_url || '');

  const attemptRows = (await sql`
    insert into send_attempts (
      user_id, application_id, state, recipient, recipient_domain,
      rfc_message_id, subject, body_hash, resume_blob_url, resume_sha256,
      reserved_at
    ) values (
      ${userId}, ${app.id}, 'reserved', ${recipient}, ${recipientDomain},
      ${rfcMessageId}, ${app.email_subject || 'Job Application'}, ${bodyHash},
      ${app.resume_blob_url || ''}, ${resumeHash}, now()
    )
    returning id;
  `) as Array<{ id: string }>;

  const attemptId = attemptRows[0].id;

  // Update application and send_state
  await sql`
    update applications
    set status = 'sending', updated_at = now()
    where id = ${app.id};
  `;

  await sql`
    update send_state
    set active_attempt_id = ${attemptId}, updated_at = now()
    where user_id = ${userId};
  `;

  await logEvent(userId, 'send_attempt_reserved', { attemptId, recipient, rfcMessageId }, null, app.id);
  return { authorized: true, attemptId };
}

/**
 * Executes delivery for an authorized send attempt.
 */
export async function executeSend(
  userId: string,
  attemptId: string
): Promise<{ success: boolean; state: string; error?: string }> {
  assertUserScope(userId);

  // 1. Fetch attempt and transition to 'sending'
  const transitionRes = (await sql`
    update send_attempts
    set state = 'sending', started_at = now()
    where id = ${attemptId} and user_id = ${userId} and state = 'reserved'
    returning *;
  `) as SendAttemptRecord[];

  if (transitionRes.length === 0) {
    return { success: false, state: 'aborted', error: 'Attempt not in reserved state.' };
  }

  const attempt = transitionRes[0];

  // 2. Fetch application and facts for name
  const appRows = (await sql`
    select a.*, u.telegram_chat_id, u.gmail_address
    from applications a
    join users u on a.user_id = u.id
    where a.id = ${attempt.application_id}
    limit 1;
  `) as Array<{
    id: string;
    user_id: string;
    contact_email: string;
    email_subject: string;
    email_body: string;
    resume_blob_url: string;
    fit_score: number;
    gaps: string[];
    telegram_chat_id: number;
    gmail_address: string;
  }>;

  if (appRows.length === 0) {
    return { success: false, state: 'failed', error: 'Application record missing.' };
  }

  const app = appRows[0];

  // 3. Download resume PDF buffer if URL provided
  let pdfAttachment: { filename: string; contentBuffer: Buffer } | undefined;
  if (attempt.resume_blob_url) {
    try {
      const pdfRes = await fetch(attempt.resume_blob_url);
      if (pdfRes.ok) {
        const buffer = Buffer.from(await pdfRes.arrayBuffer());
        pdfAttachment = {
          filename: 'Resume.pdf',
          contentBuffer: buffer,
        };
      }
    } catch (err) {
      console.warn('Failed to fetch resume blob for attachment:', err);
    }
  }

  // 4. Build MIME message
  const rawMime = buildMimeMessage({
    from: app.gmail_address,
    to: attempt.recipient,
    subject: attempt.subject,
    bodyText: app.email_body || '',
    rfcMessageId: attempt.rfc_message_id,
    pdfAttachment,
  });

  // 5. Contact Gmail API
  try {
    const { gmail } = await getGmailClientForUser(userId);
    const sendResult = await sendGmailRawMessage(gmail, rawMime);

    // Case A: Confirmed Success (HTTP 200)
    const randomSpacingSeconds = Math.floor(Math.random() * (480 - 120 + 1)) + 120; // 2 to 8 mins

    await sql`
      update send_attempts
      set state = 'sent',
          gmail_message_id = ${sendResult.id},
          gmail_thread_id = ${sendResult.threadId},
          finished_at = now()
      where id = ${attemptId};
    `;

    await sql`
      update applications
      set status = 'sent',
          gmail_message_id = ${sendResult.id},
          gmail_thread_id = ${sendResult.threadId},
          applied_at = now(),
          follow_up_at = now() + interval '7 days',
          updated_at = now()
      where id = ${app.id};
    `;

    await sql`
      update send_state
      set active_attempt_id = null,
          next_send_at = now() + (${randomSpacingSeconds} * interval '1 second'),
          updated_at = now()
      where user_id = ${userId};
    `;

    await logEvent(userId, 'send_attempt_success', { attemptId, messageId: sendResult.id }, null, app.id);

    // Send Telegram Live Card
    if (app.telegram_chat_id) {
      await sendTelegramMessage(
        app.telegram_chat_id,
        `🚀 *Application Sent!*\n\n` +
          `*To:* \`${attempt.recipient}\`\n` +
          `*Subject:* ${attempt.subject}\n` +
          `*Fit Score:* ${app.fit_score ?? 'N/A'}/100\n` +
          `*Message ID:* \`${sendResult.id}\`\n\n` +
          `*Email Body:*\n${app.email_body}\n\n` +
          `_Next send spaced by ~${Math.round(randomSpacingSeconds / 60)} minutes._`
      );
    }

    return { success: true, state: 'sent' };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isConfirmed4xx = errorMsg.includes('400') || errorMsg.includes('404') || errorMsg.includes('invalid_grant');

    if (isConfirmed4xx) {
      // Case B: Confirmed Failure
      await sql`
        update send_attempts
        set state = 'failed', error = ${errorMsg}, finished_at = now()
        where id = ${attemptId};
      `;

      await sql`
        update applications
        set attempts = attempts + 1,
            status = case when attempts + 1 >= 3 then 'failed' else 'ready' end,
            updated_at = now()
        where id = ${app.id};
      `;

      await sql`
        update send_state
        set active_attempt_id = null, updated_at = now()
        where user_id = ${userId};
      `;

      if (errorMsg.includes('invalid_grant')) {
        await sql`update users set gmail_status = 'error' where id = ${userId};`;
        await autoPauseUser(userId, 'Gmail authentication revoked or invalid');
      }

      await logEvent(userId, 'send_attempt_confirmed_failure', { attemptId, error: errorMsg }, null, app.id);
      return { success: false, state: 'failed', error: errorMsg };
    }

    // Case C: Uncertain Outcome (Network drop, timeout, 5xx)
    await sql`
      update send_attempts
      set state = 'send_unknown', error = ${errorMsg}
      where id = ${attemptId};
    `;

    await sql`
      update applications
      set status = 'send_unknown', updated_at = now()
      where id = ${app.id};
    `;

    await logEvent(userId, 'send_attempt_uncertain', { attemptId, error: errorMsg }, null, app.id);
    return { success: false, state: 'send_unknown', error: errorMsg };
  }
}

/**
 * Reconciles uncertain send attempts across all users using exact Message-ID lookup in Sent folder.
 */
export async function reconcileUncertainSends(): Promise<{
  checked: number;
  reconciled: number;
  inconclusive: number;
}> {
  // Query attempts in 'sending' for > 2 mins or in 'send_unknown'
  const candidateAttempts = (await sql`
    select a.*, u.telegram_chat_id
    from send_attempts a
    join users u on a.user_id = u.id
    where (a.state = 'send_unknown')
       or (a.state = 'sending' and a.started_at < now() - interval '2 minutes')
    order by a.reserved_at asc;
  `) as Array<SendAttemptRecord & { telegram_chat_id: number }>;

  let reconciled = 0;
  let inconclusive = 0;

  for (const attempt of candidateAttempts) {
    try {
      const { gmail } = await getGmailClientForUser(attempt.user_id);
      const sentMsg = await searchSentMailByMessageId(gmail, attempt.rfc_message_id);

      if (sentMsg) {
        // Message was actually sent!
        await sql`
          update send_attempts
          set state = 'sent',
              gmail_message_id = ${sentMsg.id},
              gmail_thread_id = ${sentMsg.threadId},
              finished_at = now(),
              resolved_by = 'auto'
          where id = ${attempt.id};
        `;

        await sql`
          update applications
          set status = 'sent',
              gmail_message_id = ${sentMsg.id},
              gmail_thread_id = ${sentMsg.threadId},
              applied_at = ${new Date(parseInt(sentMsg.internalDate, 10)).toISOString()},
              follow_up_at = now() + interval '7 days',
              updated_at = now()
          where id = ${attempt.application_id};
        `;

        await sql`
          update send_state
          set active_attempt_id = null, updated_at = now()
          where user_id = ${attempt.user_id};
        `;

        if (attempt.telegram_chat_id) {
          await sendTelegramMessage(
            attempt.telegram_chat_id,
            `✅ *Delivery Reconciled!*\n\nApplication to \`${attempt.recipient}\` was confirmed sent via Sent mail verification.`
          );
        }

        reconciled++;
      } else {
        // Not found yet. Check how long it has been
        const ageMinutes = (Date.now() - new Date(attempt.reserved_at).getTime()) / (1000 * 60);

        if (ageMinutes >= 30 || attempt.reconcile_checks >= 15) {
          // Inconclusive! Prompt candidate for manual settlement
          inconclusive++;
          if (attempt.telegram_chat_id && attempt.reconcile_checks % 5 === 0) {
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

        await sql`
          update send_attempts
          set state = 'send_unknown',
              reconcile_checks = reconcile_checks + 1,
              last_reconcile_at = now()
          where id = ${attempt.id};
        `;
      }
    } catch (err) {
      console.error(`Reconciliation error on attempt ${attempt.id}:`, err);
    }
  }

  return { checked: candidateAttempts.length, reconciled, inconclusive };
}

/**
 * Manually resolves an uncertain send attempt.
 */
export async function resolveSendAttempt(
  attemptId: string,
  action: 'sent' | 'notsent',
  resolvedBy: string
): Promise<{ success: boolean; message: string }> {
  const rows = (await sql`
    select * from send_attempts where id = ${attemptId} limit 1;
  `) as SendAttemptRecord[];

  if (rows.length === 0) {
    return { success: false, message: 'Send attempt not found.' };
  }

  const attempt = rows[0];

  if (action === 'sent') {
    await sql`
      update send_attempts
      set state = 'sent', resolved_by = ${resolvedBy}, finished_at = now()
      where id = ${attemptId};
    `;

    await sql`
      update applications
      set status = 'sent', applied_at = now(), follow_up_at = now() + interval '7 days'
      where id = ${attempt.application_id};
    `;

    await sql`
      update send_state
      set active_attempt_id = null, updated_at = now()
      where user_id = ${attempt.user_id};
    `;

    return { success: true, message: `Attempt ${attemptId} marked as sent.` };
  } else {
    // notsent: release slot and reset application to ready
    await sql`
      update send_attempts
      set state = 'released', resolved_by = ${resolvedBy}, finished_at = now()
      where id = ${attemptId};
    `;

    await sql`
      update applications
      set status = 'ready', updated_at = now()
      where id = ${attempt.application_id};
    `;

    await sql`
      update send_state
      set active_attempt_id = null, updated_at = now()
      where user_id = ${attempt.user_id};
    `;

    return { success: true, message: `Attempt ${attemptId} released. Application reset to ready.` };
  }
}
