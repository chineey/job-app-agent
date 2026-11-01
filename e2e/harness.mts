// Test infrastructure for the send-safety E2E suite: a throwaway Postgres cluster, a fake
// Google/Telegram server, and the production Next.js server pointed at both.
// See docs/send-safety.md for what the scenarios prove.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

const ROOT = path.resolve(import.meta.dirname, '..');
export const EVIDENCE_DIR = path.join(ROOT, 'artifacts', 'e2e', 'send-safety');

const PG_PORT = 55433;
const FAKE_PORT = 3110;
const APP_PORT = 3109;

const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}`;
const CRON_SECRET = 'e2e-cron-secret';
const WEBHOOK_SECRET = 'e2e-webhook-secret';
const BOT_TOKEN = 'e2e-bot-token';
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
             send_state, send_attempts, spend, user_spend, events restart identity cascade;
    update global_settings set value = 'false' where key = 'global_paused';
  `);
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
    [options.chatId, `Synthetic ${options.chatId}`, `candidate${options.chatId}@gmail.com`, encryptRefreshToken('fake-refresh-token')]
  );
  const userId = rows[0].id;
  // A 0-24 window keeps the window check open whenever the suite runs.
  await db.pool.query(
    `insert into user_settings (user_id, dry_run, paused, current_cap, timezone, send_window_start, send_window_end)
     values ($1, false, false, $2, 'UTC', 0, 24)`,
    [userId, options.cap]
  );
  await db.pool.query(`insert into send_state (user_id, next_send_at) values ($1, now() - interval '1 hour')`, [userId]);
  return userId;
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

/** Holds the account's send_state row lock so workers queue up behind it, as they would under load. */
export async function holdSendStateLock(db: Database, userId: string): Promise<{ release(): Promise<void> }> {
  const client = await db.pool.connect();
  await client.query('begin');
  await client.query('select 1 from send_state where user_id = $1 for update', [userId]);
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

export type SendBehavior = 'accept' | 'accept_then_503' | 'accept_then_hang' | 'reject_400';

export interface GmailMessage {
  id: string;
  threadId: string;
  rfcMessageId: string;
  to: string;
  hasPdfAttachment: boolean;
  internalDate: string;
}

export interface FakeProviders {
  /** Every messages.send request Gmail received, whatever it answered. */
  sendRequests: number;
  /** Messages Gmail stored in the Sent folder. */
  sent: GmailMessage[];
  // chat_id arrives as a string when it was read from the bigint column, as a number otherwise.
  telegram: Array<{ chatId: number | string; text: string }>;
  unexpected: string[];
  sendBehavior: SendBehavior;
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeProviders(): Promise<FakeProviders> {
  const hanging = new Set<ServerResponse>();
  const state: FakeProviders = {
    sendRequests: 0,
    sent: [],
    telegram: [],
    unexpected: [],
    sendBehavior: 'accept',
    reset() {
      state.sendRequests = 0;
      state.sent = [];
      state.telegram = [];
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
    const body = await readBody(req);

    if (req.method === 'POST' && url.pathname === '/token') {
      return json(res, 200, { access_token: 'fake-access-token', expires_in: 3600, token_type: 'Bearer' });
    }

    if (req.method === 'POST' && url.pathname === '/gmail/v1/users/me/messages/send') {
      state.sendRequests++;
      if (state.sendBehavior === 'reject_400') {
        return json(res, 400, { error: { code: 400, message: 'Invalid To header', status: 'INVALID_ARGUMENT' } });
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
      const wanted = /rfc822msgid:(\S+)/.exec(url.searchParams.get('q') ?? '')?.[1];
      const found = state.sent.filter((m) => m.rfcMessageId === wanted);
      return json(res, 200, {
        messages: found.map((m) => ({ id: m.id, threadId: m.threadId })),
        resultSizeEstimate: found.length,
      });
    }

    const messageMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && messageMatch) {
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
      state.telegram.push({ chatId: message.chat_id, text: message.text });
      return json(res, 200, { ok: true, result: {} });
    }

    state.unexpected.push(`${req.method} ${url.pathname}`);
    return json(res, 404, { error: 'unexpected request' });
  });

  await new Promise<void>((resolve) => server.listen(FAKE_PORT, '127.0.0.1', resolve));
  return state;
}

function header(raw: string, name: string): string {
  const match = new RegExp(`^${name}: (.*)$`, 'mi').exec(raw);
  return match ? match[1].trim() : '';
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
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

export async function startApp(databaseUrl: string): Promise<AppServer> {
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
      ADMIN_CHAT_ID: '1',
      GMAIL_CLIENT_ID: 'e2e-client-id',
      GMAIL_CLIENT_SECRET: 'e2e-client-secret',
      GOOGLE_API_ROOT_URL: `${FAKE_URL}/`,
      GOOGLE_OAUTH_TOKEN_URL: `${FAKE_URL}/token`,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY.toString('base64'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => log.push(chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  // An unauthenticated cron call answers 401 without touching anything once the server is up.
  await waitFor('Next.js server to accept requests', async () => {
    try {
      return (await fetch(`${APP_URL}/api/cron/send`)).status === 401;
    } catch {
      return false;
    }
  }, 30_000);

  return {
    log,
    async stop(signal = 'SIGTERM') {
      child.kill(signal);
      await exited;
    },
  };
}

export async function runSendCron(): Promise<Record<string, unknown>> {
  const res = await fetch(`${APP_URL}/api/cron/send`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200) {
    throw new Error(`Send cron answered ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

let nextUpdateId = 1;

export async function sendTelegramCommand(chatId: number, text: string): Promise<void> {
  const res = await fetch(`${APP_URL}/api/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: nextUpdateId++,
      message: {
        message_id: nextUpdateId,
        from: { id: chatId, first_name: 'Synthetic' },
        chat: { id: chatId, type: 'private' },
        text,
      },
    }),
  });
  if (res.status !== 200) {
    throw new Error(`Telegram webhook answered ${res.status}`);
  }
}

// ---------------------------------------------------------------- Evidence

export function writeEvidence(scenario: string, evidence: Record<string, unknown>): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, `${scenario}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}
