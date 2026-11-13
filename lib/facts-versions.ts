import { withTransaction, logEvent, assertUserScope, type Sql } from './db';
import type { MasterFacts } from './schemas';

// Facts versions and resume mode. Every change runs in one transaction under the user's row lock, so
// a user has at most one pending and one active version (also enforced by unique indexes).
// See docs/resume-onboarding.md.

/** Unsent work that was tailored with the old facts or mode (spec section 9, step 6). */
const REQUEUE_STATUSES = ['drafted', 'verified', 'ready'];

interface VersionRow {
  id: number;
  facts: MasterFacts;
  years_confirmed: boolean;
  source_file_url: string | null;
  source_file_sha256: string | null;
  source_file_pages: number | null;
}

async function lockUser(tx: Sql, userId: string): Promise<void> {
  await tx`select 1 from users where id = ${userId} for update`;
}

async function versionIn(tx: Sql, userId: string, status: 'pending' | 'active'): Promise<VersionRow | undefined> {
  const [row] = (await tx`
    select id, facts, years_confirmed, source_file_url, source_file_sha256, source_file_pages
    from facts_versions where user_id = ${userId} and status = ${status}
  `) as VersionRow[];
  return row;
}

/** Sends the user's unsent applications back to be regenerated. In-flight and sent ones are untouched. */
async function requeueUnsent(tx: Sql, userId: string): Promise<number> {
  const requeued = await tx`
    update applications
    set status = 'queued', claim_token = null, locked_at = null, updated_at = now()
    where user_id = ${userId} and status = any(${REQUEUE_STATUSES})
    returning id
  `;
  return requeued.length;
}

/** Uploaded mode attaches the active version's PDF; without one, fall back to generated. Returns true if switched. */
async function fallBackToGeneratedIfNoFile(tx: Sql, userId: string, sourceFileUrl: string | null): Promise<boolean> {
  if (sourceFileUrl) return false;
  const switched = await tx`
    update user_settings set resume_mode = 'generated' where user_id = ${userId} and resume_mode = 'uploaded' returning user_id
  `;
  return switched.length > 0;
}

/**
 * Stores a parsed upload as the user's pending version, replacing any older pending one.
 * Years stay confirmed only if they were carried over from a confirmed active version.
 */
export async function storePendingVersion(
  userId: string,
  facts: MasterFacts,
  diffSummary: string,
  pdf: { sha256: string; pages: number; url?: string | null } | null
): Promise<number> {
  assertUserScope(userId);
  const versionId = await withTransaction(async (tx) => {
    await lockUser(tx, userId);
    const active = await versionIn(tx, userId, 'active');
    await tx`update facts_versions set status = 'rejected' where user_id = ${userId} and status = 'pending'`;
    const [inserted] = (await tx`
      insert into facts_versions (user_id, source, facts, diff_summary, source_file_url, source_file_sha256, source_file_pages, years_confirmed, status)
      values (${userId}, 'telegram_upload', ${JSON.stringify(facts)}, ${diffSummary}, ${pdf?.url ?? null}, ${pdf?.sha256 ?? null},
              ${pdf?.pages ?? null}, ${active?.years_confirmed ?? false}, 'pending')
      returning id
    `) as Array<{ id: number }>;
    return inserted.id;
  });
  await logEvent(userId, 'facts_version_proposed', { versionId, pdf: pdf !== null });
  return versionId;
}

export type AcceptResult =
  | { outcome: 'accepted'; facts: MasterFacts; requeued: number; switchedToGenerated: boolean }
  | { outcome: 'no_pending' }
  | { outcome: 'years_unconfirmed' };

export async function acceptPendingVersion(userId: string): Promise<AcceptResult> {
  assertUserScope(userId);
  const result = await withTransaction(async (tx): Promise<AcceptResult> => {
    await lockUser(tx, userId);
    const pending = await versionIn(tx, userId, 'pending');
    if (!pending) return { outcome: 'no_pending' };
    if (!pending.years_confirmed) return { outcome: 'years_unconfirmed' };

    await tx`update facts_versions set status = 'superseded' where user_id = ${userId} and status = 'active'`;
    await tx`update facts_versions set status = 'active' where id = ${pending.id}`;
    if (pending.source_file_url) {
      await tx`update user_settings set resume_mode = 'uploaded' where user_id = ${userId}`;
    }
    const requeued = await requeueUnsent(tx, userId);
    const switchedToGenerated = await fallBackToGeneratedIfNoFile(tx, userId, pending.source_file_url);
    return { outcome: 'accepted', facts: pending.facts, requeued, switchedToGenerated };
  });
  if (result.outcome === 'accepted') {
    await logEvent(userId, 'facts_version_accepted', { requeued: result.requeued, switchedToGenerated: result.switchedToGenerated });
  }
  return result;
}

