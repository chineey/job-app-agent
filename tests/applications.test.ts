import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.fn();
const logEventMock = vi.fn();

vi.mock('../lib/db', () => ({
  sql: (...args: unknown[]) => sqlMock(...args),
  logEvent: (...args: unknown[]) => logEventMock(...args),
  assertUserScope: vi.fn((userId: string) => {
    if (!userId) throw new Error('userId required');
  }),
}));

import { proceedApplication, proceedJob } from '../lib/applications';

describe('proceedApplication', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    logEventMock.mockReset();
  });

  it('returns not_found when no flagged application matches', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const res = await proceedApplication('user-1', 'app-1');
    expect(res).toEqual({ outcome: 'not_found' });
  });

  it('moves drafted needs_manual email application to ready', async () => {
    sqlMock
      .mockResolvedValueOnce([
        {
          id: 'app-1',
          status: 'needs_manual',
          status_reason: 'unsupported_claims',
          route: 'email',
          email_subject: 'Application',
          email_body: 'Hello',
        },
      ])
      .mockResolvedValueOnce([{ id: 'app-1' }]);

    const res = await proceedApplication('user-1', 'app-1');
    expect(res).toEqual({ outcome: 'ready', route: 'email' });
    expect(logEventMock).toHaveBeenCalledWith(
      'user-1',
      'application_proceeded',
      { previousStatus: 'needs_manual', nextStatus: 'ready' },
      null,
      'app-1'
    );
  });

  it('moves drafted needs_manual link application to link_ready', async () => {
    sqlMock
      .mockResolvedValueOnce([
        {
          id: 'app-2',
          status: 'needs_manual',
          status_reason: 'unsupported_claims',
          route: 'link',
          email_subject: 'Application',
          email_body: 'Hello',
        },
      ])
      .mockResolvedValueOnce([{ id: 'app-2' }]);

    const res = await proceedApplication('user-1', 'app-2');
    expect(res).toEqual({ outcome: 'ready', route: 'link' });
  });

  it('returns cannot_proceed when needs_manual has no draft', async () => {
    sqlMock.mockResolvedValueOnce([
      {
        id: 'app-3',
        status: 'needs_manual',
        status_reason: 'link_missing',
        route: 'link',
        email_subject: null,
        email_body: null,
      },
    ]);

    const res = await proceedApplication('user-1', 'app-3');
    expect(res).toEqual({ outcome: 'cannot_proceed', reason: 'link_missing' });
  });

  it('requeues rejected low_fit application to matched', async () => {
    sqlMock
      .mockResolvedValueOnce([
        {
          id: 'app-4',
          status: 'rejected',
          status_reason: 'low_fit',
          route: 'email',
          email_subject: null,
          email_body: null,
        },
      ])
      .mockResolvedValueOnce([{ id: 'app-4' }]);

    const res = await proceedApplication('user-1', 'app-4');
    expect(res).toEqual({ outcome: 'requeued_matched' });
  });
});

describe('proceedJob', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    logEventMock.mockReset();
  });

  it('requeues a flagged job with status_reason user_proceeded', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'job-1' }]);
    const ok = await proceedJob('user-1', 'job-1');
    expect(ok).toBe(true);
    expect(logEventMock).toHaveBeenCalledWith('user-1', 'job_proceeded', {}, 'job-1', null);
  });

  it('returns false when no flagged job matches', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const ok = await proceedJob('user-1', 'job-missing');
    expect(ok).toBe(false);
  });
});
