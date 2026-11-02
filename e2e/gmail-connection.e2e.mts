// Gmail connection and secret-handling scenarios: /connect, the OAuth start and callback routes,
// /disconnect and /delete_me, and how the app behaves with unsafe configuration.
// See docs/gmail-connection.md.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  FULL_GMAIL_SCOPE,
  decryptStoredToken,
  getApp,
  holdRowLock,
  postTelegramUpdate,
  refreshTokenFor,
  repliesTo,
  resetDatabase,
  seedApplication,
  seedAttempt,
  seedUser,
  seededRefreshToken,
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
  // Token columns are reduced to whether they are set: evidence must never hold a token.
  const { rows: users } = await db.pool.query(
    `select telegram_chat_id, status, gmail_address, gmail_status, gmail_refresh_token_enc is not null as has_token
     from users order by created_at`
  );
  const { rows: oauthStates } = await db.pool.query('select used, expires_at > now() as live from oauth_states');
  writeEvidence('gmail-connection', t.name, {
    scenario: t.name,
    ...evidence,
    final: { users, oauthStates },
    revokeRequests: fake.revokedTokens.length,
    telegram: fake.telegram,
    unexpectedProviderRequests: fake.unexpected,
    serverLogTail: app.log.slice(-40).join(''),
  });
});

async function gmailOf(chatId: number) {
  const { rows } = await db.pool.query(
    'select status, gmail_address, gmail_status, gmail_refresh_token_enc from users where telegram_chat_id = $1',
    [chatId]
  );
  return rows[0];
}

/** A registered, active user who has not connected Gmail yet. */
async function seedDisconnectedUser(chatId: number): Promise<string> {
  const userId = await seedUser(db, { chatId, cap: 3 });
  await db.pool.query(
    `update users set gmail_address = null, gmail_refresh_token_enc = null, gmail_status = 'disconnected' where id = $1`,
    [userId]
  );
  return userId;
}

async function requestConnectState(chatId: number): Promise<string> {
  await sendTelegramCommand(chatId, '/connect');
  const state = /state=([0-9a-f-]{36})/.exec(repliesTo(fake, chatId).at(-1) ?? '')?.[1];
  assert.ok(state, 'the user receives a connect link');
  return state;
}

function callback(state: string, code: string): Promise<Response> {
  return getApp(`/api/oauth/gmail/callback?code=${encodeURIComponent(code)}&state=${state}`);
}

