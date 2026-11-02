import { sql, logEvent, assertUserScope } from './db';
import { getUserSettings, type UserSettingsRecord } from './users';
import { sendTelegramMessage } from './telegram';

// Per-user ramp and automatic pauses. See docs/ramp-and-auto-pause.md.

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID, 10) : null;

/** Daily send cap for each ramp stage; stage 0 is dry run. */
const STAGE_CAPS = [0, 3, 5, 10, 15, 20];
const FINAL_STAGE = STAGE_CAPS.length - 1;

interface PromotionRule {
  activeDays: number;
  bounces: 'none' | 'under_3_percent';
  failuresAllowed: boolean;
}

/** What a user must show in a stage before moving to the next one. */
const PROMOTION_RULES: Record<number, PromotionRule> = {
  1: { activeDays: 3, bounces: 'none', failuresAllowed: false },
  2: { activeDays: 3, bounces: 'under_3_percent', failuresAllowed: true },
  3: { activeDays: 4, bounces: 'under_3_percent', failuresAllowed: false },
  4: { activeDays: 4, bounces: 'under_3_percent', failuresAllowed: true },
};

export function stageCap(stage: number): number {
  return STAGE_CAPS[Math.min(Math.max(stage, 0), FINAL_STAGE)];
}

/** The most `/cap` may be set to: the stage cap (stage 1's while in dry run) within the admin's ceiling. */
export function capCeiling(settings: Pick<UserSettingsRecord, 'ramp_stage' | 'max_cap'>): number {
  return Math.min(stageCap(Math.max(settings.ramp_stage, 1)), settings.max_cap);
}

/** The cap sending actually obeys: the lowest of the user's cap, the stage cap and the admin's ceiling. */
export function sendCap(settings: Pick<UserSettingsRecord, 'ramp_stage' | 'current_cap' | 'max_cap'>): number {
  return Math.min(settings.current_cap, stageCap(settings.ramp_stage), settings.max_cap);
}

/**
 * Moves a live user up one stage when their sends since the stage started meet its rule.
 * Days without sends are not counted: they say nothing about the sender's reputation.
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
  const rule = PROMOTION_RULES[stage];
  if (!rule) {
    return { changed: false };
  }
  if (!settings.ramp_stage_started_at) {
    // Rows written before the stage clock was always set: start it now rather than promote on no evidence.
    await sql`update user_settings set ramp_stage_started_at = now() where user_id = ${userId} and ramp_stage_started_at is null`;
    return { changed: false };
  }

  const [stats] = (await sql`
    select (count(distinct (a.reserved_at at time zone ${settings.timezone})::date) filter (where a.state = 'sent'))::int as active_days,
           (count(*) filter (where a.state = 'sent'))::int as sent,
           (count(*) filter (where a.state = 'sent' and app.status = 'bounced'))::int as bounced,
           (count(*) filter (where a.state = 'failed'))::int as failed
    from send_attempts a
    join applications app on app.id = a.application_id
    where a.user_id = ${userId} and a.reserved_at >= ${settings.ramp_stage_started_at}
  `) as Array<{ active_days: number; sent: number; bounced: number; failed: number }>;

  const bouncesOk = rule.bounces === 'none' ? stats.bounced === 0 : stats.bounced * 100 < stats.sent * 3;
  const failuresOk = rule.failuresAllowed || stats.failed === 0;
  if (stats.active_days < rule.activeDays || !bouncesOk || !failuresOk) {
    return { changed: false };
  }

  const nextStage = stage + 1;
  const nextCap = Math.min(stageCap(nextStage), settings.max_cap);
  // The stage guard keeps two overlapping summary runs from promoting twice.
  const promoted = await sql`
    update user_settings
    set ramp_stage = ${nextStage},
        current_cap = ${nextCap},
        ramp_stage_started_at = now(),
        last_raise_at = now()
    where user_id = ${userId} and ramp_stage = ${stage}
    returning user_id
  `;
  if (promoted.length === 0) {
    return { changed: false };
  }

  await logEvent(userId, 'ramp_stage_promoted', { fromStage: stage, toStage: nextStage, newCap: nextCap, ...stats });
  return {
    changed: true,
    newStage: nextStage,
    newCap: nextCap,
    message:
      `🎉 Your account moved to ramp stage ${nextStage}. Your daily send cap is now ${nextCap}. ` +
      `To keep it lower, send \`/cap <number>\`.`,
  };
}

/**
 * Pauses a user's sending and tells them and the admin why. A user who is already paused is not
 * alerted again, so several triggers firing together produce one alert.
 */
export async function autoPause(userId: string, reason: string): Promise<void> {
  assertUserScope(userId);
  const paused = await sql`
    update user_settings set paused = true where user_id = ${userId} and paused = false returning user_id
  `;
  if (paused.length === 0) {
    return;
  }
  await logEvent(userId, 'auto_pause_triggered', { reason });

  const [user] = (await sql`
    select telegram_chat_id, coalesce(display_name, telegram_username, id::text) as name from users where id = ${userId}
  `) as Array<{ telegram_chat_id: number; name: string }>;
  await sendTelegramMessage(
    user.telegram_chat_id,
    `🚨 *Sending paused automatically*\n\n${reason}\n\nCheck \`/status\` and your Gmail, then send \`/resume\` when it is safe.`
  );
  if (ADMIN_CHAT_ID !== null && ADMIN_CHAT_ID !== Number(user.telegram_chat_id)) {
    await sendTelegramMessage(ADMIN_CHAT_ID, `🚨 *Auto-pause* for ${user.name}: ${reason}`);
  }
}

/** Pauses after three confirmed send failures in a row. */
export async function pauseAfterConsecutiveFailures(userId: string): Promise<void> {
  const recent = (await sql`
    select state from send_attempts
    where user_id = ${userId} and state in ('sent', 'failed')
    order by finished_at desc nulls last
    limit 3
  `) as Array<{ state: string }>;
  if (recent.length === 3 && recent.every((attempt) => attempt.state === 'failed')) {
    await autoPause(userId, 'Your last three sends were rejected.');
  }
}

/** Pauses when more than 5% of the user's last 20 sends bounced, however few sends there are. */
export async function pauseOnHighBounceRate(userId: string): Promise<void> {
  const [recent] = (await sql`
    select count(*)::int as sent, (count(*) filter (where app.status = 'bounced'))::int as bounced
    from (
      select application_id from send_attempts
      where user_id = ${userId} and state = 'sent'
      order by finished_at desc nulls last
      limit 20
    ) last_sends
    join applications app on app.id = last_sends.application_id
  `) as Array<{ sent: number; bounced: number }>;
  if (recent.sent > 0 && recent.bounced * 100 > recent.sent * 5) {
    await autoPause(userId, `${recent.bounced} of your last ${recent.sent} sends bounced (over 5%).`);
  }
}
