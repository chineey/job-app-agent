import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractLinksAndExpandText } from '../lib/x';

const mockSql = vi.fn();
vi.mock('../lib/db', () => ({
  sql: (...args: unknown[]) => mockSql(...args),
  logEvent: vi.fn(),
  assertUserScope: vi.fn(),
}));

const mockGetUserByChatId = vi.fn();
const mockGetUserSettings = vi.fn();
vi.mock('../lib/users', () => ({
  getUserByChatId: (...args: unknown[]) => mockGetUserByChatId(...args),
  getUserSettings: (...args: unknown[]) => mockGetUserSettings(...args),
  registerUser: vi.fn(),
  canonicalTimeZone: vi.fn((z: string) => z),
  agreeToTerms: vi.fn(),
  updateUserSettings: vi.fn(),
  createInvite: vi.fn(),
  listAllUsers: vi.fn(),
  setUserSuspension: vi.fn(),
  setUserLimits: vi.fn(),
  MAX_CAP_CEILING: 20,
  MAX_READS_CEILING: 100,
  deleteUserAccount: vi.fn(),
  getUserById: vi.fn(),
  autoPauseUser: vi.fn(),
}));

const mockFetchSinglePost = vi.fn();
const mockExpandAuthorThread = vi.fn();
vi.mock('../lib/x', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/x')>();
  return {
    ...actual,
    fetchSinglePost: (...args: unknown[]) => mockFetchSinglePost(...args),
    expandAuthorThread: (...args: unknown[]) => mockExpandAuthorThread(...args),
  };
});

const mockDispatchLinkApplications = vi.fn();
vi.mock('../lib/links', () => ({
  dispatchLinkApplications: (...args: unknown[]) => mockDispatchLinkApplications(...args),
  markLinkApplied: vi.fn(),
  waitingLinkApplications: vi.fn(async () => []),
}));

const mockRunSendPass = vi.fn();
vi.mock('../lib/send', () => ({
  runSendPass: (...args: unknown[]) => mockRunSendPass(...args),
  resolveSendAttempt: vi.fn(),
}));

vi.mock('../lib/applications', () => ({
  IMPORT_LIMIT: 50,
  importPastRecipients: vi.fn(),
  openDrafts: vi.fn(),
  recentSends: vi.fn(),
  skipApplication: vi.fn(),
}));

vi.mock('../lib/ramp', () => ({
  capCeiling: vi.fn(() => 20),
  sendCap: vi.fn(() => 3),
  stageCap: vi.fn(() => 3),
}));

vi.mock('../lib/facts-versions', () => ({
  acceptPendingVersion: vi.fn(),
  activeYearsConfirmed: vi.fn(),
  rejectPendingVersion: vi.fn(),
  rollbackVersion: vi.fn(),
  setFact: vi.fn(),
  setResumeMode: vi.fn(),
  storePendingVersion: vi.fn(),
}));

vi.mock('../lib/gmail', () => ({
  disconnectGmail: vi.fn(),
}));

import { handleTelegramMessage, sendTelegramMessage } from '../lib/telegram';

