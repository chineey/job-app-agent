// Shared E2E infrastructure: a throwaway Postgres cluster, a fake Google/Telegram server,
// and the production Next.js server pointed at both. Each *.e2e.mts file is one suite;
// docs/send-safety.md and docs/telegram-access.md describe what they prove.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

const ROOT = path.resolve(import.meta.dirname, '..');
const EVIDENCE_ROOT = path.join(ROOT, 'artifacts', 'e2e');

const PG_PORT = 55433;
const FAKE_PORT = 3110;
const APP_PORT = 3109;

const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}`;
const CRON_SECRET = 'e2e-cron-secret';
const WEBHOOK_SECRET = 'e2e-webhook-secret';
const BOT_TOKEN = 'e2e-bot-token';
export const ADMIN_CHAT_ID = 1;
/** Daily cap per ramp stage, as in lib/ramp.ts. */
export const RAMP_STAGE_CAPS = [0, 3, 5, 10, 15, 20];
const ENCRYPTION_KEY = crypto.randomBytes(32);
export const RESUME_URL = `${FAKE_URL}/resume.pdf`;

// ---------------------------------------------------------------- Postgres

export interface Database {
  url: string;
  pool: pg.Pool;
  stop(): Promise<void>;
}

export async function startPostgres(): Promise<Database> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'send-safety-pg-'));
  // On macOS the postmaster refuses to start without a valid LC_ALL.
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  const serverOptions = `-p ${PG_PORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off`;
  const serverLog = path.join(dataDir, 'server.log');
  try {
    execFileSync('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale', '--no-sync'], {
      env,
      stdio: 'pipe',
    });
    execFileSync('pg_ctl', ['-D', dataDir, '-o', serverOptions, '-l', serverLog, '-w', 'start'], { env, stdio: 'pipe' });
  } catch (err) {
    const log = readFileSync(serverLog, { encoding: 'utf8', flag: 'a+' });
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`Could not start Postgres: ${err instanceof Error ? err.message : String(err)}\n${log}`);
  }

  const url = `postgres://postgres@127.0.0.1:${PG_PORT}/postgres`;
  const pool = new pg.Pool({ connectionString: url });
  await pool.query(readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));

  return {
    url,
    pool,
    async stop() {
      await pool.end();
      execFileSync('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function resetDatabase(db: Database): Promise<void> {
  await db.pool.query(`
    truncate users, invites, oauth_states, user_settings, facts_versions, jobs, applications,
             send_state, send_attempts, spend, user_spend, events, telegram_updates restart identity cascade;
    update global_settings set value = 'false' where key = 'global_paused';
    delete from global_settings where key = 'x_last_since_id';
  `);
}

/** Reverses encryptRefreshToken, to check what the app stored. */
export function decryptStoredToken(stored: string): string {
  const [iv, tag, ciphertext] = stored.split(':').map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Same format as lib/crypto.ts ("iv:authTag:ciphertext", base64). A mismatch makes every send fail.
function encryptRefreshToken(token: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

export async function seedUser(db: Database, options: { chatId: number; cap: number }): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `insert into users (telegram_chat_id, display_name, status, consented_at, consent_version,
                        gmail_address, gmail_refresh_token_enc, gmail_status, gmail_connected_at)
     values ($1, $2, 'active', now(), 'v3.2', $3, $4, 'connected', now())
     returning id`,
    [options.chatId, `Synthetic ${options.chatId}`, `candidate${options.chatId}@gmail.com`, encryptRefreshToken(seededRefreshToken(options.chatId))]
  );
  const userId = rows[0].id;
  // A live user on the lowest ramp stage that allows `cap`; a 0-24 window keeps the window check open.
  const rampStage = RAMP_STAGE_CAPS.findIndex((stageCap) => stageCap >= options.cap);
  if (rampStage < 1) throw new Error(`No ramp stage allows a cap of ${options.cap}`);
  await db.pool.query(
    `insert into user_settings (user_id, dry_run, paused, ramp_stage, ramp_stage_started_at, current_cap, timezone, send_window_start, send_window_end)
     values ($1, false, false, $2, now(), $3, 'UTC', 0, 24)`,
    [userId, rampStage, options.cap]
  );
  await db.pool.query(`insert into send_state (user_id, next_send_at) values ($1, now() - interval '1 hour')`, [userId]);
  return userId;
}

/** The plaintext refresh token seedUser stores (encrypted) for a chat. */
export function seededRefreshToken(chatId: number): string {
  return `seeded-refresh-${chatId}`;
}

export async function seedApplication(
  db: Database,
  userId: string,
  options: { recipient: string; status?: string }
): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `insert into applications (user_id, contact_email, route, fit_score, email_subject, email_body, resume_blob_url, status)
     values ($1, $2, 'email', 80, 'Application: Backend Engineer', 'Synthetic application body.', $3, $4)
     returning id`,
    [userId, options.recipient, RESUME_URL, options.status ?? 'verified']
  );
  return rows[0].id;
}

