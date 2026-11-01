// Send-safety scenarios. Each drives the real HTTP entry points of the production build
// (GET /api/cron/send, POST /api/telegram) against real Postgres and fake Google/Telegram.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  holdSendStateLock,
  resetDatabase,
  runSendCron,
  seedApplication,
  seedAttempt,
  seedSentToday,
  seedUser,
  sendTelegramCommand,
  startApp,
  startFakeProviders,
  startPostgres,
  waitFor,
  waitForLockWaiters,
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
  const { rows: attempts } = await db.pool.query(
    `select id, application_id, state, recipient, started_at is not null as started, gmail_message_id,
            reconcile_checks, resolved_by, error
     from send_attempts order by reserved_at`
  );
  const { rows: applications } = await db.pool.query(
    'select id, status, attempts, gmail_message_id from applications order by created_at'
  );
  writeEvidence(t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), {
    scenario: t.name,
    ...evidence,
    final: { attempts, applications },
    gmail: { sendRequests: fake.sendRequests, sent: fake.sent },
    telegram: fake.telegram,
    unexpectedProviderRequests: fake.unexpected,
    serverLogTail: app.log.slice(-40).join(''),
  });
});

async function attemptsFor(userId: string): Promise<Array<{ id: string; state: string; application_id: string }>> {
  const { rows } = await db.pool.query(
    `select id, state, application_id from send_attempts where user_id = $1 and body_hash <> 'seed' order by reserved_at`,
    [userId]
  );
  return rows;
}

async function statusOf(applicationId: string): Promise<string> {
  const { rows } = await db.pool.query('select status from applications where id = $1', [applicationId]);
  return rows[0].status;
}

async function waitForClaim(applicationId: string, claimToken: string | null = null): Promise<string> {
  let token = '';
  await waitFor(`claim on application ${applicationId}`, async () => {
    const { rows } = await db.pool.query('select claim_token from applications where id = $1', [applicationId]);
    token = rows[0].claim_token;
    return token !== null && token !== claimToken;
  });
  return token;
}

