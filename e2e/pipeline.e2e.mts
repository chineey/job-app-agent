// Whole-pipeline scenarios: Dev A's ingest and process crons feeding Dev B's send cron, on the
// production build with fake X, Gemini, Blob, Gmail and Telegram. Dev A's MX gate does a real DNS
// lookup, so the contact address uses a domain with mail servers; nothing is ever sent to it.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  repliesTo,
  resetDatabase,
  runCron,
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

const CONTACT = 'acme.hiring.e2e.synthetic@gmail.com';

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
  const { rows: jobs } = await db.pool.query(
    'select post_id, status, status_reason, apply_method, contact_email, address_mx_ok, author_handle from jobs order by post_id'
  );
  const { rows: applications } = await db.pool.query(
    'select status, status_reason, route, fit_score, resume_source, resume_blob_url is not null as has_resume from applications'
  );
  writeEvidence('pipeline', t.name, {
    scenario: t.name,
    ...evidence,
    final: { jobs, applications },
    xSearches: fake.xSearches,
    geminiCalls: fake.geminiCalls,
    blobs: Object.keys(fake.blobs),
    gmail: { sendRequests: fake.sendRequests, sent: fake.sent },
    telegram: fake.telegram,
    unexpectedProviderRequests: fake.unexpected,
    serverLogTail: app.log.slice(-60).join(''),
  });
});

const FACTS = {
  identity: { name: 'Ada Synthetic', email: 'ada@example.test', phone: '', location: 'Lagos', links: { github: '', linkedin: '', portfolio: '' } },
  years_experience: 4,
  open_to_relocation: false,
  education: [],
  certs: [],
  experience: [],
  projects: [
    {
      id: 'p1',
      name: 'Payments API',
      one_liner: 'Idempotent payments API',
      stack: ['TypeScript', 'Postgres'],
      email_note: '',
      bullets: [{ id: 'p1-b1', text: 'Built a payments API in TypeScript and Postgres with safe retries.' }],
    },
  ],
  skills: { strong: ['TypeScript', 'Postgres'], working: [], known_gaps: [] },
  fixed_priority: [],
  gap_framing: '',
};

/** A user with accepted facts, in dry run unless `live`. */
async function seedCandidate(chatId: number, live: boolean): Promise<string> {
  const userId = await seedUser(db, { chatId, cap: 3 });
  await db.pool.query(
    `insert into facts_versions (user_id, source, facts, status, years_confirmed) values ($1, 'seed', $2, 'active', true)`,
    [userId, JSON.stringify(FACTS)]
  );
  if (!live) {
    await db.pool.query('update user_settings set dry_run = true, ramp_stage = 0 where user_id = $1', [userId]);
  }
  return userId;
}

function hiringPost(id: string): { id: string; text: string; author_id: string; conversation_id: string } {
  return {
    id,
    text: `We are hiring a Backend Engineer at Acme (remote). TypeScript and Postgres. Send your CV to ${CONTACT}`,
    author_id: '777',
    conversation_id: id,
  };
}

async function applicationStatuses(): Promise<string[]> {
  const { rows } = await db.pool.query('select status from applications order by created_at');
  return rows.map((row) => row.status);
}

