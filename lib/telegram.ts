import { sql, logEvent } from './db';
import {
  getUserByChatId,
  registerUser,
  canonicalTimeZone,
  agreeToTerms,
  getUserSettings,
  updateUserSettings,
  createInvite,
  listAllUsers,
  setUserSuspension,
  setUserLimits,
  MAX_CAP_CEILING,
  MAX_READS_CEILING,
  deleteUserAccount,
} from './users';
import { resolveSendAttempt, runSendPass } from './send';
import { IMPORT_LIMIT, importPastRecipients, openDrafts, recentSends, skipApplication } from './applications';
import { capCeiling, sendCap, stageCap } from './ramp';
import { markLinkApplied, waitingLinkApplications } from './links';
import { disconnectGmail, type DisconnectResult } from './gmail';
import { validateUploadedPdf, extractResumeText, parseResumeTextToFacts } from './parse-resume';
import { mergeWithActiveFacts, computeFactsDiff } from './facts';
import { MasterFacts } from './schemas';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID, 10) : null;
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
// Hard daily ceiling on X reads (spec: X_MAX_DAILY_READS, default 300); admin overrides stay within it.
const X_MAX_DAILY_READS = parseInt(process.env.X_MAX_DAILY_READS || '300', 10);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// E2E only: point Bot API calls at a fake server. Unset in every real environment.
const TELEGRAM_API_BASE_URL = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org';

/**
 * Sends a text message to a Telegram chat.
 */
export async function sendTelegramMessage(
  chatId: number,
  text: string,
  parseMode: 'Markdown' | 'HTML' = 'Markdown'
): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log(`[Telegram Mock to ${chatId}]:\n${text}`);
    return true;
  }

  const post = (body: Record<string, unknown>) =>
    // Next 14 caches fetch() inside GET route handlers (every cron), POSTs included.
    // A cached reply means the message is silently never sent.
    fetch(`${TELEGRAM_API_BASE_URL}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, ...body }),
    });

  try {
    const res = await post({ parse_mode: parseMode });
    if (res.ok) return true;
    // Untrusted text (a recruiter's snippet, an email body) can break the markup, and Telegram then
    // rejects the whole message with 400. Losing an alert is worse than losing its formatting.
    if (res.status === 400) {
      const plain = await post({});
      if (plain.ok) return true;
      console.error(`Telegram rejected a message to ${chatId} even as plain text (${plain.status}).`);
      return false;
    }
    console.error(`Telegram rejected a message to ${chatId} (${res.status}).`);
    return false;
  } catch (err) {
    console.error(`Failed to send Telegram message to ${chatId}:`, err);
    return false;
  }
}

/**
 * Sends a document (e.g. PDF resume) to a Telegram chat.
 */
export async function sendTelegramDocument(
  chatId: number,
  documentBuffer: Buffer,
  filename: string,
  caption?: string
): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log(`[Telegram Document Mock to ${chatId}]: ${filename} (caption: ${caption})`);
    return true;
  }

  try {
    const formData = new FormData();
    formData.append('chat_id', chatId.toString());
    const blob = new Blob([new Uint8Array(documentBuffer)], { type: 'application/pdf' });
    formData.append('document', blob, filename);
    if (caption) {
      formData.append('caption', caption);
      formData.append('parse_mode', 'Markdown');
    }

    const res = await fetch(`${TELEGRAM_API_BASE_URL}/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      cache: 'no-store',
      body: formData,
    });
    return res.ok;
  } catch (err) {
    console.error(`Failed to send Telegram document to ${chatId}:`, err);
    return false;
  }
}

/** Spec: at most 30 updates per chat per minute. */
const CHAT_UPDATES_PER_MINUTE = 30;

/**
 * Records a Telegram update. 'duplicate' means Telegram redelivered one already handled;
 * 'rate_limited' means the chat sent more than the per-minute limit and is ignored, without a reply.
 */
export async function claimTelegramUpdate(updateId: number, chatId: number): Promise<'new' | 'duplicate' | 'rate_limited'> {
  const rows = await sql`
    insert into telegram_updates (update_id, chat_id) values (${updateId}, ${chatId})
    on conflict (update_id) do nothing
    returning update_id
  `;
  if (rows.length === 0) return 'duplicate';

  const [recent] = (await sql`
    select count(*)::int as count from telegram_updates
    where chat_id = ${chatId} and received_at > now() - interval '1 minute'
  `) as Array<{ count: number }>;
  return recent.count > CHAT_UPDATES_PER_MINUTE ? 'rate_limited' : 'new';
}

/** Telegram redelivers for at most a day, so older update ids are no longer needed. */
export async function pruneTelegramUpdates(): Promise<number> {
  const deleted = await sql`delete from telegram_updates where received_at < now() - interval '1 day' returning update_id`;
  return deleted.length;
}

