// Link application scenarios: cards sent through the send cron, /links and /done through the
// webhook, on the production build. See docs/link-applications.md.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  RESUME_URL,
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
  const { rows: applications } = await db.pool.query(
    `select route, status, link_notified_at is not null as notified, link_reminded_at is not null as reminded
     from applications order by created_at`
  );
  writeEvidence('link-applications', t.name, {
    scenario: t.name,
    ...evidence,
    final: { applications },
    telegram: fake.telegram,
    telegramDocuments: fake.telegramDocuments,
    gmailSendRequests: fake.sendRequests,
    unexpectedProviderRequests: fake.unexpected,
    serverLogTail: app.log.slice(-40).join(''),
  });
});

let nextPost = 1;

/** A waiting link application for a job whose deadline is `deadlineInDays` from today (null: none). */
async function seedLinkApplication(
  userId: string,
  options: { company: string; deadlineInDays: number | null; coverNote?: string; notifiedDaysAgo?: number }
): Promise<string> {
  const postId = `post-${nextPost++}`;
  const { rows: jobs } = await db.pool.query(
    `insert into jobs (post_id, post_url, raw_text, role, company, remote, apply_method, apply_link, apply_link_domain, deadline)
     values ($1, $2, 'Synthetic post', 'Backend Engineer', $3, true, 'link', $4, $5,
             case when $6::int is null then null else current_date + $6::int end)
     returning id`,
    [postId, `https://x.com/synthetic/status/${postId}`, options.company, `https://apply.${options.company}.test/jobs/1`, `apply.${options.company}.test`, options.deadlineInDays]
  );
  const applicationId = await seedApplication(db, userId, { recipient: 'unused@example.test', status: 'link_ready' });
  await db.pool.query(
    `update applications
     set route = 'link', job_id = $2, contact_email = null, cover_note = $3, resume_blob_url = $4,
         link_notified_at = case when $5::int is null then null else now() - make_interval(days => $5::int) end
     where id = $1`,
    [applicationId, jobs[0].id, options.coverNote ?? 'I would love to help with your backend.', RESUME_URL, options.notifiedDaysAgo ?? null]
  );
  return applicationId;
}

async function statusOf(applicationId: string): Promise<string> {
  return (await db.pool.query('select status from applications where id = $1', [applicationId])).rows[0].status;
}

describe('link applications', () => {
  it('a link application is sent to its user once, with the apply domain and resume, even when the card is long', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });
    // Longer than Telegram's 1024-character caption limit once it is in a card.
    const applicationId = await seedLinkApplication(userId, { company: 'acme', deadlineInDays: 10, coverNote: 'x'.repeat(900) });

    evidence.runs = [await runCron('send'), await runCron('send')];

    const cards = repliesTo(fake, 2001).filter((text) => text.includes('New Job Opportunity'));
    assert.equal(cards.length, 1, 'one card, not one per run');
    assert.ok(cards[0].includes('`apply.acme.test`'), 'the apply domain is shown on its own');
    assert.ok(cards[0].includes(`/done ${applicationId}`));
    assert.equal(fake.telegramDocuments.length, 1, 'the resume is attached once');
    assert.equal(fake.telegramDocuments[0].filename, 'acme_Resume.pdf');
    assert.equal(fake.sendRequests, 0, 'nothing is sent from Gmail for a link application');
  });

  it('/done only marks the user’s own waiting link application', async () => {
    const owner = await seedUser(db, { chatId: 2001, cap: 3 });
    await seedUser(db, { chatId: 2002, cap: 3 });
    const linkApp = await seedLinkApplication(owner, { company: 'acme', deadlineInDays: 10, notifiedDaysAgo: 1 });
    const emailApp = await seedApplication(db, owner, { recipient: 'hr@email.test', status: 'ready' });

    await sendTelegramCommand(2002, `/done ${linkApp}`);
    await sendTelegramCommand(2001, `/done ${emailApp}`);
    assert.equal(await statusOf(linkApp), 'link_ready', 'another user cannot mark it');
    assert.equal(await statusOf(emailApp), 'ready', 'an email application cannot be marked applied manually');

    await sendTelegramCommand(2001, `/done ${linkApp}`);
    assert.equal(await statusOf(linkApp), 'applied_manually');
  });

  it('/links lists waiting link applications, soonest deadline first', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });
    await seedLinkApplication(userId, { company: 'later', deadlineInDays: 20, notifiedDaysAgo: 1 });
    await seedLinkApplication(userId, { company: 'sooner', deadlineInDays: 5, notifiedDaysAgo: 1 });
    await seedLinkApplication(userId, { company: 'open', deadlineInDays: null, notifiedDaysAgo: 1 });

    await sendTelegramCommand(2001, '/links');

    const list = repliesTo(fake, 2001).at(-1) ?? '';
    const order = ['sooner', 'later', 'open'].map((company) => list.indexOf(`apply.${company}.test`));
    assert.ok(order.every((index) => index >= 0), 'all three are listed');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'soonest deadline first, none last');
  });

  it('one reminder when the deadline is under 48 hours away, only for cards sent before that', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });
    await seedLinkApplication(userId, { company: 'early', deadlineInDays: 1, notifiedDaysAgo: 5 });
    await seedLinkApplication(userId, { company: 'late', deadlineInDays: 1 });

    evidence.runs = [await runCron('send'), await runCron('send')];

    const reminders = repliesTo(fake, 2001).filter((text) => text.includes('Deadline in under 48 hours'));
    assert.equal(reminders.length, 1, 'one reminder, for the card sent days ago');
    const lateCard = repliesTo(fake, 2001).find((text) => text.includes('apply.late.test'));
    assert.ok(lateCard?.includes('DEADLINE URGENT'), 'a card sent inside the window is marked urgent instead');
  });
});
