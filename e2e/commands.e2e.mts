// User and admin command scenarios through the webhook, and send-pass isolation through the send
// cron, on the production build. See docs/commands.md.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  ADMIN_CHAT_ID,
  repliesTo,
  resetDatabase,
  runCron,
  seedApplication,
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
  const { rows: users } = await db.pool.query(
    `select u.telegram_chat_id, u.status, s.current_cap, s.max_cap, s.daily_read_cap, s.max_reads_ceiling
     from users u join user_settings s on s.user_id = u.id order by u.created_at`
  );
  const { rows: applications } = await db.pool.query(
    'select contact_email, status, imported from applications order by created_at'
  );
  writeEvidence('commands', t.name, {
    scenario: t.name,
    ...evidence,
    final: { users, applications },
    gmailSendRequests: fake.sendRequests,
    telegram: fake.telegram,
    unexpectedProviderRequests: fake.unexpected,
    serverLogTail: app.log.slice(-40).join(''),
  });
});

async function statusOf(applicationId: string): Promise<string> {
  return (await db.pool.query('select status from applications where id = $1', [applicationId])).rows[0].status;
}

async function settingsOf(chatId: number) {
  const { rows } = await db.pool.query(
    'select s.* from user_settings s join users u on u.id = s.user_id where u.telegram_chat_id = $1',
    [chatId]
  );
  return rows[0];
}

const lastReply = (chatId: number) => repliesTo(fake, chatId).at(-1) ?? '';

describe('commands', () => {
  it('/run by a user runs only the send pass', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });
    await seedApplication(db, userId, { recipient: 'jobs@acme.test', status: 'ready' });

    await sendTelegramCommand(2001, '/run');

    assert.equal(fake.sendRequests, 1, 'the ready application was sent');
    assert.match(lastReply(2001), /Send pass finished/);
    assert.ok(!repliesTo(fake, 2001).some((text) => text.includes('Ingest')), 'no shared ingest for a user');
  });

  it('/reads stays within the admin ceiling', async () => {
    await seedUser(db, { chatId: 2001, cap: 3 });

    await sendTelegramCommand(2001, '/reads 500');
    assert.equal((await settingsOf(2001)).daily_read_cap, 50, 'default unchanged');
    await sendTelegramCommand(2001, '/reads 80');
    assert.equal((await settingsOf(2001)).daily_read_cap, 80);
  });

  it('/skip only skips the user’s own application before it is reserved', async () => {
    const owner = await seedUser(db, { chatId: 2001, cap: 3 });
    const other = await seedUser(db, { chatId: 2002, cap: 3 });
    const ready = await seedApplication(db, owner, { recipient: 'jobs@one.test', status: 'ready' });
    const sent = await seedApplication(db, owner, { recipient: 'jobs@two.test', status: 'sent' });
    const othersReady = await seedApplication(db, other, { recipient: 'jobs@three.test', status: 'ready' });

    await sendTelegramCommand(2001, `/skip ${othersReady}`);
    await sendTelegramCommand(2001, `/skip ${sent}`);
    await sendTelegramCommand(2001, `/skip ${ready}`);

    assert.equal(await statusOf(othersReady), 'ready');
    assert.equal(await statusOf(sent), 'sent');
    assert.equal(await statusOf(ready), 'skipped');

    evidence.sendRun = await runCron('send');
    assert.equal(fake.sendRequests, 1, "only the other user's application is sent");
  });

  it('/import records each past recipient once and reports invalid entries', async () => {
    await seedUser(db, { chatId: 2001, cap: 3 });

    await sendTelegramCommand(2001, '/import past@acme.test PAST@acme.test not-an-email');
    assert.match(lastReply(2001), /Imported 1 past recipient\(s\); 0 already known\.\nNot valid addresses: not-an-email/);
    await sendTelegramCommand(2001, '/import past@acme.test');
    assert.match(lastReply(2001), /Imported 0 past recipient\(s\); 1 already known/);

    const { rows } = await db.pool.query('select count(*)::int as count from applications where imported');
    assert.equal(rows[0].count, 1);
  });

  it('/last shows only the user’s own sends', async () => {
    const owner = await seedUser(db, { chatId: 2001, cap: 3 });
    const other = await seedUser(db, { chatId: 2002, cap: 3 });
    for (const [userId, email] of [[owner, 'mine@acme.test'], [other, 'theirs@acme.test']]) {
      const id = await seedApplication(db, userId, { recipient: email, status: 'sent' });
      await db.pool.query(`update applications set applied_at = now(), route = 'email' where id = $1`, [id]);
    }

    await sendTelegramCommand(2001, '/last');

    assert.ok(lastReply(2001).includes('mine@acme.test'));
    assert.ok(!lastReply(2001).includes('theirs@acme.test'));
  });

  it('admin suspension, limits and X caps are validated', async () => {
    await seedUser(db, { chatId: ADMIN_CHAT_ID, cap: 3 });
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });
    const pending = await seedApplication(db, userId, { recipient: 'jobs@acme.test', status: 'ready' });

    await sendTelegramCommand(ADMIN_CHAT_ID, '/suspend not-an-id');
    assert.match(lastReply(ADMIN_CHAT_ID), /Usage/);
    await sendTelegramCommand(ADMIN_CHAT_ID, '/suspend 00000000-0000-4000-8000-000000000000');
    assert.match(lastReply(ADMIN_CHAT_ID), /No active user/);
    await sendTelegramCommand(ADMIN_CHAT_ID, `/suspend ${userId}`);
    evidence.sendWhileSuspended = await runCron('send');
    assert.equal(fake.sendRequests, 0, 'a suspended user sends nothing');
    assert.equal(await statusOf(pending), 'ready');
    await sendTelegramCommand(ADMIN_CHAT_ID, `/unsuspend ${userId}`);
    assert.equal((await db.pool.query('select status from users where id = $1', [userId])).rows[0].status, 'active');

    await sendTelegramCommand(ADMIN_CHAT_ID, `/limits ${userId} cap 25 reads 50`);
    assert.match(lastReply(ADMIN_CHAT_ID), /Usage/);
    await sendTelegramCommand(ADMIN_CHAT_ID, `/limits ${userId} cap 2 reads 40`);
    const limited = await settingsOf(2001);
    assert.deepEqual([limited.max_cap, limited.current_cap, limited.max_reads_ceiling, limited.daily_read_cap], [2, 2, 40, 40]);

    await sendTelegramCommand(ADMIN_CHAT_ID, '/admin xreads 500');
    await sendTelegramCommand(ADMIN_CHAT_ID, '/admin xreads 120');
    const { rows } = await db.pool.query(`select value from global_settings where key = 'x_daily_read_cap'`);
    assert.equal(rows[0].value, '120');
  });

  it('one application’s unexpected error does not stop the send pass for others', async () => {
    const broken = await seedUser(db, { chatId: 2001, cap: 3 });
    const healthy = await seedUser(db, { chatId: 2002, cap: 3 });
    // A zone Postgres does not know makes that user's cap query throw.
    await db.pool.query(`update user_settings set timezone = 'Mars/Olympus' where user_id = $1`, [broken]);
    await seedApplication(db, broken, { recipient: 'jobs@broken.test', status: 'ready' });
    const healthyApp = await seedApplication(db, healthy, { recipient: 'jobs@healthy.test', status: 'ready' });

    const run = await runCron('send');
    evidence.sendRun = run;

    assert.equal(run.errors, 1);
    assert.equal(fake.sendRequests, 1);
    assert.equal(await statusOf(healthyApp), 'sent');
  });
});