function disconnectMessage(result: DisconnectResult): string {
  switch (result) {
    case 'revoked':
      return '🔌 Gmail access revoked with Google and disconnected.';
    case 'not_confirmed':
      return (
        '⚠️ Gmail is disconnected here and the token is deleted, but Google did not confirm the revoke. ' +
        'Remove this app at https://myaccount.google.com/permissions to be sure.'
      );
    case 'not_connected':
      return 'Gmail is not connected.';
  }
}

/** Calls one of the app's own cron routes with the configured secret; there is no fallback secret. */
async function runOwnCron(name: 'ingest' | 'process'): Promise<unknown> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET is not configured.');
  const res = await fetch(`${APP_BASE_URL}/api/cron/${name}`, {
    headers: { Authorization: `Bearer ${secret}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`/api/cron/${name} answered ${res.status}.`);
  return res.json();
}

const ADMIN_COMMANDS = new Set(['/invite', '/users', '/suspend', '/unsuspend', '/limits']);

function isAdminCommand(command: string): boolean {
  return command.startsWith('/admin') || ADMIN_COMMANDS.has(command);
}

/**
 * Main Telegram Command Router.
 */
export async function handleTelegramMessage(chatId: number, text: string, username?: string, displayName?: string): Promise<void> {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  // 1. Check if user exists
  let user = await getUserByChatId(chatId);

  // Unknown chats may only register: /start <code>, or /start alone for the admin.
  if (!user) {
    if (command === '/start') {
      let registration;
      try {
        registration = await registerUser(chatId, username || null, displayName || null, args[0] ?? null);
      } catch (err) {
        console.error(`Registration failed for chat ${chatId}:`, err);
        await sendTelegramMessage(chatId, '❌ Registration failed. Please try again later.');
        return;
      }

      if (registration.outcome === 'rejected') {
        await sendTelegramMessage(chatId, `❌ ${registration.reason}`);
      } else if (registration.outcome === 'already_registered') {
        await sendTelegramMessage(chatId, 'This chat is already registered. Type `/agree` to continue.');
      } else {
        await sendTelegramMessage(
          chatId,
          `👋 *Welcome to the Job Application Agent (v3.2)*\n\n` +
            `*Privacy & Security Notice:*\n` +
            `• We parse and securely store your resume facts, tailored drafts, and send records.\n` +
            `• You connect your own Gmail via OAuth to send applications directly from your address.\n` +
            `• We only read bounce messages, threads we created, and sent messages to confirm delivery.\n` +
            `• All refresh tokens are strongly encrypted with AES-256-GCM.\n\n` +
            `To accept the terms and activate your account, reply:\n\`/agree\``
        );
      }
      return;
    }

    // Ignore other commands from unknown chat IDs
    return;
  }

  // 2. Pending users must agree to terms
  if (user.status === 'pending') {
    if (command === '/agree') {
      await agreeToTerms(user.id);
      await sendTelegramMessage(
        chatId,
        `✅ *Account Activated!*\n\n` +
          `Next steps:\n` +
          `1. Send your resume as a PDF or DOCX file to extract your master facts.\n` +
          `2. Connect your Gmail with \`/connect\`.\n` +
          `3. Configure your preferences (e.g. \`/cap 3\`, \`/window 9 17\`).`
      );
      return;
    }
    await sendTelegramMessage(chatId, '⚠️ Please review and accept the Privacy Notice to continue by typing `/agree`.');
    return;
  }

  // 3. Suspended or Deleted users
  if (user.status === 'suspended') {
    await sendTelegramMessage(chatId, '⛔ Your account is currently suspended. Please contact the administrator.');
    return;
  }
  if (user.status === 'deleted') {
    await sendTelegramMessage(chatId, '❌ Your account has been deleted.');
    return;
  }

  const isAdmin = user.role === 'admin' || (ADMIN_CHAT_ID !== null && chatId === ADMIN_CHAT_ID);

  // 4. Admin Command Handling
  if (isAdminCommand(command)) {
    if (!isAdmin) {
      await sendTelegramMessage(chatId, '⛔ That command is only available to the administrator.');
      return;
    }
    await handleAdminCommand(chatId, user.id, command, args);
    return;
  }

  // 5. Standard User Commands
  const settings = await getUserSettings(user.id);
  if (!settings) {
    await sendTelegramMessage(chatId, '❌ Settings not found for your account.');
    return;
  }

  switch (command) {
    case '/status': {
      const countsRows = (await sql`
        select status, count(*)::int as count
        from applications
        where user_id = ${user.id}
        group by status;
      `) as Array<{ status: string; count: number }>;

      const statusMap = countsRows.reduce((acc, r) => ({ ...acc, [r.status]: r.count }), {} as Record<string, number>);

      // Same states the daily cap counts, so "today" matches what authorizeSend enforces.
      const todaySends = (await sql`
        select count(*)::int as count
        from send_attempts
        where user_id = ${user.id} and state in ('reserved', 'sending', 'sent', 'send_unknown')
          and (reserved_at at time zone ${settings.timezone})::date = (now() at time zone ${settings.timezone})::date;
      `) as { count: number }[];

      await sendTelegramMessage(
        chatId,
        `📊 *Your Status Overview*\n\n` +
          `*Gmail:* \`${user.gmail_status}\` (${user.gmail_address || 'not connected'})\n` +
          `*Ramp Stage:* \`${settings.ramp_stage}\` | *Dry Run:* \`${settings.dry_run ? 'ON' : 'OFF'}\`\n` +
          `*Today's Sends:* ${todaySends[0].count} / ${settings.dry_run ? 0 : sendCap(settings)}\n` +
          `*Send Window:* ${settings.send_window_start}:00 - ${settings.send_window_end}:00 (${settings.timezone})\n` +
          `*Resume Mode:* \`${settings.resume_mode}\`\n\n` +
          `*Queue Counts:*\n` +
          `• Verified / Ready: ${(statusMap['verified'] ?? 0) + (statusMap['ready'] ?? 0)}\n` +
          `• Total Sent: ${statusMap['sent'] || 0}\n` +
          `• Replied / Interview: ${statusMap['replied'] || 0}\n` +
          `• Link Route Waiting: ${statusMap['link_ready'] || 0}`
      );
      break;
    }

    case '/connect': {
      const stateToken = crypto.randomUUID();
      await sql`
        insert into oauth_states (state, user_id, expires_at)
        values (${stateToken}, ${user.id}, now() + interval '10 minutes');
      `;
      const connectUrl = `${APP_BASE_URL}/api/oauth/gmail/start?state=${stateToken}`;
      await sendTelegramMessage(
        chatId,
        `🔗 *Connect Your Gmail Account*\n\n` +
          `Click or open this link in your browser to authorize Gmail:\n\n` +
          `${connectUrl}\n\n` +
          `_Link expires in 10 minutes._`
      );
      break;
    }

    case '/disconnect': {
      const result = await disconnectGmail(user.id);
      await sendTelegramMessage(chatId, disconnectMessage(result));
      break;
    }

    case '/pause': {
      await updateUserSettings(user.id, { paused: true });
      await sendTelegramMessage(chatId, '⏸️ Pipeline paused. No emails will be sent.');
      break;
    }

    case '/resume': {
      await updateUserSettings(user.id, { paused: false });
      await sendTelegramMessage(chatId, '▶️ Pipeline resumed.');
      break;
    }

    case '/cap': {
      // The ramp stage sets the ceiling: /cap can lower the daily cap, never skip the ramp.
      const ceiling = capCeiling(settings);
      const capVal = parseInt(args[0], 10);
      if (isNaN(capVal) || capVal < 1) {
        await sendTelegramMessage(chatId, `Usage: \`/cap <number>\` (Current: ${settings.current_cap}, Max now: ${ceiling})`);
        return;
      }
      if (capVal > ceiling) {
        await sendTelegramMessage(
          chatId,
          `❌ At ramp stage ${settings.ramp_stage} your cap can be at most ${ceiling}. It rises as you move up the ramp.`
        );
        return;
      }
      await updateUserSettings(user.id, { current_cap: capVal });
      await sendTelegramMessage(chatId, `✅ Daily cap updated to ${capVal} sends/day.`);
      break;
    }

    case '/dry': {
      const sub = args[0]?.toLowerCase();
      if (sub === 'on') {
        await updateUserSettings(user.id, { dry_run: true });
        await sendTelegramMessage(chatId, '🧪 Dry run enabled. Emails will be simulated.');
      } else if (sub === 'off') {
        // Checked with and without `confirm`: confirming must never skip the prerequisites.
        const activeFacts = (await sql`
          select * from facts_versions where user_id = ${user.id} and status = 'active' limit 1;
        `) as Array<{ id: number; facts: { years_experience?: number } }>;

        const hasGmail = user.gmail_status === 'connected';
        const hasFacts = activeFacts.length > 0;
        const hasYears = (activeFacts[0]?.facts?.years_experience || 0) > 0;
        const has5Drafts = settings.dry_run_drafts_shown >= 5;

        if (!hasGmail || !hasFacts || !hasYears || !has5Drafts) {
          await sendTelegramMessage(
            chatId,
            `⚠️ *Cannot Exit Dry Run Yet*\n\n` +
              `Prerequisites remaining:\n` +
              `• Connected Gmail: ${hasGmail ? '✅' : '❌ (/connect)'}\n` +
              `• Accepted Master Facts: ${hasFacts ? '✅' : '❌ (/accept)'}\n` +
              `• Set Experience: ${hasYears ? '✅' : '❌ (/set years N)'}\n` +
              `• Reviewed >= 5 Drafts: ${has5Drafts ? '✅' : `❌ (${settings.dry_run_drafts_shown}/5 shown)`}`
          );
          return;
        }

        if (args[1]?.toLowerCase() !== 'confirm') {
          await sendTelegramMessage(
            chatId,
            `⚠️ *Ready to go live at Stage 1 (3 sends/day)?*\nConfirm by typing:\n\`/dry off confirm\``
          );
          return;
        }

        await updateUserSettings(user.id, {
          dry_run: false,
          ramp_stage: 1,
          current_cap: Math.min(stageCap(1), settings.max_cap),
          ramp_stage_started_at: new Date().toISOString(),
        });
        await sendTelegramMessage(chatId, '🚀 *Live Mode Active!* You are at Stage 1 (3 sends/day).');
      } else {
        await sendTelegramMessage(chatId, 'Usage: `/dry on` or `/dry off`');
      }
      break;
    }

    case '/window': {
      const h1 = parseInt(args[0], 10);
      const h2 = parseInt(args[1], 10);
      if (isNaN(h1) || isNaN(h2) || h1 < 0 || h1 > 23 || h2 < 0 || h2 > 24 || h1 >= h2) {
        await sendTelegramMessage(chatId, 'Usage: `/window <startHour> <endHour>` (e.g. `/window 9 17`)');
        return;
      }
      await updateUserSettings(user.id, { send_window_start: h1, send_window_end: h2 });
      await sendTelegramMessage(chatId, `✅ Send window set to ${h1}:00 - ${h2}:00 (${settings.timezone}).`);
      break;
    }

    case '/timezone': {
      // An unknown zone would make every send query for this user throw, so only known zones are stored.
      const tz = args[0] ? canonicalTimeZone(args[0]) : null;
      if (!tz) {
        await sendTelegramMessage(chatId, 'Usage: `/timezone <IANA-zone>` (e.g. `/timezone Africa/Lagos`, `America/New_York`)');
        return;
      }
      await updateUserSettings(user.id, { timezone: tz });
      await sendTelegramMessage(chatId, `✅ Timezone updated to \`${tz}\`.`);
      break;
    }

    case '/resolve': {
      const attemptId = args[0];
      const action = args[1]?.toLowerCase();
      if (!attemptId || !UUID_PATTERN.test(attemptId) || (action !== 'sent' && action !== 'notsent')) {
        await sendTelegramMessage(chatId, 'Usage: `/resolve <attempt_id> sent|notsent`');
        return;
      }
      const res = await resolveSendAttempt(user.id, attemptId, action, 'user');
      await sendTelegramMessage(chatId, res.message);
      break;
    }

    case '/done': {
      const appId = args[0];
      if (!appId || !UUID_PATTERN.test(appId)) {
        await sendTelegramMessage(chatId, 'Usage: `/done <application_id>` (see `/links`)');
        return;
      }
      // Only the user's own waiting link application: an email application must never become "applied manually".
      const marked = await markLinkApplied(user.id, appId);
      await sendTelegramMessage(
        chatId,
        marked ? `✅ Application ${appId} marked as applied manually.` : 'No waiting link application with that id. See `/links`.'
      );
      break;
    }

    case '/links': {
      const waiting = await waitingLinkApplications(user.id);
      const lines = waiting.map(
        (app) =>
          `• *${app.role ?? 'Role'}* at ${app.company ?? 'company'} (\`${app.apply_link_domain ?? '?'}\`), ` +
          `deadline ${app.deadline ?? 'none'}\n  \`/done ${app.id}\``
      );
      await sendTelegramMessage(chatId, waiting.length > 0 ? `🔗 *Waiting link applications:*\n\n${lines.join('\n')}` : 'No link applications are waiting.');
      break;
    }

    case '/delete_me': {
      const confirm = args[0]?.toLowerCase() === 'confirm';
      if (!confirm) {
        await sendTelegramMessage(
          chatId,
          `🚨 *Account Deletion Warning*\n\n` +
            `This will permanently purge your account, revoke Gmail credentials, and delete your resume data.\n\n` +
            `To proceed, type:\n\`/delete_me confirm\``
        );
        return;
      }
      // Revoke with Google first: deleting our copy alone would leave the token valid.
      const gmailResult = await disconnectGmail(user.id);
      await deleteUserAccount(user.id);
      await sendTelegramMessage(
        chatId,
        '👋 Your account and associated data have been permanently purged.' +
          (gmailResult === 'not_confirmed' ? `\n\n${disconnectMessage(gmailResult)}` : '')
      );
      break;
    }

    case '/accept': {
      const pendingRows = (await sql`
        select * from facts_versions
        where user_id = ${user.id} and status = 'pending'
        order by created_at desc limit 1;
      `) as Array<{ id: number; facts: MasterFacts }>;

      if (pendingRows.length === 0) {
        await sendTelegramMessage(chatId, '⚠️ No pending facts version to accept. Please upload your resume first.');
        return;
      }

      const pending = pendingRows[0];
      if (!pending.facts.years_experience || pending.facts.years_experience <= 0) {
        await sendTelegramMessage(
          chatId,
          '⚠️ Please specify your professional software engineering experience first:\n`/set years <number>`\nThen type `/accept`.'
        );
        return;
      }

      // Supersede previous active version
      await sql`
        update facts_versions
        set status = 'superseded'
        where user_id = ${user.id} and status = 'active';
      `;

      // Activate pending version
      await sql`
        update facts_versions
        set status = 'active'
        where id = ${pending.id};
      `;

      // Reset unsent applications to queued to regenerate with new facts
      await sql`
        update applications
        set status = 'queued', updated_at = now()
        where user_id = ${user.id} and status in ('drafted', 'verified', 'ready');
      `;

      await logEvent(user.id, 'facts_version_accepted', { versionId: pending.id });
      await sendTelegramMessage(
        chatId,
        `✅ *Master Facts Accepted and Activated!*\n\n` +
          `• Name: ${pending.facts.identity.name}\n` +
          `• Experience: ${pending.facts.years_experience} years\n` +
          `• Relocation: ${pending.facts.open_to_relocation ? 'Yes' : 'No'}\n` +
          `• Strong Skills: ${pending.facts.skills.strong.slice(0, 8).join(', ')}\n\n` +
          `Your applications will now be tailored against this verified profile.`
      );
      break;
    }

    case '/reject': {
      await sql`
        update facts_versions
        set status = 'rejected'
        where user_id = ${user.id} and status = 'pending';
      `;
      await sendTelegramMessage(chatId, '❌ Proposed resume facts discarded.');
      break;
    }

    case '/rollback': {
      const pastActive = (await sql`
        select * from facts_versions
        where user_id = ${user.id} and status = 'superseded'
        order by created_at desc limit 1;
      `) as Array<{ id: number }>;

      if (pastActive.length === 0) {
        await sendTelegramMessage(chatId, '⚠️ No previous facts version available to roll back to.');
        return;
      }

      await sql`update facts_versions set status = 'superseded' where user_id = ${user.id} and status = 'active';`;
      await sql`update facts_versions set status = 'active' where id = ${pastActive[0].id};`;

      await sendTelegramMessage(chatId, `⏪ Rolled back to previous facts version (ID: ${pastActive[0].id}).`);
      break;
    }

    case '/set': {
      const field = args[0]?.toLowerCase();
      const val = args.slice(1).join(' ').trim();

      const targetVersion = (await sql`
        select * from facts_versions
        where user_id = ${user.id} and status in ('pending', 'active')
        order by case when status = 'pending' then 1 else 2 end, created_at desc
        limit 1;
      `) as Array<{ id: number; facts: MasterFacts; status: string }>;

      if (targetVersion.length === 0) {
        await sendTelegramMessage(chatId, '⚠️ Please upload a resume first before setting attributes.');
        return;
      }

      const current = targetVersion[0];
      const updatedFacts = { ...current.facts };

      if (field === 'years') {
        const num = parseInt(val, 10);
        if (isNaN(num) || num < 0) {
          await sendTelegramMessage(chatId, 'Usage: `/set years <number>` (e.g. `/set years 4`)');
          return;
        }
        updatedFacts.years_experience = num;
        await sendTelegramMessage(chatId, `✅ Experience set to ${num} years.`);
      } else if (field === 'relocation') {
        const isRelo = ['yes', 'true', '1', 'y'].includes(val.toLowerCase());
        updatedFacts.open_to_relocation = isRelo;
        await sendTelegramMessage(chatId, `✅ Open to relocation set to: ${isRelo ? 'Yes' : 'No'}.`);
      } else if (field === 'framing') {
        if (!val) {
          await sendTelegramMessage(chatId, 'Usage: `/set framing <sentence>`');
          return;
        }
        updatedFacts.gap_framing = val;
        await sendTelegramMessage(chatId, `✅ Gap framing sentence updated:\n"${val}"`);
      } else if (field === 'gaps') {
        const gapsList = val.split(',').map((g) => g.trim()).filter(Boolean);
        updatedFacts.skills.known_gaps = gapsList;
        await sendTelegramMessage(chatId, `✅ Known gaps updated: ${gapsList.join(', ')}`);
      } else {
        await sendTelegramMessage(
          chatId,
          `Usage:\n• \`/set years <N>\`\n• \`/set relocation yes|no\`\n• \`/set framing <text>\`\n• \`/set gaps <a, b, c>\``
        );
        return;
      }

      await sql`
        update facts_versions
        set facts = ${JSON.stringify(updatedFacts)}
        where id = ${current.id};
      `;

      if (current.status === 'pending') {
        await sendTelegramMessage(chatId, 'Type `/accept` to lock in these changes.');
      }
      break;
    }

    case '/resumemode': {
      const mode = args[0]?.toLowerCase();
      if (!mode) {
        await sendTelegramMessage(
          chatId,
          `📄 *Current Resume Mode:* \`${settings.resume_mode}\`\n\n` +
            `• \`generated\`: Tailored 1-page ATS template created per application (default).\n` +
            `• \`uploaded\`: Your uploaded PDF is attached unchanged byte-for-byte; email copy only is tailored.\n\n` +
            `Switch with: \`/resumemode generated\` or \`/resumemode uploaded\``
        );
        return;
      }

      if (mode !== 'generated' && mode !== 'uploaded') {
        await sendTelegramMessage(chatId, 'Usage: `/resumemode generated` or `/resumemode uploaded`');
        return;
      }

      await updateUserSettings(user.id, { resume_mode: mode });
      await sendTelegramMessage(chatId, `✅ Resume mode updated to: \`${mode}\`.`);
      break;
    }

    case '/run': {
      // Users run the send pass (the cron's own, under every cap and lock). Ingest and processing spend
      // the shared X and Gemini budget, so only the admin can start them early.
      try {
        if (isAdmin) {
          await sendTelegramMessage(chatId, '🚀 Running ingest, processing and a send pass...');
          const ingest = await runOwnCron('ingest');
          const processed = await runOwnCron('process');
          await sendTelegramMessage(chatId, `Ingest: \`${JSON.stringify(ingest)}\`\nProcess: \`${JSON.stringify(processed)}\``);
        }
        const pass = await runSendPass();
        await sendTelegramMessage(
          chatId,
          `✅ *Send pass finished.* Sent: ${pass.outcomes.sent}, dry-run previews: ${pass.dryRuns}, ` +
            `waiting (caps, spacing or window): ${pass.skipped}.`
        );
      } catch (err) {
        console.error('/run failed:', err);
        await sendTelegramMessage(chatId, '❌ The run failed. Details are in the server log.');
      }
      break;
    }

    case '/reads': {
      const reads = parseInt(args[0], 10);
      if (isNaN(reads) || reads < 1 || reads > settings.max_reads_ceiling) {
        await sendTelegramMessage(
          chatId,
          `Usage: \`/reads <number>\` between 1 and ${settings.max_reads_ceiling} (current: ${settings.daily_read_cap}).`
        );
        return;
      }
      await updateUserSettings(user.id, { daily_read_cap: reads });
      await sendTelegramMessage(chatId, `✅ Up to ${reads} posts will be reviewed for you each day.`);
      break;
    }

    case '/skip': {
      const appId = args[0];
      if (!appId || !UUID_PATTERN.test(appId)) {
        await sendTelegramMessage(chatId, 'Usage: `/skip <application_id>`');
        return;
      }
      const previous = await skipApplication(user.id, appId);
      await sendTelegramMessage(
        chatId,
        previous ? `⏭️ Application skipped (was \`${previous}\`).` : 'No application with that id can be skipped (it is not yours, or it is already sending or sent).'
      );
      break;
    }

    case '/last': {
      const sends = await recentSends(user.id);
      const lines = sends.map((send) => `• ${send.applied_at.slice(0, 16)} → \`${send.contact_email}\` (${send.email_subject ?? 'no subject'})`);
      await sendTelegramMessage(chatId, sends.length > 0 ? `📤 *Last sends:*\n\n${lines.join('\n')}` : 'Nothing has been sent yet.');
      break;
    }

    case '/drafts': {
      const drafts = await openDrafts(user.id);
      const lines = drafts.map(
        (draft) => `• ${draft.kind} to \`${draft.contact_email}\`: https://mail.google.com/mail/u/0/#all/${draft.gmail_thread_id}`
      );
      await sendTelegramMessage(chatId, drafts.length > 0 ? `📝 *Drafts waiting in Gmail:*\n\n${lines.join('\n')}` : 'No drafts are waiting.');
      break;
    }

    case '/import': {
      if (args.length === 0 || args.length > IMPORT_LIMIT) {
        await sendTelegramMessage(chatId, `Usage: \`/import <email> [email ...]\` (up to ${IMPORT_LIMIT} at a time)`);
        return;
      }
      const result = await importPastRecipients(user.id, args);
      await sendTelegramMessage(
        chatId,
        `✅ Imported ${result.imported} past recipient(s); ${result.alreadyKnown} already known.` +
          (result.invalid.length > 0 ? `\nNot valid addresses: ${result.invalid.join(', ')}` : '')
      );
      break;
    }

    default: {
      const tweetMatch = text.match(/(?:twitter|x)\.com\/\w+\/status\/(\d+)/i);
      if (tweetMatch) {
        await sendTelegramMessage(chatId, `🔍 *Detected Job Post URL!* Processing via pipeline...`);
        try {
          await runOwnCron('process');
          await runSendPass();
          await sendTelegramMessage(chatId, `✅ Finished processing post!`);
        } catch (err: unknown) {
          console.error('Manual post processing failed:', err);
          await sendTelegramMessage(chatId, '❌ Error processing post. Details are in the server log.');
        }
        break;
      }

      await sendTelegramMessage(
        chatId,
        `Unknown command. Available commands:\n` +
          `• \`/run\` - 🚀 Run a send pass now\n` +
          `• \`/status\` - Overview & queue stats\n` +
          `• \`/connect\` - Link your Gmail\n` +
          `• \`/pause\` / \`/resume\` - Pause/resume sends\n` +
          `• \`/cap <N>\` - Set daily send cap\n` +
          `• \`/dry on|off\` - Toggle dry-run mode\n` +
          `• \`/window <H1> <H2>\` - Set send window\n` +
          `• \`/timezone <zone>\` - Set timezone\n` +
          `• \`/set years <N>\` - Set years of experience\n` +
          `• \`/accept\` - Approve proposed facts\n` +
          `• \`/resumemode\` - Check or switch resume mode\n` +
          `• \`/done <id>\` - Mark link job as applied`
      );
      break;
    }
  }
}

