// Resume onboarding scenarios: uploads through the webhook (real PDF validation and text extraction,
// fake Gemini), and the facts-version and resume-mode commands. See docs/resume-onboarding.md.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  repliesTo,
  resetDatabase,
  seedApplication,
  seedUser,
  sendTelegramCommand,
  sendTelegramDocumentUpdate,
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
  const { rows: versions } = await db.pool.query(
    `select id, status, source, years_confirmed, source_file_sha256 is not null as has_pdf_hash,
            source_file_url is not null as has_stored_pdf, facts->'years_experience' as years,
            facts->'open_to_relocation' as relocation
     from facts_versions order by id`
  );
  const { rows: applications } = await db.pool.query('select contact_email, status from applications order by created_at');
  const { rows: settings } = await db.pool.query('select resume_mode from user_settings');
  writeEvidence('resume-onboarding', t.name, {
    scenario: t.name,
    final: { versions, applications, settings },
    geminiCalls: fake.geminiCalls,
    telegram: fake.telegram,
    unexpectedProviderRequests: fake.unexpected,
    serverLogTail: app.log.slice(-40).join(''),
  });
});

/** A one-page PDF with a real text layer, with byte offsets computed so the xref table is valid. */
function syntheticResumePdf(): Buffer {
  const text = 'Ada Synthetic - Backend engineer - TypeScript, Postgres, distributed systems, payments platforms';
  const content = `BT /F1 10 Tf 40 760 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function upload(chatId: number, fileId: string, bytes: Buffer, fileName = 'resume.pdf', fileSize = bytes.length) {
  fake.telegramFiles[fileId] = bytes;
  assert.equal(await sendTelegramDocumentUpdate(chatId, { file_id: fileId, file_name: fileName, file_size: fileSize }), 200);
}

const FACTS = {
  identity: { name: 'Ada Synthetic', email: 'ada@example.test', phone: '', location: '', links: { github: '', linkedin: '', portfolio: '' } },
  years_experience: 4,
  open_to_relocation: false,
  education: [],
  certs: [],
  experience: [],
  projects: [],
  skills: { strong: ['TypeScript'], working: [], known_gaps: [] },
  fixed_priority: [],
  gap_framing: '',
};

async function seedVersion(
  userId: string,
  status: 'active' | 'pending' | 'superseded',
  options: { storedPdf?: boolean } = {}
): Promise<number> {
  const { rows } = await db.pool.query(
    `insert into facts_versions (user_id, source, facts, status, years_confirmed, source_file_url, source_file_sha256)
     values ($1, 'seed', $2, $3, true, $4, $5) returning id`,
    [userId, JSON.stringify(FACTS), status, options.storedPdf ? 'https://blob.example.test/resume.pdf' : null, options.storedPdf ? 'hash' : null]
  );
  return rows[0].id;
}

async function versionStatuses(userId: string): Promise<string[]> {
  const { rows } = await db.pool.query('select status from facts_versions where user_id = $1 order by id', [userId]);
  return rows.map((row) => row.status);
}

async function applicationStatuses(userId: string): Promise<Record<string, string>> {
  const { rows } = await db.pool.query('select contact_email, status from applications where user_id = $1', [userId]);
  return Object.fromEntries(rows.map((row) => [row.contact_email, row.status]));
}

describe('resume onboarding', () => {
  it('an upload becomes a pending version, and its estimated years must be confirmed before /accept', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });

    await upload(2001, 'resume-1', syntheticResumePdf());
    assert.ok(repliesTo(fake, 2001).some((text) => text.includes('Resume Extracted Successfully')), repliesTo(fake, 2001).join(' | '));
    const [pending] = (await db.pool.query(`select years_confirmed, source_file_sha256 from facts_versions where user_id = $1`, [userId])).rows;
    assert.equal(pending.years_confirmed, false, "the parser's estimate is not a confirmation");
    assert.ok(pending.source_file_sha256, 'the validated PDF is hashed');

    await sendTelegramCommand(2001, '/accept');
    assert.deepEqual(await versionStatuses(userId), ['pending'], '/accept is refused until years are confirmed');

    await sendTelegramCommand(2001, '/set years 0');
    await sendTelegramCommand(2001, '/accept');
    assert.deepEqual(await versionStatuses(userId), ['active'], 'a confirmed 0 is accepted');
  });

  it('a new upload replaces the pending version', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });

    await upload(2001, 'resume-1', syntheticResumePdf());
    await upload(2001, 'resume-2', syntheticResumePdf());

    assert.deepEqual(await versionStatuses(userId), ['rejected', 'pending']);
  });

  it('oversized and disguised files are rejected before parsing', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });

    await upload(2001, 'big', syntheticResumePdf(), 'resume.pdf', 6 * 1024 * 1024);
    await upload(2001, 'disguised', Buffer.from('MZ\x90\x00 not a pdf at all'), 'resume.pdf');

    assert.equal(fake.geminiCalls, 0, 'nothing reached the parser');
    assert.deepEqual(await versionStatuses(userId), []);
    // Rejected by the size and content checks themselves, not by a parser failing later.
    const rejections = repliesTo(fake, 2001).filter((text) => text.startsWith('❌'));
    assert.deepEqual(rejections, [
      '❌ That file is over 5 MB. Please send a smaller PDF or Word file.',
      '❌ That file is not a PDF or Word document under 5 MB.',
    ]);
  });

  it('/set never edits the active version; it proposes a pending copy', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });
    const activeId = await seedVersion(userId, 'active');

    await sendTelegramCommand(2001, '/set relocation yes');

    const { rows } = await db.pool.query(`select facts->'open_to_relocation' as relocation from facts_versions where id = $1`, [activeId]);
    assert.equal(rows[0].relocation, false, 'the active version is unchanged');
    assert.deepEqual(await versionStatuses(userId), ['active', 'pending']);

    await sendTelegramCommand(2001, '/accept');
    const [active] = (await db.pool.query(`select facts->'open_to_relocation' as relocation from facts_versions where user_id = $1 and status = 'active'`, [userId])).rows;
    assert.equal(active.relocation, true);
  });

  it('/accept and /rollback re-queue unsent work and leave in-flight and sent work alone', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });
    await seedVersion(userId, 'active');
    await seedVersion(userId, 'pending');
    for (const status of ['drafted', 'ready', 'sending', 'send_unknown', 'sent']) {
      await seedApplication(db, userId, { recipient: `${status}@acme.test`, status });
    }

    await sendTelegramCommand(2001, '/accept');
    assert.deepEqual(await versionStatuses(userId), ['superseded', 'active']);
    assert.deepEqual(await applicationStatuses(userId), {
      'drafted@acme.test': 'queued',
      'ready@acme.test': 'queued',
      'sending@acme.test': 'sending',
      'send_unknown@acme.test': 'send_unknown',
      'sent@acme.test': 'sent',
    });

    await db.pool.query(`update applications set status = 'ready' where contact_email = 'ready@acme.test'`);
    await sendTelegramCommand(2001, '/rollback');
    assert.deepEqual(await versionStatuses(userId), ['active', 'superseded']);
    assert.equal((await applicationStatuses(userId))['ready@acme.test'], 'queued');
  });

  it('uploaded mode needs a stored PDF, and rolling back to a version without one returns to generated', async () => {
    const userId = await seedUser(db, { chatId: 2001, cap: 3 });
    await seedVersion(userId, 'active');
    const mode = async () => (await db.pool.query('select resume_mode from user_settings where user_id = $1', [userId])).rows[0].resume_mode;

    await sendTelegramCommand(2001, '/resumemode uploaded');
    assert.equal(await mode(), 'generated', 'refused without a stored PDF');

    await db.pool.query(`update facts_versions set status = 'superseded' where user_id = $1`, [userId]);
    await seedVersion(userId, 'active', { storedPdf: true });
    await seedApplication(db, userId, { recipient: 'ready@acme.test', status: 'ready' });
    await sendTelegramCommand(2001, '/resumemode uploaded');
    assert.equal(await mode(), 'uploaded');
    assert.equal((await applicationStatuses(userId))['ready@acme.test'], 'queued', 'a mode change re-queues');

    await sendTelegramCommand(2001, '/rollback');
    assert.equal(await mode(), 'generated');
    assert.match(repliesTo(fake, 2001).at(-1) ?? '', /no stored PDF/);
  });
});
