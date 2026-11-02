// Inbox scan and draft scenarios, driven through the inbox and follow-up crons on the production
// build against real Postgres and fake Gmail, Gemini and Telegram. See docs/inbox-and-drafts.md.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  repliesTo,
  resetDatabase,
  runCron,
  seedApplication,
  seedAttempt,
  seedUser,
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
  const { rows: applications } = await db.pool.query(
    `select contact_email, status, reply_type, reply_draft_id, followup_draft_id, last_inbound_message_id
     from applications order by created_at`
  );
  const { rows: users } = await db.pool.query(
    `select u.telegram_chat_id, u.gmail_status, s.paused from users u join user_settings s on s.user_id = u.id`
  );
  writeEvidence('inbox-and-drafts', t.name, {
    scenario: t.name,
    ...evidence,
    final: { applications, users },
    gmail: { sendRequests: fake.sendRequests, drafts: fake.drafts, threadFetches: fake.threadFetches },
    geminiCalls: fake.geminiCalls,
    telegram: fake.telegram,
    telegramRejectedForMarkup: fake.telegramRejected,
    unexpectedProviderRequests: fake.unexpected,
    serverLogTail: app.log.slice(-40).join(''),
  });
});

const FACTS = { identity: { name: 'Ada Synthetic' }, years_experience: 3, skills: { strong: ['TypeScript'] } };

async function seedUserWithFacts(chatId: number): Promise<{ userId: string; factsVersionId: number }> {
  const userId = await seedUser(db, { chatId, cap: 3 });
  const { rows } = await db.pool.query(
    `insert into facts_versions (user_id, source, facts, status) values ($1, 'seed', $2, 'active') returning id`,
    [userId, JSON.stringify(FACTS)]
  );
  return { userId, factsVersionId: rows[0].id };
}

/** An application sent `daysAgo` days ago, in its own Gmail thread. Returns the application id. */
async function seedSentInThread(
  userId: string,
  options: { recipient: string; threadId: string; daysAgo: number; factsVersionId?: number }
): Promise<string> {
  const applicationId = await seedApplication(db, userId, { recipient: options.recipient, status: 'sent' });
  await db.pool.query(
    `update applications
     set gmail_thread_id = $2, applied_at = now() - make_interval(days => $3), facts_version_id = $4
     where id = $1`,
    [applicationId, options.threadId, options.daysAgo, options.factsVersionId ?? null]
  );
  return applicationId;
}

async function statusOf(applicationId: string): Promise<string> {
  return (await db.pool.query('select status from applications where id = $1', [applicationId])).rows[0].status;
}