/**
 * Handles document uploads from Telegram (PDF/DOCX resumes).
 */
export async function handleTelegramDocument(
  chatId: number,
  document: { file_id: string; file_name?: string; file_size?: number; mime_type?: string },
  username?: string,
  displayName?: string
): Promise<void> {
  const user = await getUserByChatId(chatId);
  if (!user || user.status === 'pending' || user.status === 'suspended') {
    await sendTelegramMessage(chatId, '⚠️ Please accept the privacy notice with `/agree` first before uploading a resume.');
    return;
  }

  const fileName = document.file_name || 'resume.pdf';
  const isPdf = fileName.toLowerCase().endsWith('.pdf');
  const isDocx = fileName.toLowerCase().endsWith('.docx');

  if (!isPdf && !isDocx) {
    await sendTelegramMessage(chatId, '❌ Unsupported file format. Please upload your resume as a `.pdf` or `.docx` document.');
    return;
  }

  await sendTelegramMessage(chatId, '📥 *Resume received!* Validating and extracting your skills and experience...');

  try {
    // 1. Get file path from Telegram
    const fileRes = await fetch(`${TELEGRAM_API_BASE_URL}/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${document.file_id}`);
    const fileData = await fileRes.json();
    if (!fileData.ok || !fileData.result?.file_path) {
      throw new Error('Failed to retrieve file location from Telegram.');
    }

    // 2. Download file buffer
    const downloadRes = await fetch(`${TELEGRAM_API_BASE_URL}/file/bot${TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`);
    const arrayBuf = await downloadRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    let pageCount: number | undefined;
    let sha256Hex: string | undefined;

    // 3. Validate PDF
    if (isPdf) {
      const validation = await validateUploadedPdf(buffer);
      if (!validation.valid) {
        await sendTelegramMessage(chatId, `❌ Resume rejected: ${validation.error}`);
        return;
      }
      pageCount = validation.pageCount;
      sha256Hex = validation.sha256;
    }

    // 4. Extract raw text
    const rawText = await extractResumeText(buffer, isPdf ? 'pdf' : 'docx');

    // 5. Convert to structured MasterFacts with Gemini
    const parsedFacts = await parseResumeTextToFacts(rawText);

    // 6. Fetch previous active facts (if any) to carry over non-inferables
    const activeFactsRows = (await sql`
      select facts from facts_versions
      where user_id = ${user.id} and status = 'active'
      limit 1;
    `) as Array<{ facts: MasterFacts }>;

    const activeFacts = activeFactsRows[0]?.facts || null;
    const mergedFacts = mergeWithActiveFacts(parsedFacts, activeFacts);
    const diff = computeFactsDiff(activeFacts, mergedFacts);

    // 7. Store as pending version
    const diffSummaryText = [
      diff.added_projects.length > 0 ? `Projects: ${diff.added_projects.join(', ')}` : '',
      diff.experience_changes.length > 0 ? `Roles: ${diff.experience_changes.join('; ')}` : '',
    ].filter(Boolean).join('\n');

    const insertRes = (await sql`
      insert into facts_versions (
        user_id, source, facts, diff_summary, source_file_pages, source_file_sha256, status
      ) values (
        ${user.id}, 'telegram_upload', ${JSON.stringify(mergedFacts)}, ${diffSummaryText},
        ${pageCount || null}, ${sha256Hex || null}, 'pending'
      )
      returning id;
    `) as Array<{ id: number }>;

    await logEvent(user.id, 'resume_uploaded_and_parsed', { versionId: insertRes[0].id, isPdf });

    // 8. Send summary to user
    await sendTelegramMessage(
      chatId,
      `📋 *Resume Extracted Successfully!*\n\n` +
        `*Name:* ${mergedFacts.identity.name || 'Not detected'}\n` +
        `*Email:* ${mergedFacts.identity.email || 'Not detected'}\n` +
        `*Experience:* ${mergedFacts.years_experience} years\n` +
        `*Open to Relocation:* ${mergedFacts.open_to_relocation ? 'Yes' : 'No'}\n` +
        `*Roles Found:* ${mergedFacts.experience.length}\n` +
        `*Projects Found:* ${mergedFacts.projects.length}\n` +
        `*Strong Skills:* ${mergedFacts.skills.strong.slice(0, 10).join(', ')}\n\n` +
        `👉 *Next Steps to Activate:*\n` +
        `1. Set your professional years of experience: \`/set years <N>\`\n` +
        `2. (Optional) Set relocation: \`/set relocation yes|no\`\n` +
        `3. When ready, approve this profile: \`/accept\``
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('Error handling resume upload:', err);
    await sendTelegramMessage(chatId, `❌ Failed to parse resume: ${errorMsg}`);
  }
}

/**
 * Handles administrative commands.
 */
async function handleAdminCommand(
  chatId: number,
  adminUserId: string,
  command: string,
  args: string[]
): Promise<void> {
  // `/admin pauseall` arrives as command '/admin' with args ['pauseall']; Telegram's menu sends `/admin_pauseall`.
  const action = command === '/admin' ? `/admin_${args[0]?.toLowerCase() ?? ''}` : command;
  switch (action) {
    case '/invite': {
      const code = await createInvite(adminUserId, 1);
      await sendTelegramMessage(chatId, `🎫 *New Invite Code Created:*\n\`${code}\`\n\nSend this code to the candidate.`);
      break;
    }

    case '/users': {
      const users = await listAllUsers();
      const list = users
        .map(
          (u) =>
            `• *${u.display_name || u.telegram_username || 'Anonymous'}* (\`${u.status}\`)\n` +
            `  Cap: ${u.current_cap}/day | Stage: ${u.ramp_stage} | Gmail: ${u.gmail_status}\n` +
            `  ID: \`${u.id}\``
        )
        .join('\n\n');
      await sendTelegramMessage(chatId, `👥 *Registered Users (${users.length}):*\n\n${list || 'No users found.'}`);
      break;
    }

    case '/suspend':
    case '/unsuspend': {
      const targetId = args[0];
      const suspend = action === '/suspend';
      if (!targetId || !UUID_PATTERN.test(targetId)) {
        await sendTelegramMessage(chatId, `Usage: \`${action} <user_id>\` (ids are in \`/users\`)`);
        return;
      }
      const changed = await setUserSuspension(targetId, suspend);
      await sendTelegramMessage(
        chatId,
        changed
          ? suspend ? `⛔ User \`${targetId}\` suspended.` : `✅ User \`${targetId}\` restored.`
          : `No ${suspend ? 'active' : 'suspended'} user with id \`${targetId}\` (the admin cannot be suspended).`
      );
      break;
    }

    case '/limits': {
      // /limits <user_id> cap N reads N
      const [targetId, capWord, capArg, readsWord, readsArg] = args;
      const maxCap = parseInt(capArg, 10);
      const maxReads = parseInt(readsArg, 10);
      const valid =
        targetId !== undefined && UUID_PATTERN.test(targetId) && capWord === 'cap' && readsWord === 'reads' &&
        maxCap >= 1 && maxCap <= MAX_CAP_CEILING && maxReads >= 1 && maxReads <= MAX_READS_CEILING;
      if (!valid) {
        await sendTelegramMessage(
          chatId,
          `Usage: \`/limits <user_id> cap <1-${MAX_CAP_CEILING}> reads <1-${MAX_READS_CEILING}>\``
        );
        return;
      }
      const updated = await setUserLimits(targetId, maxCap, maxReads);
      await sendTelegramMessage(
        chatId,
        updated ? `✅ Limits for \`${targetId}\`: cap ${maxCap}, reads ${maxReads}.` : `No user with id \`${targetId}\`.`
      );
      break;
    }

    case '/admin_xreads':
    case '/admin_threads': {
      const value = parseInt(command === '/admin' ? args[1] : args[0], 10);
      const key = action === '/admin_xreads' ? 'x_daily_read_cap' : 'x_daily_thread_cap';
      // Thread expansion spends X reads, so both are bounded by the hard daily X read limit.
      if (isNaN(value) || value < 0 || value > X_MAX_DAILY_READS) {
        await sendTelegramMessage(chatId, `Usage: \`/admin ${action.slice(7)} <0-${X_MAX_DAILY_READS}>\``);
        return;
      }
      await sql`update global_settings set value = ${String(value)} where key = ${key}`;
      await logEvent(adminUserId, 'global_setting_changed', { key, value });
      await sendTelegramMessage(chatId, `✅ \`${key}\` set to ${value}.`);
      break;
    }

    case '/admin_ingest': {
      try {
        const ingest = await runOwnCron('ingest');
        await sendTelegramMessage(chatId, `✅ Ingest finished: \`${JSON.stringify(ingest)}\``);
      } catch (err) {
        console.error('/admin ingest failed:', err);
        await sendTelegramMessage(chatId, '❌ Ingest failed. Details are in the server log.');
      }
      break;
    }

    case '/admin_pauseall': {
      await sql`update global_settings set value = 'true' where key = 'global_paused';`;
      await sendTelegramMessage(chatId, '🚨 *GLOBAL EMERGENCY PAUSE ACTIVATED!* All sends halted.');
      break;
    }

    case '/admin_resumeall': {
      await sql`update global_settings set value = 'false' where key = 'global_paused';`;
      await sendTelegramMessage(chatId, '▶️ *Global Pause Cleared.* System resumed.');
      break;
    }

    default:
      await sendTelegramMessage(chatId, 'Unknown admin command.');
      break;
  }
}
