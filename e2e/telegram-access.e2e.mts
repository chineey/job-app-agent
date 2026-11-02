// Telegram access and onboarding scenarios, driven through POST /api/telegram on the production
// build against real Postgres and a fake Telegram. See docs/telegram-access.md.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  ADMIN_CHAT_ID,
  holdRowLock,
  postTelegramUpdate,
  repliesTo,
  resetDatabase,
  seedUser,
  sendTelegramCommand,
  startApp,
  startFakeProviders,
  startPostgres,
  telegramUpdate,
  waitForLockWaiters,
  writeEvidence,
  type AppServer,
  type Database,
  type FakeProviders,
} from './harness.mts';

let db: Database;
let fake: FakeProviders;
let app: AppServer;

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
});

afterEach(async (t) => {
  const { rows: users } = await db.pool.query(
    `select u.telegram_chat_id, u.role, u.status, u.consent_version, s.dry_run, s.paused, s.timezone
     from users u left join user_settings s on s.user_id = u.id order by u.created_at`
  );
  const { rows: invites } = await db.pool.query('select code, uses, max_uses from invites order by created_at');
  const { rows: globalSettings } = await db.pool.query(`select key, value from global_settings where key = 'global_paused'`);
  writeEvidence('telegram-access', t.name, {
    scenario: t.name,
    final: { users, invites, globalSettings },
    telegram: fake.telegram,
    unexpectedProviderRequests: fake.unexpected,
    serverLogTail: app.log.slice(-40).join(''),
  });
});

async function userByChat(chatId: number) {
  const { rows } = await db.pool.query(
    `select u.id, u.role, u.status, u.consent_version, s.dry_run, s.paused, s.timezone
     from users u left join user_settings s on s.user_id = u.id where u.telegram_chat_id = $1`,
    [chatId]
  );
  return rows[0];
}

async function inviteUses(code: string): Promise<number> {
  const { rows } = await db.pool.query('select uses from invites where code = $1', [code]);
  return rows[0].uses;
}

async function createInvite(code: string): Promise<void> {
  await db.pool.query('insert into invites (code, max_uses) values ($1, 1)', [code]);
}

async function globalPaused(): Promise<string> {
  const { rows } = await db.pool.query(`select value from global_settings where key = 'global_paused'`);
  return rows[0].value;
}