/** An application already sent today, so it uses one of the day's slots. */
export async function seedSentToday(db: Database, userId: string, recipient: string): Promise<string> {
  const applicationId = await seedApplication(db, userId, { recipient, status: 'sent' });
  return seedAttempt(db, userId, applicationId, 'sent', recipient);
}

export async function seedAttempt(
  db: Database,
  userId: string,
  applicationId: string,
  state: string,
  recipient: string
): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `insert into send_attempts (user_id, application_id, state, recipient, recipient_domain, rfc_message_id,
                                subject, body_hash, resume_blob_url, resume_sha256, started_at)
     values ($1, $2, $3, $4, split_part($4, '@', 2), $5, 'Application: Backend Engineer', 'seed', $6, 'seed', now())
     returning id`,
    [userId, applicationId, state, recipient, `<seed.${crypto.randomUUID()}@gmail.com>`, RESUME_URL]
  );
  return rows[0].id;
}

/**
 * Runs a locking query (`select ... for update`) in an open transaction, so concurrent requests
 * queue up behind it as they would under load. Releasing commits and lets them race.
 * Always release, even when the test fails: an open gate keeps a connection and blocks teardown.
 */
export async function holdRowLock(db: Database, lockingQuery: string, params: unknown[]): Promise<{ release(): Promise<void> }> {
  const client = await db.pool.connect();
  await client.query('begin');
  const { rowCount } = await client.query(lockingQuery, params);
  if (rowCount === 0) throw new Error(`Lock query matched no rows: ${lockingQuery}`);
  return {
    async release() {
      await client.query('commit');
      client.release();
    },
  };
}