export type RollbackResult =
  | { outcome: 'rolled_back'; versionId: number; requeued: number; switchedToGenerated: boolean }
  | { outcome: 'nothing_to_roll_back' };

/** Reactivates the most recently superseded version, with the same re-queue as /accept. */
export async function rollbackVersion(userId: string): Promise<RollbackResult> {
  assertUserScope(userId);
  const result = await withTransaction(async (tx): Promise<RollbackResult> => {
    await lockUser(tx, userId);
    const [previous] = (await tx`
      select id, source_file_url from facts_versions
      where user_id = ${userId} and status = 'superseded'
      order by id desc
      limit 1
    `) as Array<{ id: number; source_file_url: string | null }>;
    if (!previous) return { outcome: 'nothing_to_roll_back' };

    await tx`update facts_versions set status = 'superseded' where user_id = ${userId} and status = 'active'`;
    await tx`update facts_versions set status = 'active' where id = ${previous.id}`;
    const requeued = await requeueUnsent(tx, userId);
    const switchedToGenerated = await fallBackToGeneratedIfNoFile(tx, userId, previous.source_file_url);
    return { outcome: 'rolled_back', versionId: previous.id, requeued, switchedToGenerated };
  });
  if (result.outcome === 'rolled_back') {
    await logEvent(userId, 'facts_version_rolled_back', { versionId: result.versionId, requeued: result.requeued });
  }
  return result;
}

export async function rejectPendingVersion(userId: string): Promise<boolean> {
  assertUserScope(userId);
  return withTransaction(async (tx) => {
    const rejected = await tx`
      update facts_versions set status = 'rejected' where user_id = ${userId} and status = 'pending' returning id
    `;
    return rejected.length > 0;
  });
}

export type SetFactResult = { outcome: 'updated'; createdPending: boolean } | { outcome: 'no_facts' };

/**
 * Applies `change` to the pending version, or to a new pending copy of the active one: the active
 * version is never edited in place, because only /accept may change what the verifier trusts.
 * The copy keeps the active version's PDF, since /set changes what emails say, not the file.
 */
export async function setFact(
  userId: string,
  change: (facts: MasterFacts) => MasterFacts,
  confirmsYears: boolean
): Promise<SetFactResult> {
  assertUserScope(userId);
  return withTransaction(async (tx): Promise<SetFactResult> => {
    await lockUser(tx, userId);
    const pending = await versionIn(tx, userId, 'pending');
    if (pending) {
      await tx`
        update facts_versions
        set facts = ${JSON.stringify(change(pending.facts))}, years_confirmed = years_confirmed or ${confirmsYears}
        where id = ${pending.id}
      `;
      return { outcome: 'updated', createdPending: false };
    }

    const active = await versionIn(tx, userId, 'active');
    if (!active) return { outcome: 'no_facts' };
    await tx`
      insert into facts_versions (user_id, source, facts, diff_summary, source_file_url, source_file_sha256, source_file_pages, years_confirmed, status)
      values (${userId}, 'manual', ${JSON.stringify(change(active.facts))}, 'Edited with /set', ${active.source_file_url},
              ${active.source_file_sha256}, ${active.source_file_pages}, ${active.years_confirmed || confirmsYears}, 'pending')
    `;
    return { outcome: 'updated', createdPending: true };
  });
}

export type ResumeModeResult = { outcome: 'changed'; requeued: number } | { outcome: 'unchanged' } | { outcome: 'no_stored_pdf' };

/** Uploaded mode needs an active version with a stored PDF. A change re-queues unsent applications. */
export async function setResumeMode(userId: string, mode: 'generated' | 'uploaded'): Promise<ResumeModeResult> {
  assertUserScope(userId);
  return withTransaction(async (tx): Promise<ResumeModeResult> => {
    await lockUser(tx, userId);
    const [settings] = (await tx`select resume_mode from user_settings where user_id = ${userId}`) as Array<{ resume_mode: string }>;
    if (settings.resume_mode === mode) return { outcome: 'unchanged' };
    if (mode === 'uploaded' && !(await versionIn(tx, userId, 'active'))?.source_file_url) {
      return { outcome: 'no_stored_pdf' };
    }
    await tx`update user_settings set resume_mode = ${mode} where user_id = ${userId}`;
    return { outcome: 'changed', requeued: await requeueUnsent(tx, userId) };
  });
}

/** Whether the user's active version has years of experience the user confirmed with /set years. */
export async function activeYearsConfirmed(userId: string): Promise<boolean> {
  assertUserScope(userId);
  return withTransaction(async (tx) => (await versionIn(tx, userId, 'active'))?.years_confirmed ?? false);
}