describe('telegram access', () => {
  it('admin bootstraps, invites a user who joins, agrees, checks status and pauses', async () => {
    await sendTelegramCommand(ADMIN_CHAT_ID, '/start');
    await sendTelegramCommand(ADMIN_CHAT_ID, '/agree');
    assert.deepEqual(
      { role: (await userByChat(ADMIN_CHAT_ID)).role, status: (await userByChat(ADMIN_CHAT_ID)).status },
      { role: 'admin', status: 'active' }
    );

    await sendTelegramCommand(ADMIN_CHAT_ID, '/invite');
    const code = /`([0-9A-F]{8})`/.exec(repliesTo(fake, ADMIN_CHAT_ID).at(-1) ?? '')?.[1];
    assert.ok(code, 'the admin receives an invite code');

    await sendTelegramCommand(2001, `/start ${code}`);
    assert.match(repliesTo(fake, 2001).at(-1) ?? '', /Privacy & Security Notice/);
    await sendTelegramCommand(2001, '/status');
    assert.match(repliesTo(fake, 2001).at(-1) ?? '', /accept the Privacy Notice/, 'commands wait for consent');
    assert.equal((await userByChat(2001)).status, 'pending');

    await sendTelegramCommand(2001, '/agree');
    const joined = await userByChat(2001);
    assert.equal(joined.status, 'active');
    assert.equal(joined.consent_version, 'v3.2');
    assert.equal(joined.dry_run, true, 'new users start in dry run');
    assert.equal(await inviteUses(code), 1);

    await sendTelegramCommand(2001, '/status');
    assert.match(repliesTo(fake, 2001).at(-1) ?? '', /Your Status Overview[\s\S]*Dry Run:\* `ON`/);

    await sendTelegramCommand(2001, '/pause');
    assert.equal((await userByChat(2001)).paused, true);
    await sendTelegramCommand(2001, '/resume');
    assert.equal((await userByChat(2001)).paused, false);
  });

  it('a single-use invite admits only one of two concurrent chats', async () => {
    await createInvite('RACE0001');

    const gate = await holdRowLock(db, 'select 1 from invites where code = $1 for update', ['RACE0001']);
    const first = postTelegramUpdate(telegramUpdate(3001, '/start RACE0001'));
    const second = postTelegramUpdate(telegramUpdate(3002, '/start RACE0001'));
    try {
      await waitForLockWaiters(db, 2);
    } finally {
      await gate.release();
    }
    assert.deepEqual(await Promise.all([first, second]), [200, 200]);

    const registered = [await userByChat(3001), await userByChat(3002)].filter(Boolean);
    assert.equal(registered.length, 1, 'exactly one chat registered');
    assert.equal(await inviteUses('RACE0001'), 1);
    const replies = [...repliesTo(fake, 3001), ...repliesTo(fake, 3002)];
    assert.ok(replies.some((text) => text.includes('already been used')));
  });

  it('a redelivered update runs only once', async () => {
    await seedUser(db, { chatId: ADMIN_CHAT_ID, cap: 3 });
    const update = telegramUpdate(ADMIN_CHAT_ID, '/invite');

    assert.equal(await postTelegramUpdate(update), 200);
    assert.equal(await postTelegramUpdate(update), 200);

    const { rows } = await db.pool.query('select count(*)::int as count from invites');
    assert.equal(rows[0].count, 1, 'one invite, not two');
  });

  it('group chats are ignored', async () => {
    await createInvite('GROUP001');

    const status = await postTelegramUpdate(telegramUpdate(-100500, '/start GROUP001', { chatType: 'group' }));

    assert.equal(status, 200);
    assert.equal(await userByChat(-100500), undefined, 'the group is not registered');
    assert.equal(await inviteUses('GROUP001'), 0);
    assert.equal(fake.telegram.length, 0);
  });

  it('only the admin can run admin commands', async () => {
    await seedUser(db, { chatId: ADMIN_CHAT_ID, cap: 3 });
    await seedUser(db, { chatId: 2001, cap: 3 });
    await db.pool.query(`update global_settings set value = 'true' where key = 'global_paused'`);

    await sendTelegramCommand(2001, '/admin_resumeall');
    await sendTelegramCommand(2001, '/admin resumeall');
    await sendTelegramCommand(2001, '/invite');

    assert.equal(await globalPaused(), 'true', "a user cannot lift the admin's emergency pause");
    const { rows } = await db.pool.query('select count(*)::int as count from invites');
    assert.equal(rows[0].count, 0);
    assert.equal(repliesTo(fake, 2001).filter((text) => text.includes('only available to the administrator')).length, 3);

    await sendTelegramCommand(ADMIN_CHAT_ID, '/admin resumeall');
    assert.equal(await globalPaused(), 'false', 'the admin still can');
  });

  it('dry run cannot be skipped with confirm', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });
    await db.pool.query('update user_settings set dry_run = true, dry_run_drafts_shown = 0 where user_id = $1', [userId]);

    await sendTelegramCommand(2001, '/dry off confirm');

    assert.equal((await userByChat(2001)).dry_run, true);
    assert.match(repliesTo(fake, 2001).at(-1) ?? '', /Cannot Exit Dry Run Yet/);
  });

  it('an unknown timezone is rejected and a valid one is stored canonically', async () => {
    await seedUser(db, { chatId: 2001, cap: 3 });

    await sendTelegramCommand(2001, '/timezone Mars/Olympus');
    assert.equal((await userByChat(2001)).timezone, 'UTC');

    await sendTelegramCommand(2001, '/timezone africa/lagos');
    assert.equal((await userByChat(2001)).timezone, 'Africa/Lagos');
  });

  it('the webhook rejects a missing or wrong secret', async () => {
    await createInvite('SECRET01');

    assert.equal(await postTelegramUpdate(telegramUpdate(2001, '/start SECRET01'), null), 401);
    assert.equal(await postTelegramUpdate(telegramUpdate(2001, '/start SECRET01'), 'wrong-secret'), 401);

    assert.equal(await userByChat(2001), undefined);
    assert.equal(await inviteUses('SECRET01'), 0);
  });
});
