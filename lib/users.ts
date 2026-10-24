import crypto from 'crypto';
import { sql, logEvent, assertUserScope } from './db';

export interface UserRecord {
  id: string;
  telegram_chat_id: number;
  telegram_username: string | null;
  display_name: string | null;
  role: 'user' | 'admin';
  status: 'pending' | 'active' | 'suspended' | 'deleted';
  consented_at: string | null;
  consent_version: string | null;
  gmail_address: string | null;
  gmail_refresh_token_enc: string | null;
  gmail_status: 'disconnected' | 'connected' | 'error';
  gmail_connected_at: string | null;
  last_inbox_scan_at: string | null;
  last_summary_on: string | null;
  created_at: string;
}

export interface UserSettingsRecord {
  user_id: string;
  paused: boolean;
  dry_run: boolean;
  dry_run_drafts_shown: number;
  ramp_stage: number;
  ramp_stage_started_at: string | null;
  current_cap: number;
  max_cap: number;
  daily_read_cap: number;
  max_reads_ceiling: number;
  manual_daily_cap: number;
  fit_threshold: number;
  timezone: string;
  send_window_start: number;
  send_window_end: number;
  min_send_gap_seconds: number;
  last_raise_at: string | null;
  availability_note: string | null;
  resume_mode: 'generated' | 'uploaded';
}

export interface InviteRecord {
  code: string;
  created_by: string | null;
  max_uses: number;
  uses: number;
  expires_at: string | null;
  created_at: string;
}

const MAX_USERS = parseInt(process.env.MAX_USERS || '20', 10);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID, 10) : null;

/**
 * Generates an 8-character uppercase alphanumeric invite code.
 */
export async function createInvite(createdByUserId: string | null, maxUses: number = 1): Promise<string> {
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  await sql`
    insert into invites (code, created_by, max_uses, uses)
    values (${code}, ${createdByUserId}, ${maxUses}, 0);
  `;
  return code;
}

/**
 * Validates whether an invite code is valid and available.
 */
export async function validateInvite(code: string): Promise<{ valid: boolean; reason?: string }> {
  const rows = (await sql`
    select * from invites where code = ${code.trim().toUpperCase()} limit 1;
  `) as InviteRecord[];

  if (rows.length === 0) {
    return { valid: false, reason: 'Invalid invite code.' };
  }

  const invite = rows[0];
  if (invite.uses >= invite.max_uses) {
    return { valid: false, reason: 'Invite code has already been used.' };
  }

  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return { valid: false, reason: 'Invite code has expired.' };
  }

  // Check system-wide user cap
  const userCountRows = (await sql`
    select count(*)::int as count from users where status != 'deleted';
  `) as { count: number }[];

  if (userCountRows[0].count >= MAX_USERS) {
    return { valid: false, reason: `System user capacity reached (${MAX_USERS} users).` };
  }

  return { valid: true };
}

/**
 * Retrieves user by Telegram Chat ID.
 */