export async function waitForLockWaiters(db: Database, count: number): Promise<void> {
  await waitFor(`${count} backends waiting on a row lock`, async () => {
    const { rows } = await db.pool.query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`
    );
    return rows[0].waiting >= count;
  });
}

export async function waitFor(description: string, check: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

// ---------------------------------------------------------------- Fake Google and Telegram

export type SendBehavior = 'accept' | 'accept_then_503' | 'accept_then_hang' | 'reject_400' | 'reject_403';

export interface GmailMessage {
  id: string;
  threadId: string;
  rfcMessageId: string;
  to: string;
  hasPdfAttachment: boolean;
  internalDate: string;
}

/** What the fake Google consent screen grants on the next authorization-code exchange. */
export interface OAuthGrant {
  scope: string;
  emailAddress: string;
  withRefreshToken: boolean;
}

export const FULL_GMAIL_SCOPE = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
].join(' ');

/** A message in a Gmail thread, as the fake returns it from threads.get. */
export interface ThreadMessage {
  id: string;
  from: string;
  messageIdHeader: string;
  snippet: string;
}

export interface GeminiClassification {
  category: 'interview' | 'assessment' | 'question' | 'rejection' | 'auto' | 'other';
  summary: string;
  suggested_action: string;
}

export interface FakeProviders {
  oauthGrant: OAuthGrant;
  /** When true, refreshing an access token fails with invalid_grant (access revoked). */
  refreshFails: boolean;
  /** Application threads by Gmail thread id. */
  threads: Record<string, ThreadMessage[]>;
  threadFetches: Record<string, number>;
  drafts: Array<{ threadId: string; to: string; subject: string; inReplyTo: string }>;
  geminiClassification: GeminiClassification;
  geminiCalls: number;
  /** What the fake Gemini returns for a resume-parsing prompt. */
  parsedResume: Record<string, unknown>;
  /** What the fake Gemini returns for each of Dev A's pipeline stages. */
  pipeline: { extract: Record<string, unknown>; match: Record<string, unknown>; tailor: Record<string, unknown>; verify: Record<string, unknown> };
  /** Posts the fake X recent search returns, newest first. */
  xPosts: Array<{ id: string; text: string; author_id: string; conversation_id: string }>;
  /** Every X search request: its query parameters. */
  xSearches: Array<Record<string, string>>;
  /** Files stored in the fake Blob store, by pathname. */
  blobs: Record<string, Buffer>;
  /** Files users sent the bot, by Telegram file_id. */
  telegramFiles: Record<string, Buffer>;
  /** Tokens Google was asked to revoke, exactly as received. */
  revokedTokens: string[];
  /** Every messages.send request Gmail received, whatever it answered. */
  sendRequests: number;
  /** Messages Gmail stored in the Sent folder. */
  sent: GmailMessage[];
  /** Bounce notices (from mailer-daemon) in the inbox; `receivedAt` defaults to now (epoch ms). */
  bounces: Array<{ id: string; threadId: string; snippet: string; receivedAt?: number }>;
  // chat_id arrives as a string when it was read from the bigint column, as a number otherwise.
  telegram: Array<{ chatId: number | string; text: string }>;
  /** Messages the fake Telegram rejected for bad Markdown. */
  telegramRejected: number;
  telegramDocuments: Array<{ chatId: number; filename: string; caption: string }>;
  unexpected: string[];
  sendBehavior: SendBehavior;
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeProviders(): Promise<FakeProviders> {
  const hanging = new Set<ServerResponse>();
  const defaultClassification = (): GeminiClassification => ({
    category: 'interview',
    summary: 'The recruiter asks for a call.',
    suggested_action: 'Reply with availability.',
  });
  // The parser estimates years when unsure; the estimate must never count as confirmed.
  const defaultParsedResume = (): Record<string, unknown> => ({
    identity: { name: 'Ada Synthetic', email: 'ada@example.test', phone: '', location: 'Lagos', links: { github: '', linkedin: '', portfolio: '' } },
    years_experience: 4,
    open_to_relocation: false,
    education: [],
    certs: [],
    experience: [],
    projects: [],
    skills: { strong: ['TypeScript', 'Postgres'], working: [], known_gaps: [] },
    fixed_priority: [],
    gap_framing: '',
  });
  // A clean, low-risk email job that every stage accepts; scenarios override single stages.
  const defaultPipeline = (): FakeProviders['pipeline'] => ({
    extract: {
      transcribed_text: '',
      is_job: true,
      is_software_role: true,
      role: 'Backend Engineer',
      company: 'Acme',
      location: 'Remote',
      remote: true,
      relocation_required: false,
      visa_sponsorship: 'unknown',
      min_years: 2,
      salary: null,
      deadline: null,
      requirements: ['TypeScript', 'Postgres'],
      apply_method: 'email',
      scam_risk: 'low',
      scam_reasons: [],
    },
    match: { fit_score: 82, gaps: [], years_gap: false, explanation: 'Strong TypeScript and Postgres fit.' },
    tailor: {
      resume_json: {
        summary_line: 'Backend engineer building TypeScript and Postgres services.',
        project_ids: ['p1'],
        bullet_ids: ['p1-b1'],
        skill_order: ['TypeScript', 'Postgres'],
      },
      email_slots: {
        subject: 'Application: Backend Engineer at Acme',
        opening_line: 'I am applying for the Backend Engineer role at Acme.',
        project_fit_sentences: 'I built a payments API in TypeScript and Postgres that handles retries safely.',
        gap_sentence: '',
      },
      cover_note: 'I would love to help Acme build reliable backend services.',
    },
    verify: { supported: true, unsupported_claims: [] },
  });
  const defaultGrant = (): OAuthGrant => ({ scope: FULL_GMAIL_SCOPE, emailAddress: 'candidate@gmail.com', withRefreshToken: true });
  const state: FakeProviders = {
    oauthGrant: defaultGrant(),
    refreshFails: false,
    threads: {},
    threadFetches: {},
    drafts: [],
    geminiClassification: defaultClassification(),
    geminiCalls: 0,
    parsedResume: defaultParsedResume(),
    pipeline: defaultPipeline(),
    xPosts: [],
    xSearches: [],
    blobs: {},
    telegramFiles: {},
    revokedTokens: [],
    sendRequests: 0,
    sent: [],
    bounces: [],
    telegram: [],
    telegramRejected: 0,
    telegramDocuments: [],
    unexpected: [],
    sendBehavior: 'accept',
    reset() {
      state.oauthGrant = defaultGrant();
      state.refreshFails = false;
      state.threads = {};
      state.threadFetches = {};
      state.drafts = [];
      state.geminiClassification = defaultClassification();
      state.geminiCalls = 0;
      state.parsedResume = defaultParsedResume();
      state.pipeline = defaultPipeline();
      state.xPosts = [];
      state.xSearches = [];
      state.blobs = {};
      state.telegramFiles = {};
      state.revokedTokens = [];
      state.sendRequests = 0;
      state.sent = [];
      state.bounces = [];
      state.telegram = [];
      state.telegramRejected = 0;
      state.telegramDocuments = [];
      state.unexpected = [];
      state.sendBehavior = 'accept';
    },
    close: async () => {
      for (const res of hanging) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', FAKE_URL);
    const rawBody = await readBody(req);
    const body = rawBody.toString('utf8');

    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        const grant = state.oauthGrant;
        return json(res, 200, {
          access_token: `access-for-${grant.emailAddress}`,
          expires_in: 3600,
          token_type: 'Bearer',
          scope: grant.scope,
          ...(grant.withRefreshToken ? { refresh_token: refreshTokenFor(form.get('code') ?? '') } : {}),
        });
      }
      if (state.refreshFails) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      }
      return json(res, 200, { access_token: 'fake-access-token', expires_in: 3600, token_type: 'Bearer' });
    }

    if (req.method === 'POST' && url.pathname === '/oauth/revoke') {
      state.revokedTokens.push(url.searchParams.get('token') ?? new URLSearchParams(body).get('token') ?? '');
      return json(res, 200, {});
    }

    if (req.method === 'GET' && url.pathname === '/gmail/v1/users/me/profile') {
      return json(res, 200, { emailAddress: state.oauthGrant.emailAddress, messagesTotal: 0 });
    }

    if (req.method === 'POST' && url.pathname === '/gmail/v1/users/me/messages/send') {
      state.sendRequests++;
      if (state.sendBehavior === 'reject_400') {
        return json(res, 400, { error: { code: 400, message: 'Invalid To header', status: 'INVALID_ARGUMENT' } });
      }
      if (state.sendBehavior === 'reject_403') {
        return json(res, 403, { error: { code: 403, message: 'Daily user sending limit exceeded', status: 'PERMISSION_DENIED' } });
      }
      const raw = Buffer.from(JSON.parse(body).raw, 'base64url').toString('utf8');
      const message: GmailMessage = {
        id: `msg-${state.sent.length + 1}`,
        threadId: `thread-${state.sent.length + 1}`,
        rfcMessageId: header(raw, 'Message-ID').replace(/^<|>$/g, ''),
        to: header(raw, 'To'),
        hasPdfAttachment: raw.includes('Content-Type: application/pdf'),
        internalDate: String(Date.now()),
      };
      state.sent.push(message);

      if (state.sendBehavior === 'accept_then_hang') {
        hanging.add(res);
        return;
      }
      if (state.sendBehavior === 'accept_then_503') {
        // The text contains "400" on purpose: the old classifier matched it as a confirmed 4xx.
        return json(res, 503, {
          error: { code: 503, message: 'Backend Error: deadline exceeded after 4000ms', status: 'UNAVAILABLE' },
        });
      }
      return json(res, 200, { id: message.id, threadId: message.threadId, labelIds: ['SENT'] });
    }

    if (req.method === 'GET' && url.pathname === '/gmail/v1/users/me/messages') {
      if ((url.searchParams.get('q') ?? '').includes('from:mailer-daemon')) {
        return json(res, 200, {
          messages: state.bounces.map((b) => ({ id: b.id, threadId: b.threadId })),
          resultSizeEstimate: state.bounces.length,
        });
      }
      const wanted = /rfc822msgid:(\S+)/.exec(url.searchParams.get('q') ?? '')?.[1];
      const found = state.sent.filter((m) => m.rfcMessageId === wanted);
      return json(res, 200, {
        messages: found.map((m) => ({ id: m.id, threadId: m.threadId })),
        resultSizeEstimate: found.length,
      });
    }

    const threadMatch = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && threadMatch) {
      const threadId = threadMatch[1];
      state.threadFetches[threadId] = (state.threadFetches[threadId] ?? 0) + 1;
      return json(res, 200, {
        id: threadId,
        messages: (state.threads[threadId] ?? []).map((m) => ({
          id: m.id,
          threadId,
          snippet: m.snippet,
          payload: {
            headers: [
              { name: 'From', value: m.from },
              { name: 'Message-ID', value: m.messageIdHeader },
            ],
          },
        })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/gmail/v1/users/me/drafts') {
      const { message } = JSON.parse(body);
      const raw = Buffer.from(message.raw, 'base64url').toString('utf8');
      state.drafts.push({
        threadId: message.threadId,
        to: header(raw, 'To'),
        subject: header(raw, 'Subject'),
        inReplyTo: header(raw, 'In-Reply-To'),
      });
      return json(res, 200, { id: `draft-${state.drafts.length}`, message: { id: `draft-msg-${state.drafts.length}` } });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/gemini/') && url.pathname.endsWith(':generateContent')) {
      state.geminiCalls++;
      const prompt: string = JSON.parse(body).contents?.[0]?.parts?.[0]?.text ?? '';
      const answer = prompt.includes('Categorize this message')
        ? state.geminiClassification
        : prompt.includes('resume parser')
          ? state.parsedResume
          : prompt.includes('ATS extractor')
            ? state.pipeline.extract
            : prompt.includes('objective hiring manager')
              ? state.pipeline.match
              : prompt.includes('tailoring an engineering application')
                ? state.pipeline.tailor
                : prompt.includes('adversarial fact-checker')
                  ? state.pipeline.verify
                  : { reply_body: 'Thank you for reaching out. I am available for a call. [Insert your preferred times here]', availability_placeholder_used: true };
      return json(res, 200, {
        candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }],
      });
    }

    const messageMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && messageMatch) {
      const bounce = state.bounces.find((b) => b.id === messageMatch[1]);
      if (bounce) {
        const internalDate = String(bounce.receivedAt ?? Date.now());
        return json(res, 200, { id: bounce.id, threadId: bounce.threadId, snippet: bounce.snippet, internalDate });
      }
      const message = state.sent.find((m) => m.id === messageMatch[1]);
      if (!message) return json(res, 404, { error: { code: 404, message: 'Not found' } });
      return json(res, 200, { id: message.id, threadId: message.threadId, internalDate: message.internalDate });
    }

    if (req.method === 'GET' && url.pathname === '/resume.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end('%PDF-1.4\n% synthetic resume\n%%EOF\n');
    }

    if (req.method === 'POST' && url.pathname === `/bot${BOT_TOKEN}/sendMessage`) {
      const message = JSON.parse(body);
      // Like the real Bot API: unbalanced Markdown entities reject the whole message.
      if (message.parse_mode === 'Markdown' && (message.text.match(/\*/g) ?? []).length % 2 === 1) {
        state.telegramRejected++;
        return json(res, 400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" });
      }
      state.telegram.push({ chatId: message.chat_id, text: message.text });
      return json(res, 200, { ok: true, result: {} });
    }

    if (req.method === 'GET' && url.pathname === '/x/2/tweets/search/recent') {
      state.xSearches.push(Object.fromEntries(url.searchParams));
      const sinceId = url.searchParams.get('since_id');
      // Thread expansion searches by conversation; the scenarios have no threads.
      const posts = (url.searchParams.get('query') ?? '').includes('conversation_id:')
        ? []
        : state.xPosts.filter((post) => !sinceId || BigInt(post.id) > BigInt(sinceId));
      // Like the real API: authors come back under includes.users, links as URL entities.
      const data = posts.map((post) => ({
        ...post,
        entities: {
          urls: (post.text.match(/https?:\/\/\S+/g) ?? []).map((link) => ({ url: link, expanded_url: link })),
        },
      }));
      const users = [...new Set(posts.map((post) => post.author_id))].map((id) => ({ id, username: `author${id}` }));
      return json(res, 200, { data, includes: { media: [], users }, meta: { result_count: posts.length } });
    }

    if (req.method === 'PUT' && url.pathname === '/blob/') {
      const pathname = url.searchParams.get('pathname') ?? '';
      state.blobs[pathname] = rawBody;
      const fileUrl = `${FAKE_URL}/blobfiles/${pathname}`;
      return json(res, 200, { url: fileUrl, downloadUrl: fileUrl, pathname, contentType: 'application/pdf', contentDisposition: 'inline' });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/blobfiles/')) {
      const stored = state.blobs[url.pathname.slice('/blobfiles/'.length)];
      if (!stored) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(stored);
    }

    if (req.method === 'GET' && url.pathname === `/bot${BOT_TOKEN}/getFile`) {
      const fileId = url.searchParams.get('file_id') ?? '';
      if (!state.telegramFiles[fileId]) return json(res, 400, { ok: false, description: 'Bad Request: file not found' });
      return json(res, 200, { ok: true, result: { file_id: fileId, file_path: `documents/${fileId}` } });
    }

    const fileMatch = new RegExp(`^/file/bot${BOT_TOKEN}/documents/(.+)$`).exec(url.pathname);
    if (req.method === 'GET' && fileMatch && state.telegramFiles[fileMatch[1]]) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(state.telegramFiles[fileMatch[1]]);
    }

    if (req.method === 'POST' && url.pathname === `/bot${BOT_TOKEN}/sendDocument`) {
      const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(body)?.[1] ?? '';
      const caption = field('caption');
      // Like the real Bot API: captions are limited to 1024 characters.
      if (caption.length > 1024) {
        return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: message caption is too long' });
      }
      const filename = /filename="([^"]+)"/.exec(body)?.[1] ?? '';
      state.telegramDocuments.push({ chatId: Number(field('chat_id')), filename, caption });
      return json(res, 200, { ok: true, result: {} });
    }

    state.unexpected.push(`${req.method} ${url.pathname}`);
    return json(res, 404, { error: 'unexpected request' });
  });

  await new Promise<void>((resolve) => server.listen(FAKE_PORT, '127.0.0.1', resolve));
  return state;
}

/** The refresh token the fake Google issues for an authorization code. */
export function refreshTokenFor(code: string): string {
  return `refresh-for-${code}`;
}

function header(raw: string, name: string): string {
  const match = new RegExp(`^${name}: (.*)$`, 'mi').exec(raw);
  return match ? match[1].trim() : '';
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// ---------------------------------------------------------------- Application server

export interface AppServer {
  log: string[];
  /** Stops the server. SIGKILL simulates a worker crash: no cleanup code runs. */
  stop(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

/** `env` overrides the defaults below; `undefined` removes a variable. */
export async function startApp(databaseUrl: string, env: Record<string, string | undefined> = {}): Promise<AppServer> {
  const nextBin = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child: ChildProcess = spawn(process.execPath, [nextBin, 'start', '-p', String(APP_PORT), '-H', '127.0.0.1'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      DATABASE_URL: databaseUrl,
      APP_BASE_URL: APP_URL,
      CRON_SECRET,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: FAKE_URL,
      ADMIN_CHAT_ID: String(ADMIN_CHAT_ID),
      GMAIL_CLIENT_ID: 'e2e-client-id',
      GMAIL_CLIENT_SECRET: 'e2e-client-secret',
      GOOGLE_API_ROOT_URL: `${FAKE_URL}/`,
      GOOGLE_OAUTH_ROOT_URL: `${FAKE_URL}/oauth`,
      GEMINI_API_KEY: 'e2e-gemini-key',
      X_BEARER_TOKEN: 'e2e-x-token',
      X_API_BASE_URL: `${FAKE_URL}/x`,
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_e2estore_secret',
      VERCEL_BLOB_API_URL: `${FAKE_URL}/blob`,
      GEMINI_API_BASE_URL: `${FAKE_URL}/gemini`,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY.toString('base64'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => log.push(chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  // An unauthenticated cron call answers 401 without touching anything once the server is up.
  try {
    await waitFor('Next.js server to accept requests', async () => {
      try {
        return (await fetch(`${APP_URL}/api/cron/send`)).status === 401;
      } catch {
        return false;
      }
    }, 30_000);
  } catch (err) {
    // Never leave a server on the port: the next start would talk to it instead.
    child.kill('SIGKILL');
    await exited;
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${log.join('')}`);
  }

  return {
    log,
    async stop(signal = 'SIGTERM') {
      child.kill(signal);
      await exited;
    },
  };
}