describe('send safety', () => {
  it('concurrent workers cannot both take the last daily slot', async () => {
    const userId = await seedUser(db, { chatId: 1001, cap: 3 });
    await seedSentToday(db, userId, 'a@earlier-one.test');
    await seedSentToday(db, userId, 'b@earlier-two.test');
    const first = await seedApplication(db, userId, { recipient: 'jobs@first.test' });

    // Both workers must reach authorization while each holds a different application.
    const gate = await holdSendStateLock(db, userId);
    const workerA = runSendCron();
    await waitForClaim(first);
    const second = await seedApplication(db, userId, { recipient: 'jobs@second.test' });
    const workerB = runSendCron();
    await waitForClaim(second);
    await waitForLockWaiters(db, 2);
    await gate.release();

    const responses = await Promise.all([workerA, workerB]);
    evidence.cronResponses = responses;

    assert.equal(fake.sendRequests, 1, 'Gmail must receive exactly one message');
    assert.equal((await attemptsFor(userId)).length, 1, 'exactly one reservation');
    assert.deepEqual([await statusOf(first), await statusOf(second)].sort(), ['sent', 'verified']);
    const { rows } = await db.pool.query(
      `select count(*)::int as used from send_attempts where user_id = $1 and state in ('reserved', 'sending', 'sent', 'send_unknown')`,
      [userId]
    );
    assert.equal(rows[0].used, 3, 'daily cap of 3 is never exceeded');
    // The same text is sent on every run; a cached fetch would swallow it from the second run on.
    const notices = fake.telegram.filter((m) => Number(m.chatId) === 1001 && m.text.includes('Application Sent!'));
    assert.equal(notices.length, 1, 'the candidate is told about the send');
  });

  it('a worker whose claim was taken over does not send', async () => {
    const userId = await seedUser(db, { chatId: 1001, cap: 3 });
    const applicationId = await seedApplication(db, userId, { recipient: 'jobs@stale.test' });

    const gate = await holdSendStateLock(db, userId);
    const staleWorker = runSendCron();
    const staleToken = await waitForClaim(applicationId);
    // The stale worker's lease expires while it waits; a second worker reclaims the row.
    await db.pool.query(`update applications set locked_at = now() - interval '11 minutes' where id = $1`, [applicationId]);
    const currentWorker = runSendCron();
    const currentToken = await waitForClaim(applicationId, staleToken);
    await waitForLockWaiters(db, 2);
    await gate.release();

    const responses = await Promise.all([staleWorker, currentWorker]);
    evidence.cronResponses = responses;
    evidence.claimTokens = { stale: staleToken, current: currentToken };

    assert.equal(fake.sendRequests, 1, 'Gmail must receive exactly one message');
    assert.equal((await attemptsFor(userId)).length, 1);
    assert.equal(await statusOf(applicationId), 'sent');
  });

  it('a 5xx after Gmail accepted is uncertain, never retried, and settled by reconciliation', async () => {
    const userId = await seedUser(db, { chatId: 1001, cap: 3 });
    const applicationId = await seedApplication(db, userId, { recipient: 'jobs@accepted.test' });
    fake.sendBehavior = 'accept_then_503';

    const firstRun = await runSendCron();
    const [attempt] = await attemptsFor(userId);
    assert.equal(attempt.state, 'send_unknown');
    assert.equal(await statusOf(applicationId), 'send_unknown');

    fake.sendBehavior = 'accept';
    const secondRun = await runSendCron();
    const thirdRun = await runSendCron();
    evidence.cronResponses = [firstRun, secondRun, thirdRun];

    assert.equal(fake.sendRequests, 1, 'the message must not be sent again');
    assert.equal(fake.sent[0].hasPdfAttachment, true, 'resume is attached');
    const [settled] = await attemptsFor(userId);
    assert.equal(settled.state, 'sent');
    assert.equal(await statusOf(applicationId), 'sent');
    assert.ok(fake.telegram.some((m) => Number(m.chatId) === 1001 && m.text.includes('Delivery Reconciled')));
  });

  it('a worker killed after Gmail accepted is settled by reconciliation without resending', async () => {
    const userId = await seedUser(db, { chatId: 1001, cap: 3 });
    const applicationId = await seedApplication(db, userId, { recipient: 'jobs@crash.test' });
    fake.sendBehavior = 'accept_then_hang';

    const doomedRun = runSendCron().catch((err: Error) => ({ crashed: err.message }));
    await waitFor('Gmail to accept the message', () => fake.sent.length === 1);
    await app.stop('SIGKILL');
    evidence.crashedRun = await doomedRun;

    const [stuck] = await attemptsFor(userId);
    assert.equal(stuck.state, 'sending', 'the crash leaves the attempt in sending');

    app = await startApp(db.url);
    fake.sendBehavior = 'accept';
    // Reconciliation only picks up 'sending' attempts older than 2 minutes; simulate that time passing.
    await db.pool.query(
      `update send_attempts set started_at = now() - interval '3 minutes', reserved_at = reserved_at - interval '3 minutes'
       where id = $1`,
      [stuck.id]
    );
    const recoveryRun = await runSendCron();
    const laterRun = await runSendCron();
    evidence.cronResponses = [recoveryRun, laterRun];

    assert.equal(fake.sendRequests, 1, 'the message must not be sent again');
    const [settled] = await attemptsFor(userId);
    assert.equal(settled.state, 'sent');
    assert.equal(await statusOf(applicationId), 'sent');
  });

  it('a definite 4xx rejection frees the slot without delivering', async () => {
    const userId = await seedUser(db, { chatId: 1001, cap: 3 });
    const applicationId = await seedApplication(db, userId, { recipient: 'jobs@rejected.test' });
    fake.sendBehavior = 'reject_400';

    evidence.cronResponses = [await runSendCron()];

    assert.equal(fake.sent.length, 0);
    const [attempt] = await attemptsFor(userId);
    assert.equal(attempt.state, 'failed');
    assert.equal(await statusOf(applicationId), 'ready');
    const { rows } = await db.pool.query('select active_attempt_id from send_state where user_id = $1', [userId]);
    assert.equal(rows[0].active_attempt_id, null);
  });

  it('/resolve only settles the caller’s own uncertain attempts', async () => {
    const owner = await seedUser(db, { chatId: 1001, cap: 3 });
    await seedUser(db, { chatId: 1002, cap: 3 });
    const uncertainApp = await seedApplication(db, owner, { recipient: 'jobs@uncertain.test', status: 'send_unknown' });
    const uncertain = await seedAttempt(db, owner, uncertainApp, 'send_unknown', 'jobs@uncertain.test');
    const sentApp = await seedApplication(db, owner, { recipient: 'jobs@delivered.test', status: 'sent' });
    const delivered = await seedAttempt(db, owner, sentApp, 'sent', 'jobs@delivered.test');

    await sendTelegramCommand(1002, `/resolve ${uncertain} notsent`);
    await sendTelegramCommand(1001, `/resolve ${delivered} notsent`);

    const state = async (id: string) =>
      (await db.pool.query('select state from send_attempts where id = $1', [id])).rows[0].state;
    assert.equal(await state(uncertain), 'send_unknown', 'another user cannot settle it');
    assert.equal(await statusOf(uncertainApp), 'send_unknown');
    assert.equal(await state(delivered), 'sent', 'a sent attempt cannot be reopened');
    assert.equal(await statusOf(sentApp), 'sent');
    assert.ok(fake.telegram.some((m) => Number(m.chatId) === 1002 && m.text.includes('not found')));

    await sendTelegramCommand(1001, `/resolve ${uncertain} notsent`);
    assert.equal(await state(uncertain), 'released');
    assert.equal(await statusOf(uncertainApp), 'ready');
  });
});
