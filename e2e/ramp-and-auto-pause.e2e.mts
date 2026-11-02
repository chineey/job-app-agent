// Ramp and auto-pause scenarios, driven through the summary, send and inbox crons and the
// Telegram webhook on the production build. See docs/ramp-and-auto-pause.md.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  ADMIN_CHAT_ID,
  RAMP_STAGE_CAPS,
  repliesTo,
  resetDatabase,
  runCron,
  seedApplication,
  seedAttempt,
  seedUser,
  sendTelegramCommand,
  startApp,
  startFakeProviders,
  startPostgres,
  writeEvidence,
  type AppServer,
  type Database,
  type FakeProviders,
} from './harness.mts';

let db: Database;
let fake: FakeProviders;
let app: AppServer;
let evidence: Record<string, unknown>;


before(async () => {
  db = await startPostgres();
  fake = await startFakeProviders();
  app = await startApp(db.url);
});

after(async () => {
  await app?.stop();
  await fake?.close();
  await db?.stop();
});

beforeEach(async () => {
  await resetDatabase(db);
  fake.reset();
  evidence = {};
});

afterEach(async (t) => {
  const { rows: settings } = await db.pool.query(
    `select u.telegram_chat_id, s.dry_run, s.paused, s.ramp_stage, s.current_cap, s.dry_run_drafts_shown,
            s.ramp_stage_started_at, s.timezone
     from users u join user_settings s on s.user_id = u.id order by u.created_at`
  );
  const { rows: attempts } = await db.pool.query(
    `select a.state, a.recipient, a.reserved_at, app.status as application_status
     from send_attempts a join applications app on app.id = a.application_id order by a.reserved_at`
  );
  const { rows: events } = await db.pool.query(
    `select type, detail from events where type in ('auto_pause_triggered', 'ramp_stage_promoted') order by at`
  );
  writeEvidence('ramp-and-auto-pause', t.name, {
    scenario: t.name,
    ...evidence,
    final: { settings, attempts, events },
    gmail: { sendRequests: fake.sendRequests },
    telegram: fake.telegram,
    unexpectedProviderRequests: fake.unexpected,
    serverLogTail: app.log.slice(-40).join(''),
  });
});