export async function getUserByChatId(chatId: number): Promise<UserRecord | null> {
  const rows = (await sql`
    select * from users where telegram_chat_id = ${chatId} limit 1;
  `) as UserRecord[];
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Retrieves user by UUID.
 */
export async function getUserById(userId: string): Promise<UserRecord | null> {
  assertUserScope(userId);
  const rows = (await sql`
    select * from users where id = ${userId} limit 1;
  `) as UserRecord[];
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Creates a new user in 'pending' status and initializes default settings.
 */
export async function createUserWithInvite(
  chatId: number,
  username: string | null,
  displayName: string | null,
  inviteCode: string
): Promise<UserRecord> {
  const code = inviteCode.trim().toUpperCase();
  const validation = await validateInvite(code);
  if (!validation.valid) {
    throw new Error(validation.reason || 'Invalid invite');
  }

  const role = ADMIN_CHAT_ID !== null && chatId === ADMIN_CHAT_ID ? 'admin' : 'user';

  // Create user
  const userRows = (await sql`
    insert into users (
      telegram_chat_id, telegram_username, display_name, role, status
    ) values (
      ${chatId}, ${username}, ${displayName}, ${role}, 'pending'
    )
    returning *;
  `) as UserRecord[];

  const newUser = userRows[0];

  // Increment invite usage
  await sql`
    update invites set uses = uses + 1 where code = ${code};
  `;

  // Create user default settings
  await sql`
    insert into user_settings (
      user_id, paused, dry_run, ramp_stage, current_cap, max_cap,
      daily_read_cap, max_reads_ceiling, manual_daily_cap, fit_threshold,
      timezone, send_window_start, send_window_end, min_send_gap_seconds,
      resume_mode
    ) values (
      ${newUser.id}, false, true, 0, 3, 20,
      50, 100, 5, 40,
      'UTC', 9, 17, 120,
      'generated'
    ) on conflict (user_id) do nothing;
  `;

  // Initialize send_state row
  await sql`
    insert into send_state (user_id) values (${newUser.id}) on conflict (user_id) do nothing;
  `;

  await logEvent(newUser.id, 'user_onboarded', { chatId, username, role, inviteCode: code });
  return newUser;
}

/**
 * Agrees to privacy policy and activates the user account.
 */
export async function agreeToTerms(userId: string, version: string = 'v3.2'): Promise<void> {
  assertUserScope(userId);
  await sql`
    update users
    set status = 'active',
        consented_at = now(),
        consent_version = ${version}
    where id = ${userId};
  `;
  await logEvent(userId, 'user_agreed_terms', { version });
}

/**
 * Fetches user settings.
 */
export async function getUserSettings(userId: string): Promise<UserSettingsRecord | null> {
  assertUserScope(userId);
  const rows = (await sql`
    select * from user_settings where user_id = ${userId} limit 1;
  `) as UserSettingsRecord[];
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Updates user settings.
 */
export async function updateUserSettings(
  userId: string,
  updates: Partial<UserSettingsRecord>
): Promise<void> {
  assertUserScope(userId);

  // Apply updates safely
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      await sql`
        update user_settings
        set ${sql(key)} = ${val}
        where user_id = ${userId};
      `;
    }
  }
}

/**
 * Suspends or unsuspends a user (Admin only).
 */
export async function setUserSuspension(userId: string, suspended: boolean): Promise<void> {
  assertUserScope(userId);
  const status = suspended ? 'suspended' : 'active';
  await sql`
    update users set status = ${status} where id = ${userId};
  `;
  await logEvent(userId, suspended ? 'user_suspended' : 'user_unsuspended', {});
}

/**
 * Lists all non-deleted users (Admin only).
 */
export async function listAllUsers(): Promise<(UserRecord & { current_cap: number; ramp_stage: number })[]> {
  const rows = (await sql`
    select u.*, s.current_cap, s.ramp_stage
    from users u
    left join user_settings s on u.id = s.user_id
    where u.status != 'deleted'
    order by u.created_at asc;
  `) as (UserRecord & { current_cap: number; ramp_stage: number })[];
  return rows;
}

/**
 * Purges account data on /delete_me.
 */
export async function deleteUserAccount(userId: string): Promise<void> {
  assertUserScope(userId);

  // Clean up cascade
  await sql`delete from send_attempts where user_id = ${userId};`;
  await sql`delete from send_state where user_id = ${userId};`;
  await sql`delete from applications where user_id = ${userId};`;
  await sql`delete from facts_versions where user_id = ${userId};`;
  await sql`delete from user_settings where user_id = ${userId};`;
  await sql`delete from user_spend where user_id = ${userId};`;
  await sql`delete from oauth_states where user_id = ${userId};`;

  await sql`
    update users
    set status = 'deleted',
        gmail_refresh_token_enc = null,
        gmail_status = 'disconnected'
    where id = ${userId};
  `;

  await logEvent(userId, 'user_account_deleted', {});
}

/**
 * Evaluates candidate ramp stage advancement.
 */
export async function evaluateRampProgression(
  userId: string
): Promise<{ changed: boolean; newStage?: number; newCap?: number; message?: string }> {
  assertUserScope(userId);
  const settings = await getUserSettings(userId);
  if (!settings || settings.dry_run || settings.paused) {
    return { changed: false };
  }

  const stage = settings.ramp_stage;
  if (stage >= 5) {
    return { changed: false };
  }

  // Calculate stats for current stage
  const stageStarted = settings.ramp_stage_started_at ? new Date(settings.ramp_stage_started_at) : new Date(0);

  // Total sends and bounces since stage began
  const statsRows = (await sql`
    select
      count(*) filter (where state = 'sent')::int as sent_count,
      count(*) filter (where state = 'failed')::int as error_count
    from send_attempts
    where user_id = ${userId} and reserved_at >= ${stageStarted.toISOString()};
  `) as { sent_count: number; error_count: number }[];

  const bounceRows = (await sql`
    select count(*)::int as bounce_count
    from applications
    where user_id = ${userId} and status = 'bounced' and updated_at >= ${stageStarted.toISOString()};
  `) as { bounce_count: number }[];

  const sentCount = statsRows[0]?.sent_count || 0;
  const errorCount = statsRows[0]?.error_count || 0;
  const bounceCount = bounceRows[0]?.bounce_count || 0;
  const bounceRate = sentCount > 0 ? (bounceCount / sentCount) * 100 : 0;

  const daysInStage = Math.floor((Date.now() - stageStarted.getTime()) / (1000 * 60 * 60 * 24));

  let eligible = false;
  let nextStage = stage + 1;
  let nextCap = settings.current_cap;

  switch (stage) {
    case 1:
      // Stage 1 -> 2: 3 days, 0 bounces, 0 errors, cap 3 -> 5
      if (daysInStage >= 3 && bounceCount === 0 && errorCount === 0) {
        eligible = true;
        nextCap = Math.min(5, settings.max_cap);
      }
      break;
    case 2:
      // Stage 2 -> 3: 3 days, bounce rate < 3%, cap 5 -> 10
      if (daysInStage >= 3 && bounceRate < 3) {
        eligible = true;
        nextCap = Math.min(10, settings.max_cap);
      }
      break;
    case 3:
      // Stage 3 -> 4: 4 days, bounce rate < 3%, cap 10 -> 15
      if (daysInStage >= 4 && bounceRate < 3) {
        eligible = true;
        nextCap = Math.min(15, settings.max_cap);
      }
      break;
    case 4:
      // Stage 4 -> 5: 4 days, bounce rate < 3%, cap 15 -> 20
      if (daysInStage >= 4 && bounceRate < 3) {
        eligible = true;
        nextCap = Math.min(20, settings.max_cap);
      }
      break;
  }

  if (eligible) {
    await sql`
      update user_settings
      set ramp_stage = ${nextStage},
          current_cap = ${nextCap},
          ramp_stage_started_at = now(),
          last_raise_at = now()
      where user_id = ${userId};
    `;

    await logEvent(userId, 'ramp_stage_promoted', { fromStage: stage, toStage: nextStage, newCap: nextCap });
    return {
      changed: true,
      newStage: nextStage,
      newCap: nextCap,
      message: `🎉 Great news! Your account progressed to Ramp Stage ${nextStage}. Daily send cap is now ${nextCap}.`,
    };
  }

  return { changed: false };
}

/**
 * Triggers auto-pause for a candidate.
 */
export async function autoPauseUser(userId: string, reason: string): Promise<void> {
  assertUserScope(userId);
  await sql`
    update user_settings set paused = true where user_id = ${userId};
  `;
  await logEvent(userId, 'auto_pause_triggered', { reason });
}