/** GET on the app without following redirects. */
export async function getApp(pathAndQuery: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${APP_URL}${pathAndQuery}`, { headers, redirect: 'manual' });
}

export async function runCron(name: 'send' | 'summary' | 'inbox' | 'followups' | 'ingest' | 'process'): Promise<Record<string, unknown>> {
  const res = await fetch(`${APP_URL}/api/cron/${name}`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200) {
    throw new Error(`${name} cron answered ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

export function runSendCron(): Promise<Record<string, unknown>> {
  return runCron('send');
}

let nextUpdateId = 1;

export function telegramUpdate(
  chatId: number,
  text: string,
  options: { chatType?: 'private' | 'group'; updateId?: number } = {}
): Record<string, unknown> {
  const updateId = options.updateId ?? nextUpdateId++;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: chatId, first_name: 'Synthetic' },
      chat: { id: chatId, type: options.chatType ?? 'private' },
      text,
    },
  };
}

/** Posts an update to the webhook; `secret: null` omits the header. Returns the HTTP status. */
export async function postTelegramUpdate(
  update: Record<string, unknown>,
  secret: string | null = WEBHOOK_SECRET
): Promise<number> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret;
  const res = await fetch(`${APP_URL}/api/telegram`, { method: 'POST', headers, body: JSON.stringify(update) });
  return res.status;
}

export async function sendTelegramCommand(chatId: number, text: string): Promise<void> {
  const status = await postTelegramUpdate(telegramUpdate(chatId, text));
  if (status !== 200) {
    throw new Error(`Telegram webhook answered ${status}`);
  }
}

/** Posts a document message, as Telegram does when a user sends a file. Returns the HTTP status. */
export async function sendTelegramDocumentUpdate(
  chatId: number,
  document: { file_id: string; file_name: string; file_size: number }
): Promise<number> {
  return postTelegramUpdate({
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      from: { id: chatId, first_name: 'Synthetic' },
      chat: { id: chatId, type: 'private' },
      document,
    },
  });
}

/** Replies the bot sent to one chat, oldest first. */
export function repliesTo(fake: FakeProviders, chatId: number): string[] {
  return fake.telegram.filter((m) => Number(m.chatId) === chatId).map((m) => m.text);
}

// ---------------------------------------------------------------- Evidence

export function writeEvidence(suite: string, scenario: string, evidence: Record<string, unknown>): void {
  const dir = path.join(EVIDENCE_ROOT, suite);
  mkdirSync(dir, { recursive: true });
  const name = scenario.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}