describe('inbox and drafts', () => {
  it('a recruiter reply is classified, drafted and alerted once; a later message is still seen', async () => {
    const { userId, factsVersionId } = await seedUserWithFacts(2001);
    const applicationId = await seedSentInThread(userId, { recipient: 'hr@acme.test', threadId: 'thread-acme', daysAgo: 1, factsVersionId });
    fake.threads['thread-acme'] = [
      { id: 'm-1', from: 'candidate2001@gmail.com', messageIdHeader: '<sent@gmail.com>', snippet: 'My application' },
      // An odd asterisk breaks Telegram Markdown, as untrusted text can.
      { id: 'm-2', from: 'Recruiter <hr@acme.test>', messageIdHeader: '<reply-1@acme.test>', snippet: 'Can you do a *call on Friday?' },
    ];

    evidence.firstRuns = [await runCron('inbox'), await runCron('inbox')];

    assert.equal(fake.geminiCalls, 2, 'one classification and one draft, not one per run');
    assert.equal(fake.drafts.length, 1);
    assert.deepEqual(fake.drafts[0], {
      threadId: 'thread-acme',
      to: 'Recruiter <hr@acme.test>',
      subject: 'Re: Application: Backend Engineer',
      inReplyTo: '<reply-1@acme.test>',
    });
    assert.equal(fake.sendRequests, 0, 'nothing is ever sent');
    assert.equal(await statusOf(applicationId), 'replied');
    const alerts = repliesTo(fake, 2001).filter((text) => text.includes('Recruiter Reply'));
    assert.equal(alerts.length, 1, 'alerted once');
    assert.ok(alerts[0].includes('*call on Friday'), 'the alert survives broken Markdown as plain text');

    fake.threads['thread-acme'].push({
      id: 'm-3',
      from: 'Recruiter <hr@acme.test>',
      messageIdHeader: '<reply-2@acme.test>',
      snippet: 'Following up on times',
    });
    // The thread was just checked; make it due again.
    await db.pool.query('update applications set thread_checked_at = null');
    await db.pool.query('update users set last_inbox_scan_at = null');
    evidence.laterRun = await runCron('inbox');

    assert.equal(fake.drafts.length, 2, 'the second recruiter message gets its own draft');
    assert.equal(fake.drafts[1].inReplyTo, '<reply-2@acme.test>');
  });

  it('threads are checked in rotation, not the same ten every run', async () => {
    const { userId } = await seedUserWithFacts(2001);
    for (let i = 1; i <= 12; i++) {
      await seedSentInThread(userId, { recipient: `jobs@company${i}.test`, threadId: `thread-${i}`, daysAgo: 1 });
    }

    evidence.runs = [await runCron('inbox'), await runCron('inbox')];

    assert.equal(Object.keys(fake.threadFetches).length, 12, 'every thread was checked within two runs');
  });

  it('a bounce marks only the application it belongs to', async () => {
    const { userId } = await seedUserWithFacts(2001);
    const bouncedEarlier = await seedSentInThread(userId, { recipient: 'x@acme.test', threadId: 'thread-old', daysAgo: 2 });
    // The bounce notice arrived a day ago; a new application to the same address went out today.
    fake.bounces = [
      {
        id: 'bounce-1',
        threadId: 'bounce-thread',
        snippet: 'Delivery to x@acme.test failed permanently',
        receivedAt: Date.now() - 24 * 60 * 60 * 1000,
      },
    ];
    const sentToday = await seedSentInThread(userId, { recipient: 'x@acme.test', threadId: 'thread-new', daysAgo: 0 });

    const firstRun = await runCron('inbox');
    await db.pool.query('update users set last_inbox_scan_at = null');
    evidence.runs = [firstRun, await runCron('inbox')];

    assert.equal(await statusOf(bouncedEarlier), 'bounced');
    assert.equal(await statusOf(sentToday), 'sent', 'a later send is not blamed for an old bounce');
  });

  it('losing Gmail access during a scan pauses the user and asks them to reconnect', async () => {
    await seedUserWithFacts(2001);
    fake.refreshFails = true;

    evidence.run = await runCron('inbox');

    const { rows } = await db.pool.query(
      `select u.gmail_status, s.paused from users u join user_settings s on s.user_id = u.id where u.telegram_chat_id = 2001`
    );
    assert.deepEqual(rows[0], { gmail_status: 'error', paused: true });
    assert.ok(repliesTo(fake, 2001).some((text) => text.includes('/connect')));
  });

  it('a follow-up draft threads on the original message, once, and only for active users', async () => {
    const active = await seedUserWithFacts(2001);
    const suspended = await seedUserWithFacts(2002);
    await db.pool.query(`update users set status = 'suspended' where id = $1`, [suspended.userId]);

    const followedUp = await seedSentInThread(active.userId, { recipient: 'hr@acme.test', threadId: 'thread-a', daysAgo: 8, factsVersionId: active.factsVersionId });
    const attemptId = await seedAttempt(db, active.userId, followedUp, 'sent', 'hr@acme.test');
    const originalMessageId = (await db.pool.query('select rfc_message_id from send_attempts where id = $1', [attemptId])).rows[0].rfc_message_id;
    await seedSentInThread(suspended.userId, { recipient: 'hr@other.test', threadId: 'thread-b', daysAgo: 8, factsVersionId: suspended.factsVersionId });

    evidence.runs = [await runCron('followups'), await runCron('followups')];

    assert.equal(fake.drafts.length, 1, 'one draft, only for the active user');
    assert.equal(fake.drafts[0].threadId, 'thread-a');
    assert.equal(fake.drafts[0].inReplyTo, originalMessageId);
    assert.equal(fake.sendRequests, 0);
  });
});