describe('pipeline', () => {
  it('a hiring post becomes a dry-run preview for an eligible user', async () => {
    await seedCandidate(2001, false);
    fake.xPosts = [hiringPost('1000')];

    evidence.ingest = await runCron('ingest');
    evidence.process = await runCron('process');
    assert.deepEqual(await applicationStatuses(), ['ready'], 'the application went through match, tailor and verify');
    assert.equal(Object.keys(fake.blobs).length, 1, 'a tailored resume was rendered and stored');
    assert.equal(Object.values(fake.blobs)[0].subarray(0, 5).toString('latin1'), '%PDF-');

    evidence.send = await runCron('send');
    assert.ok(repliesTo(fake, 2001).some((text) => text.includes('DRY RUN PREVIEW')), 'the user sees the preview');
    assert.equal(fake.sendRequests, 0);
  });

  it('a live user’s application is sent once, with the generated resume attached', async () => {
    await seedCandidate(2001, true);
    fake.xPosts = [hiringPost('1000')];

    evidence.runs = [await runCron('ingest'), await runCron('process'), await runCron('send'), await runCron('send')];

    assert.equal(fake.sendRequests, 1);
    assert.equal(fake.sent[0].to, CONTACT);
    assert.equal(fake.sent[0].hasPdfAttachment, true);
    assert.deepEqual(await applicationStatuses(), ['sent']);
  });

  // Known Dev A bug, reported in docs/integration-findings.md; todo scenarios run but do not fail CI.
  // Dev A: ingest resumes from the newest stored job, which is the batch's oldest post, so it re-reads (and pays for) posts it has seen; searchRecentJobPosts already returns highestId, unused.
  it.todo('ingest resumes after the newest post it has seen', async () => {
    fake.xPosts = [hiringPost('3000'), hiringPost('2000'), hiringPost('1000')];

    evidence.runs = [await runCron('ingest'), await runCron('ingest')];

    assert.equal(fake.xSearches.length, 2);
    assert.equal(fake.xSearches[1].since_id, '3000', 'the second search starts after the newest post, not the oldest');
  });

  // Known Dev A bug, reported in docs/integration-findings.md; todo scenarios run but do not fail CI.
  // Dev A: ingest never stores author_handle, and thread expansion only runs when it is set, so it never runs.
  it.todo('ingest stores the post author, so author-only thread expansion can run', async () => {
    fake.xPosts = [hiringPost('1000')];

    evidence.ingest = await runCron('ingest');

    const { rows } = await db.pool.query('select author_id, author_handle from jobs');
    assert.equal(rows[0].author_id, '777');
    assert.ok(rows[0].author_handle, 'thread expansion requires author_handle');
  });

  // Known Dev A bug, reported in docs/integration-findings.md; todo scenarios run but do not fail CI.
  // Dev A: ingest never stores the post's URL entities, so apply_link is always null and every link or form job ends as needs_manual (link_missing).
  it.todo('a link job reaches its user as a card with the apply link from the post', async () => {
    await seedCandidate(2001, true);
    fake.pipeline.extract = { ...fake.pipeline.extract, apply_method: 'link' };
    fake.xPosts = [{ ...hiringPost('1000'), text: 'We are hiring a Backend Engineer at Acme. Apply here: https://apply.acme-careers.test/jobs/42' }];

    evidence.runs = [await runCron('ingest'), await runCron('process'), await runCron('send')];

    const card = repliesTo(fake, 2001).find((text) => text.includes('New Job Opportunity'));
    assert.ok(card, 'a link card was sent');
    assert.ok(card.includes('apply.acme-careers.test'));
  });

  it('a draft the verifier rejects is never sent', async () => {
    await seedCandidate(2001, true);
    fake.pipeline.verify = { supported: false, unsupported_claims: ['Claims 10 years of Kubernetes'] };
    fake.xPosts = [hiringPost('1000')];

    evidence.runs = [await runCron('ingest'), await runCron('process'), await runCron('send')];

    assert.deepEqual(await applicationStatuses(), ['needs_manual']);
    assert.equal(fake.sendRequests, 0);
  });

  it('a poor fit is not tailored or sent', async () => {
    await seedCandidate(2001, true);
    fake.pipeline.match = { fit_score: 15, gaps: ['Go', 'Kubernetes'], years_gap: true, explanation: 'Weak fit.' };
    fake.xPosts = [hiringPost('1000')];

    evidence.runs = [await runCron('ingest'), await runCron('process'), await runCron('send')];

    assert.equal(fake.sendRequests, 0);
    assert.equal(Object.keys(fake.blobs).length, 0, 'no resume rendered for a poor fit');
  });

});
