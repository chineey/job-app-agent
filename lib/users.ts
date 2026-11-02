import crypto from 'crypto';
import { escapeIdentifier } from 'pg';
import { sql, query, withTransaction, logEvent, assertUserScope } from './db';

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

export type Registration =
  | { outcome: 'created'; user: UserRecord }
  | { outcome: 'already_registered' }
  | { outcome: 'rejected'; reason: string };

/**
 * Registers a chat as a 'pending' user with default settings (dry run on).
 * The admin (ADMIN_CHAT_ID) needs no invite; everyone else redeems one.
 */
export async function registerUser(
  chatId: number,
  username: string | null,
  displayName: string | null,
  inviteCode: string | null
): Promise<Registration> {
  const isAdmin = ADMIN_CHAT_ID !== null && chatId === ADMIN_CHAT_ID;
  const code = inviteCode?.trim().toUpperCase() ?? null;
  if (!isAdmin && !code) {
    return { outcome: 'rejected', reason: 'An invite code is required: `/start <code>`' };
  }

  const registration = await withTransaction(async (tx): Promise<Registration> => {
    // Serializes registrations so the MAX_USERS count below cannot be passed by two at once.
    await tx`select pg_advisory_xact_lock(hashtext('user_registration'))`;

    if (!isAdmin) {
      // The row lock makes check-then-increment atomic: a single-use code admits one user.
      const [invite] = (await tx`
        select uses, max_uses, expires_at is not null and expires_at < now() as expired
        from invites where code = ${code} for update
      `) as Array<{ uses: number; max_uses: number; expired: boolean }>;
      if (!invite) return { outcome: 'rejected', reason: 'Invalid invite code.' };
      if (invite.uses >= invite.max_uses) return { outcome: 'rejected', reason: 'Invite code has already been used.' };
      if (invite.expired) return { outcome: 'rejected', reason: 'Invite code has expired.' };

      const [registered] = (await tx`
        select count(*)::int as count from users where status != 'deleted'
      `) as Array<{ count: number }>;
      if (registered.count >= MAX_USERS) {
        return { outcome: 'rejected', reason: `System user capacity reached (${MAX_USERS} users).` };
      }
    }

    const [user] = (await tx`
      insert into users (telegram_chat_id, telegram_username, display_name, role, status)
      values (${chatId}, ${username}, ${displayName}, ${isAdmin ? 'admin' : 'user'}, 'pending')
      on conflict (telegram_chat_id) do nothing
      returning *
    `) as UserRecord[];
    if (!user) return { outcome: 'already_registered' };

    if (!isAdmin) {
      await tx`update invites set uses = uses + 1 where code = ${code}`;
    }
    // Schema defaults are the onboarding defaults, including dry_run = true.
    await tx`insert into user_settings (user_id) values (${user.id})`;
    await tx`insert into send_state (user_id) values (${user.id})`;
    return { outcome: 'created', user };
  });

  if (registration.outcome === 'created') {
    await logEvent(registration.user.id, 'user_onboarded', {
      chatId,
      username,
      role: registration.user.role,
      inviteCode: code,
    });
  }
  return registration;
}

/**
 * Returns the canonical IANA name for a timezone, or null if Intl does not know it.
 * Send queries use it with Postgres `at time zone`, which throws on an unknown name.
 */
export function canonicalTimeZone(timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
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

  // Column names cannot be bind parameters, so each one is quoted as an identifier.
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      await query(`update user_settings set ${escapeIdentifier(key)} = $1 where user_id = $2`, [val, userId]);
    }
  }
}

/**
 * Suspends or unsuspends a user (Admin only).
 */
export async function setUserSuspension(userId: string, suspended: boolean): Promise<boolean> {
  assertUserScope(userId);
  // Only between active and suspended: never revives a deleted or pending account, never touches the admin.
  const from = suspended ? 'active' : 'suspended';
  const to = suspended ? 'suspended' : 'active';
  const changed = await sql`
    update users set status = ${to} where id = ${userId} and status = ${from} and role <> 'admin' returning id
  `;
  if (changed.length === 0) return false;
  await logEvent(userId, suspended ? 'user_suspended' : 'user_unsuspended', {});
  return true;
}

/** Highest per-user ceilings the admin may set: the final ramp stage's cap, and the spec's review limit. */
export const MAX_CAP_CEILING = 20;
export const MAX_READS_CEILING = 300;

/**
 * Sets a user's ceilings (admin). The user's current cap and read limit are lowered to fit;
 * raising a ceiling never raises what the user has chosen. Returns false for an unknown user.
 */
export async function setUserLimits(userId: string, maxCap: number, maxReads: number): Promise<boolean> {
  assertUserScope(userId);
  const updated = await sql`
    update user_settings
    set max_cap = ${maxCap},
        max_reads_ceiling = ${maxReads},
        current_cap = least(current_cap, ${maxCap}),
        daily_read_cap = least(daily_read_cap, ${maxReads})
    where user_id = ${userId}
    returning user_id
  `;
  if (updated.length === 0) return false;
  await logEvent(userId, 'user_limits_set', { maxCap, maxReads });
  return true;
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
  await sql`delete from events where user_id = ${userId};`;
  await sql`delete from telegram_updates where chat_id = (select telegram_chat_id from users where id = ${userId});`;

  await sql`
    update users
    set status = 'deleted',
        gmail_refresh_token_enc = null,
        gmail_address = null,
        gmail_status = 'disconnected'
    where id = ${userId};
  `;

  await logEvent(userId, 'user_account_deleted', {});
}