/** A fixed-offset zone where the local time is now `hour` o'clock, so the 20:00 review runs. */
function zoneAtLocalHour(hour: number): string {
  const offset = ((hour - new Date().getUTCHours() + 36) % 24) - 12;
  // Etc/GMT names use the inverted POSIX sign: Etc/GMT-3 is three hours ahead of UTC.
  return offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

async function seedLiveUser(chatId: number, stage: number, stageStartedDaysAgo: number): Promise<string> {
  const userId = await seedUser(db, { chatId, cap: RAMP_STAGE_CAPS[stage] });
  await db.pool.query(
    `update user_settings
     set ramp_stage = $2, timezone = $3, ramp_stage_started_at = now() - make_interval(days => $4)
     where user_id = $1`,
    [userId, stage, zoneAtLocalHour(21), stageStartedDaysAgo]
  );
  return userId;
}

/** One application sent `daysAgo` days ago (in elapsed time), optionally bounced since. */
async function seedSentDaysAgo(userId: string, daysAgo: number, recipient: string, bounced = false): Promise<void> {
  const applicationId = await seedApplication(db, userId, { recipient, status: bounced ? 'bounced' : 'sent' });
  const attemptId = await seedAttempt(db, userId, applicationId, 'sent', recipient);
  await db.pool.query(
    `update send_attempts
     set reserved_at = now() - make_interval(days => $2), finished_at = now() - make_interval(days => $2)
     where id = $1`,
    [attemptId, daysAgo]
  );
  await db.pool.query('update applications set applied_at = now() - make_interval(days => $2) where id = $1', [applicationId, daysAgo]);
}

async function settingsOf(chatId: number) {
  const { rows } = await db.pool.query(
    `select s.* from user_settings s join users u on u.id = s.user_id where u.telegram_chat_id = $1`,
    [chatId]
  );
  return rows[0];
}

function pauseAlerts(chatId: number): string[] {
  return repliesTo(fake, chatId).filter((text) => text.includes('Sending paused automatically'));
}

function adminPauseAlerts(): string[] {
  return repliesTo(fake, ADMIN_CHAT_ID).filter((text) => text.includes('Auto-pause'));
}

describe('ramp and auto-pause', () => {
  it('a user is not promoted for days on which nothing was sent', async () => {
    await seedLiveUser(2001, 1, 5);

    evidence.summary = await runCron('summary');

    assert.ok(repliesTo(fake, 2001).some((text) => text.includes('Daily Application Summary')), 'the review ran');
    const settings = await settingsOf(2001);
    assert.deepEqual([settings.ramp_stage, settings.current_cap], [1, 3]);
  });

  it('a user is promoted after 3 active days without bounces or failures', async () => {
    const userId = await seedLiveUser(2001, 1, 4);
    await seedSentDaysAgo(userId, 0, 'jobs@day0.test');
    await seedSentDaysAgo(userId, 1, 'jobs@day1.test');
    await seedSentDaysAgo(userId, 2, 'jobs@day2.test');

    evidence.summary = await runCron('summary');

    const settings = await settingsOf(2001);
    assert.deepEqual([settings.ramp_stage, settings.current_cap], [2, 5]);
    assert.ok(repliesTo(fake, 2001).some((text) => text.includes('moved to ramp stage 2')));
  });

  it('a bounce in stage 1 blocks promotion', async () => {
    const userId = await seedLiveUser(2001, 1, 4);
    await seedSentDaysAgo(userId, 0, 'jobs@day0.test');
    await seedSentDaysAgo(userId, 1, 'jobs@day1.test', true);
    await seedSentDaysAgo(userId, 2, 'jobs@day2.test');

    evidence.summary = await runCron('summary');

    assert.equal((await settingsOf(2001)).ramp_stage, 1);
  });

  it('leaving dry run starts the stage clock', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });
    await db.pool.query(
      `update user_settings set dry_run = true, ramp_stage = 0, dry_run_drafts_shown = 5, ramp_stage_started_at = null
       where user_id = $1`,
      [userId]
    );
    await db.pool.query(
      `insert into facts_versions (user_id, source, facts, status) values ($1, 'seed', '{"years_experience": 3}', 'active')`,
      [userId]
    );

    await sendTelegramCommand(2001, '/dry off confirm');

    const { rows } = await db.pool.query(
      `select dry_run, ramp_stage, current_cap, ramp_stage_started_at > now() - interval '1 minute' as started_now
       from user_settings where user_id = $1`,
      [userId]
    );
    assert.deepEqual(rows[0], { dry_run: false, ramp_stage: 1, current_cap: 3, started_now: true });
  });

  it('/cap cannot exceed the stage cap, and sending obeys the stage cap', async () => {
    const userId = await seedLiveUser(2001, 1, 0);

    await sendTelegramCommand(2001, '/cap 20');
    assert.equal((await settingsOf(2001)).current_cap, 3);
    assert.match(repliesTo(fake, 2001).at(-1) ?? '', /at most 3/);
    await sendTelegramCommand(2001, '/cap 2');
    assert.equal((await settingsOf(2001)).current_cap, 2, 'lowering is allowed');

    // Even if current_cap is raised behind the ramp's back, sending stops at the stage cap.
    await db.pool.query('update user_settings set current_cap = 20 where user_id = $1', [userId]);
    for (const domain of ['one', 'two', 'three']) {
      await seedSentDaysAgo(userId, 0, `jobs@${domain}.test`);
    }
    await seedApplication(db, userId, { recipient: 'jobs@four.test' });
    evidence.sendRun = await runCron('send');
    assert.equal(fake.sendRequests, 0, 'a fourth send at stage 1 is refused');
  });

  it('three consecutive confirmed failures pause the user and alert user and admin', async () => {
    const userId = await seedLiveUser(2001, 2, 0);
    for (const domain of ['one', 'two', 'three', 'four']) {
      await seedApplication(db, userId, { recipient: `jobs@${domain}.test` });
    }
    fake.sendBehavior = 'reject_400';

    evidence.sendRun = await runCron('send');

    assert.equal(fake.sendRequests, 3, 'the fourth application is not attempted');
    assert.equal((await settingsOf(2001)).paused, true);
    assert.equal(pauseAlerts(2001).length, 1);
    assert.equal(adminPauseAlerts().length, 1);
  });

  it('a 403 from Gmail pauses the user', async () => {
    const userId = await seedLiveUser(2001, 2, 0);
    await seedApplication(db, userId, { recipient: 'jobs@one.test' });
    await seedApplication(db, userId, { recipient: 'jobs@two.test' });
    fake.sendBehavior = 'reject_403';

    evidence.sendRun = await runCron('send');

    assert.equal(fake.sendRequests, 1);
    assert.equal((await settingsOf(2001)).paused, true);
    assert.equal(pauseAlerts(2001).length, 1);
    assert.equal(adminPauseAlerts().length, 1);
  });

  it('a bounce rate over 5% pauses the user, even with only a few sends', async () => {
    const userId = await seedLiveUser(2001, 1, 2);
    await seedSentDaysAgo(userId, 0, 'jobs@gone.test');
    await seedSentDaysAgo(userId, 0, 'jobs@fine.test');
    await seedSentDaysAgo(userId, 1, 'jobs@also-fine.test');
    fake.bounces = [{ id: 'bounce-1', threadId: 'bounce-thread-1', snippet: 'Delivery to jobs@gone.test failed permanently' }];

    evidence.inboxRun = await runCron('inbox');

    const { rows } = await db.pool.query(`select status from applications where contact_email = 'jobs@gone.test'`);
    assert.equal(rows[0].status, 'bounced');
    assert.equal((await settingsOf(2001)).paused, true);
    assert.equal(pauseAlerts(2001).length, 1);
    assert.equal(adminPauseAlerts().length, 1);
  });

  it('dry run previews each application once', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });
    await db.pool.query('update user_settings set dry_run = true, ramp_stage = 0 where user_id = $1', [userId]);
    await seedApplication(db, userId, { recipient: 'jobs@preview.test' });

    // Claims last 10 minutes, so expire the first run's claim to let the second run see the row again.
    evidence.firstRun = await runCron('send');
    await db.pool.query(`update applications set locked_at = now() - interval '11 minutes'`);
    evidence.secondRun = await runCron('send');

    assert.equal(fake.sendRequests, 0);
    assert.equal(repliesTo(fake, 2001).filter((text) => text.includes('DRY RUN PREVIEW')).length, 1);
    assert.equal((await settingsOf(2001)).dry_run_drafts_shown, 1);
  });
});