describe('gmail connection', () => {
  it('connect stores an encrypted token for the granted address', async () => {
    await seedDisconnectedUser(2001);
    const state = await requestConnectState(2001);

    const start = await getApp(`/api/oauth/gmail/start?state=${state}`);
    const consentUrl = new URL(start.headers.get('location') ?? '');
    evidence.consentUrl = `${consentUrl.origin}${consentUrl.pathname}`;
    assert.equal(start.status, 307);
    assert.equal(consentUrl.searchParams.get('state'), state);
    assert.equal(consentUrl.searchParams.get('access_type'), 'offline');
    assert.equal(consentUrl.searchParams.get('scope'), FULL_GMAIL_SCOPE);

    fake.oauthGrant.emailAddress = 'jobseeker@gmail.com';
    const res = await callback(state, 'code-1');
    assert.equal(res.status, 200);

    const stored = await gmailOf(2001);
    assert.equal(stored.gmail_address, 'jobseeker@gmail.com');
    assert.equal(stored.gmail_status, 'connected');
    assert.ok(!stored.gmail_refresh_token_enc.includes(refreshTokenFor('code-1')), 'never stored in plaintext');
    assert.equal(decryptStoredToken(stored.gmail_refresh_token_enc), refreshTokenFor('code-1'));
    assert.ok(repliesTo(fake, 2001).some((text) => text.includes('Gmail Connected Successfully')));
  });

  it('a connect link works once, even when two callbacks race', async () => {
    await seedDisconnectedUser(2001);
    const state = await requestConnectState(2001);

    const gate = await holdRowLock(db, 'select 1 from oauth_states where state = $1 for update', [state]);
    const first = callback(state, 'code-a');
    const second = callback(state, 'code-b');
    try {
      await waitForLockWaiters(db, 2);
    } finally {
      await gate.release();
    }
    const statuses = (await Promise.all([first, second])).map((res) => res.status).sort();
    evidence.callbackStatuses = statuses;
    assert.deepEqual(statuses, [200, 400], 'exactly one callback connects');

    const userId = (await db.pool.query('select id from users where telegram_chat_id = 2001')).rows[0].id;
    await db.pool.query(
      `insert into oauth_states (state, user_id, expires_at) values ('00000000-0000-4000-8000-000000000000', $1, now() - interval '1 minute')`,
      [userId]
    );
    assert.equal((await callback('00000000-0000-4000-8000-000000000000', 'code-c')).status, 400, 'an expired link is refused');
  });

  it('a grant without the send scope is refused and nothing is stored', async () => {
    await seedDisconnectedUser(2001);
    const state = await requestConnectState(2001);
    fake.oauthGrant.scope = FULL_GMAIL_SCOPE.replace('https://www.googleapis.com/auth/gmail.send', '').trim();

    assert.equal((await callback(state, 'code-1')).status, 400);

    const stored = await gmailOf(2001);
    assert.equal(stored.gmail_status, 'disconnected');
    assert.equal(stored.gmail_refresh_token_enc, null);
    assert.match(repliesTo(fake, 2001).at(-1) ?? '', /did not grant every permission/);
  });

  it('an address already connected to another user is refused', async () => {
    await seedUser(db, { chatId: 2001, cap: 3 }); // connected as candidate2001@gmail.com
    await seedDisconnectedUser(2002);
    const state = await requestConnectState(2002);
    fake.oauthGrant.emailAddress = 'Candidate2001@gmail.com';

    assert.equal((await callback(state, 'code-1')).status, 409);

    assert.equal((await gmailOf(2002)).gmail_status, 'disconnected');
    assert.equal((await gmailOf(2001)).gmail_address, 'candidate2001@gmail.com');
  });

  it('switching address is refused while a send is unconfirmed; reconnecting the same address works', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });
    const applicationId = await seedApplication(db, userId, { recipient: 'jobs@open.test', status: 'send_unknown' });
    await seedAttempt(db, userId, applicationId, 'send_unknown', 'jobs@open.test');

    fake.oauthGrant.emailAddress = 'someone-else@gmail.com';
    assert.equal((await callback(await requestConnectState(2001), 'code-1')).status, 409);
    assert.equal((await gmailOf(2001)).gmail_address, 'candidate2001@gmail.com');

    fake.oauthGrant.emailAddress = 'candidate2001@gmail.com';
    assert.equal((await callback(await requestConnectState(2001), 'code-2')).status, 200);
    assert.equal(decryptStoredToken((await gmailOf(2001)).gmail_refresh_token_enc), refreshTokenFor('code-2'));
  });

  it('/disconnect revokes the real token with Google, then deletes it', async () => {
    await seedUser(db, { chatId: 2001, cap: 3 });

    await sendTelegramCommand(2001, '/disconnect');

    assert.deepEqual(fake.revokedTokens, [seededRefreshToken(2001)], 'Google receives the plaintext refresh token');
    const stored = await gmailOf(2001);
    assert.deepEqual(
      [stored.gmail_status, stored.gmail_address, stored.gmail_refresh_token_enc],
      ['disconnected', null, null]
    );
    assert.match(repliesTo(fake, 2001).at(-1) ?? '', /revoked with Google/);
  });

  it('/delete_me revokes the real token with Google', async () => {
    await seedUser(db, { chatId: 2001, cap: 3 });

    await sendTelegramCommand(2001, '/delete_me confirm');

    assert.deepEqual(fake.revokedTokens, [seededRefreshToken(2001)]);
    const stored = await gmailOf(2001);
    assert.equal(stored.status, 'deleted');
    assert.equal(stored.gmail_refresh_token_enc, null);
  });

  it('unsafe configuration fails closed', async () => {
    await app.stop();
    app = await startApp(db.url, {
      CRON_SECRET: undefined,
      TELEGRAM_WEBHOOK_SECRET: undefined,
      TOKEN_ENCRYPTION_KEY: 'password',
    });
    try {
      assert.equal((await getApp('/api/cron/send', { authorization: 'Bearer ' })).status, 401, 'no cron secret, no cron');
      assert.equal(await postTelegramUpdate(telegramUpdate(2001, '/status'), ''), 401, 'no webhook secret, no webhook');

      const userId = await seedDisconnectedUser(2001);
      await db.pool.query(
        `insert into oauth_states (state, user_id, expires_at) values ('00000000-0000-4000-8000-000000000001', $1, now() + interval '10 minutes')`,
        [userId]
      );
      assert.equal((await callback('00000000-0000-4000-8000-000000000001', 'code-1')).status, 500, 'a weak key stores nothing');
      const stored = await gmailOf(2001);
      assert.equal(stored.gmail_status, 'disconnected');
      assert.equal(stored.gmail_refresh_token_enc, null);
    } finally {
      await app.stop();
      app = await startApp(db.url);
    }
  });
});
