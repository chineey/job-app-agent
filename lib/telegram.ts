import { sql, logEvent } from './db';
import {
  getUserByChatId,
  createUserWithInvite,
  agreeToTerms,
  getUserSettings,
  updateUserSettings,
  createInvite,
  listAllUsers,
  setUserSuspension,
  deleteUserAccount,
} from './users';
import { resolveSendAttempt } from './send';
import { revokeGoogleToken } from './gmail';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID, 10) : null;
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

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

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
      }),
    });
    return res.ok;
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

    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      body: formData,
    });
    return res.ok;
  } catch (err) {
    console.error(`Failed to send Telegram document to ${chatId}:`, err);
    return false;
  }
}

/**
 * Dispatches an interactive card for link/form opportunities with resume PDF.
 */
export async function dispatchLinkOpportunityCard(
  chatId: number,
  params: {
    applicationId: string;
    role: string;
    company: string;
    location: string;
    salary?: string;
    deadline?: string;
    fitScore: number;
    gaps: string[];
    postUrl: string;
    applyLink: string;
    coverNote: string;
    pdfBuffer?: Buffer;
  }
): Promise<void> {
  const isUrgent =
    params.deadline && (new Date(params.deadline).getTime() - Date.now()) / (1000 * 60 * 60) <= 48;
  const deadlineHeader = isUrgent ? `🚨 *DEADLINE URGENT:* \`${params.deadline}\`` : `📅 *Deadline:* ${params.deadline || 'None listed'}`;

  const message = [
    `💼 *New Job Opportunity (Manual Apply)*`,
    '',
    `*Role:* ${params.role}`,
    `*Company:* ${params.company}`,
    `*Location:* ${params.location || 'Remote'}`,
    params.salary ? `*Salary:* ${params.salary}` : '',
    deadlineHeader,
    `*Fit Score:* ${params.fitScore}/100`,
    params.gaps.length > 0 ? `*Identified Gaps:* ${params.gaps.join(', ')}` : '',
    '',
    `🔗 *Apply Link:* ${params.applyLink}`,
    `🐦 *Original Post:* ${params.postUrl}`,
    '',
    `📝 *Suggested Cover Note:*`,
    `\`\`\``,
    params.coverNote || 'I am excited to submit my application for this role.',
    `\`\`\``,
    '',
    `_Apply at the link above, then mark as submitted:_`,
    `\`/done ${params.applicationId}\``,
  ]
    .filter(Boolean)
    .join('\n');

  if (params.pdfBuffer) {
    await sendTelegramDocument(chatId, params.pdfBuffer, `${params.company}_Resume.pdf`, message);
  } else {
    await sendTelegramMessage(chatId, message);
  }
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

  // Allow /start <code> for unauthenticated users
  if (!user) {
    if (command === '/start') {
      const inviteCode = args[0];
      if (!inviteCode) {
        await sendTelegramMessage(chatId, '❌ Welcome! To get started, please provide an invite code:\n`/start <code>`');
        return;
      }

      try {
        user = await createUserWithInvite(chatId, username || null, displayName || null, inviteCode);
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await sendTelegramMessage(chatId, `❌ Registration failed: ${msg}`);
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
  if (command.startsWith('/admin') || (isAdmin && ['/invite', '/users', '/suspend', '/unsuspend', '/limits'].includes(command))) {
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

      const todaySends = (await sql`
        select count(*)::int as count
        from send_attempts
        where user_id = ${user.id} and state = 'sent'
          and (reserved_at at time zone ${settings.timezone})::date = (now() at time zone ${settings.timezone})::date;
      `) as { count: number }[];

      await sendTelegramMessage(
        chatId,
        `📊 *Your Status Overview*\n\n` +
          `*Gmail:* \`${user.gmail_status}\` (${user.gmail_address || 'not connected'})\n` +
          `*Ramp Stage:* \`${settings.ramp_stage}\` | *Dry Run:* \`${settings.dry_run ? 'ON' : 'OFF'}\`\n` +
          `*Today's Sends:* ${todaySends[0].count} / ${settings.current_cap} (Max: ${settings.max_cap})\n` +
          `*Send Window:* ${settings.send_window_start}:00 - ${settings.send_window_end}:00 (${settings.timezone})\n` +
          `*Resume Mode:* \`${settings.resume_mode}\`\n\n` +
          `*Queue Counts:*\n` +
          `• Verified / Ready: ${statusMap['verified'] || statusMap['ready'] || 0}\n` +
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
          `Click the link below to authorize sending applications from your personal Gmail:\n\n` +
          `👉 [Authorize Gmail](${connectUrl})\n\n` +
          `_Link expires in 10 minutes._`
      );
      break;
    }

    case '/disconnect': {
      if (user.gmail_refresh_token_enc) {
        await revokeGoogleToken(user.gmail_refresh_token_enc);
      }
      await sql`
        update users
        set gmail_refresh_token_enc = null,
            gmail_status = 'disconnected'
        where id = ${user.id};
      `;
      await sendTelegramMessage(chatId, '🔌 Gmail connection revoked and disconnected.');
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
      const capVal = parseInt(args[0], 10);
      if (isNaN(capVal) || capVal < 1) {
        await sendTelegramMessage(chatId, `Usage: \`/cap <number>\` (Current: ${settings.current_cap}, Max: ${settings.max_cap})`);
        return;
      }
      if (capVal > settings.max_cap) {
        await sendTelegramMessage(chatId, `❌ Cap cannot exceed your account ceiling of ${settings.max_cap}.`);
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
        // Enforce safety exit prerequisites
        const isConfirm = args[1]?.toLowerCase() === 'confirm';
        if (!isConfirm) {
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

          await sendTelegramMessage(
            chatId,
            `⚠️ *Ready to go live at Stage 1 (3 sends/day)?*\nConfirm by typing:\n\`/dry off confirm\``
          );
          return;
        }

        await updateUserSettings(user.id, { dry_run: false, ramp_stage: 1, current_cap: 3 });
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
      const tz = args[0];
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
      const action = args[1]?.toLowerCase() as 'sent' | 'notsent';
      if (!attemptId || !['sent', 'notsent'].includes(action)) {
        await sendTelegramMessage(chatId, 'Usage: `/resolve <attempt_id> sent|notsent`');
        return;
      }
      const res = await resolveSendAttempt(attemptId, action, 'user');
      await sendTelegramMessage(chatId, res.message);
      break;
    }

    case '/done': {
      const appId = args[0];
      if (!appId) {
        await sendTelegramMessage(chatId, 'Usage: `/done <application_id>`');
        return;
      }
      await sql`
        update applications
        set status = 'applied_manually', applied_at = now()
        where id = ${appId} and user_id = ${user.id};
      `;
      await sendTelegramMessage(chatId, `✅ Application ${appId} marked as applied manually.`);
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
      await deleteUserAccount(user.id);
      await sendTelegramMessage(chatId, '👋 Your account and associated data have been permanently purged.');
      break;
    }

    default:
      await sendTelegramMessage(
        chatId,
        `Unknown command. Available commands:\n` +
          `• \`/status\` - Overview & queue stats\n` +
          `• \`/connect\` - Link your Gmail\n` +
          `• \`/pause\` / \`/resume\` - Pause/resume sends\n` +
          `• \`/cap <N>\` - Set daily send cap\n` +
          `• \`/dry on|off\` - Toggle dry-run mode\n` +
          `• \`/window <H1> <H2>\` - Set send window\n` +
          `• \`/timezone <zone>\` - Set timezone\n` +
          `• \`/done <id>\` - Mark link job as applied`
      );
      break;
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
  switch (command) {
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

    case '/suspend': {
      const targetId = args[0];
      if (!targetId) {
        await sendTelegramMessage(chatId, 'Usage: `/suspend <user_id>`');
        return;
      }
      await setUserSuspension(targetId, true);
      await sendTelegramMessage(chatId, `⛔ User \`${targetId}\` suspended.`);
      break;
    }

    case '/unsuspend': {
      const targetId = args[0];
      if (!targetId) {
        await sendTelegramMessage(chatId, 'Usage: `/unsuspend <user_id>`');
        return;
      }
      await setUserSuspension(targetId, false);
      await sendTelegramMessage(chatId, `✅ User \`${targetId}\` restored.`);
      break;
    }

    case '/admin pauseall':
    case '/admin_pauseall': {
      await sql`update global_settings set value = 'true' where key = 'global_paused';`;
      await sendTelegramMessage(chatId, '🚨 *GLOBAL EMERGENCY PAUSE ACTIVATED!* All sends halted.');
      break;
    }

    case '/admin resumeall':
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