describe('Telegram Link Ingestion & Pipeline Flow', () => {
  const originalFetch = global.fetch;
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-cron-secret';
    mockSql.mockResolvedValue([]);
    mockGetUserByChatId.mockResolvedValue({
      id: 'user-1',
      telegram_chat_id: 12345,
      status: 'active',
      role: 'user',
    });
    mockGetUserSettings.mockResolvedValue({
      user_id: 'user-1',
      dry_run: true,
      paused: false,
    });
    mockDispatchLinkApplications.mockResolvedValue({ notified: 1, reminded: 0 });
    mockRunSendPass.mockResolvedValue({
      reconciliation: { checked: 0, resolvedSent: 0, resolvedFailed: 0 },
      claimed: 0,
      dryRuns: 0,
      skipped: 0,
      errors: [],
      outcomes: {},
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  describe('extractLinksAndExpandText (lib/x.ts)', () => {
    it('expands t.co URLs and extracts external apply_link and domain while skipping x.com links', () => {
      const res = extractLinksAndExpandText({
        id: '111',
        text: 'We are hiring! Apply here https://t.co/abc123 pic https://t.co/img1',
        entities: {
          urls: [
            {
              url: 'https://t.co/img1',
              expanded_url: 'https://x.com/founder/status/111/photo/1',
            },
            {
              url: 'https://t.co/abc123',
              expanded_url: 'https://www.jobs.lever.co/acme/backend-eng',
            },
          ],
        },
      });

      expect(res.expandedText).toContain('https://www.jobs.lever.co/acme/backend-eng');
      expect(res.applyLink).toBe('https://www.jobs.lever.co/acme/backend-eng');
      expect(res.applyLinkDomain).toBe('jobs.lever.co');
    });

    it('falls back to scanning plain text for external URLs when entities are missing', () => {
      const res = extractLinksAndExpandText({
        id: '222',
        text: 'Hiring Full Stack Dev: https://boards.greenhouse.io/startup/jobs/42.',
      });

      expect(res.applyLink).toBe('https://boards.greenhouse.io/startup/jobs/42');
      expect(res.applyLinkDomain).toBe('boards.greenhouse.io');
    });
  });

  describe('handleTelegramMessage with X/Twitter link', () => {
    it('ingests post + thread with apply_link, runs process + link dispatch + send pass, and reports link_ready', async () => {
      mockFetchSinglePost.mockResolvedValue({
        tweet: {
          id: '1900000001',
          text: 'Hiring Senior TS Engineer! Apply at https://jobs.ashbyhq.com/acme/123',
          conversation_id: '1900000001',
          author_id: 'auth-1',
        },
        mediaUrls: [],
        authorUsername: 'acme_cto',
        applyLink: 'https://jobs.ashbyhq.com/acme/123',
        applyLinkDomain: 'jobs.ashbyhq.com',
      });

      mockExpandAuthorThread.mockResolvedValue({
        threadText: 'Remote friendly!',
        mediaUrls: [],
        threadPostIds: ['1900000002'],
        applyLink: null,
        applyLinkDomain: null,
      });

      mockSql
        .mockResolvedValueOnce([]) // insert jobs
        .mockResolvedValueOnce([]) // delete applications
        .mockResolvedValueOnce([
          {
            id: 'job-uuid-1',
            status: 'extracted',
            status_reason: null,
            company: 'Acme',
            role: 'Senior TS Engineer',
            apply_method: 'link',
            contact_email: null,
            apply_link: 'https://jobs.ashbyhq.com/acme/123',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'app-uuid-1',
            status: 'link_ready',
            fit_score: 88,
            status_reason: null,
            route: 'link',
          },
        ]);

      const fetchSpy = vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/api/cron/process')) {
          return new Response(JSON.stringify({ success: true, summary: { jobsExtracted: 1 } }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      global.fetch = fetchSpy as unknown as typeof fetch;

      await handleTelegramMessage(12345, 'https://x.com/acme_cto/status/1900000001?s=20');

      expect(mockFetchSinglePost).toHaveBeenCalledWith('1900000001');
      expect(mockExpandAuthorThread).toHaveBeenCalledWith('1900000001', 'acme_cto', 10);
      expect(mockDispatchLinkApplications).toHaveBeenCalledTimes(1);
      expect(mockRunSendPass).toHaveBeenCalledTimes(1);

      const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(calledUrls.some((u) => u.includes('/api/cron/process'))).toBe(true);

      const deleteCall = mockSql.mock.calls[1];
      const deleteSqlText = (deleteCall[0] as TemplateStringsArray).join(' ');
      expect(deleteSqlText.toLowerCase()).toContain('delete from applications');
    });

    it('reports an error if /api/cron/process fails instead of silently reporting success', async () => {
      mockFetchSinglePost.mockResolvedValue({
        tweet: { id: '1900000002', text: 'Hiring dev jobs@acme.com' },
        mediaUrls: [],
        applyLink: null,
        applyLinkDomain: null,
      });

      const fetchSpy = vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('/api/cron/process')) {
          return new Response('Internal Server Error', { status: 500 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      global.fetch = fetchSpy as unknown as typeof fetch;

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await handleTelegramMessage(12345, 'https://x.com/acme_cto/status/1900000002');

      const loggedMessages = consoleSpy.mock.calls.map((c) => String(c[0]));
      expect(loggedMessages.some((m) => m.includes('Error processing post'))).toBe(true);
      consoleSpy.mockRestore();
    });

    it('sendTelegramMessage handles Markdown text cleanly', async () => {
      const ok = await sendTelegramMessage(12345, 'Hello_world *test*');
      expect(ok).toBe(true);
    });
  });
});
