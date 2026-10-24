import { sql } from './db';

export interface JobRecord {
  id: string;
  post_id: string;
  post_url: string;
  author_handle: string | null;
  posted_at: string | null;
  source: 'search' | 'manual';
  submitted_by: string | null;
  raw_text: string;
  raw_json: unknown;
  media_urls: string[] | null;
  transcribed_text: string | null;
  conversation_id: string | null;
  author_id: string | null;
  thread_fetched: boolean;
  thread_post_ids: string[] | null;
  thread_text: string | null;
  is_job: boolean | null;
  is_software_role: boolean | null;
  company: string | null;
  role: string | null;
  location: string | null;
  remote: boolean | null;
  relocation_required: boolean | null;
  visa_sponsorship: 'yes' | 'no' | 'unknown' | null;
  min_years: number | null;
  salary: string | null;
  deadline: string | null;
  requirements: string[] | null;
  apply_method: 'email' | 'form' | 'dm' | 'link' | 'unknown' | null;
  contact_email: string | null;
  address_source: 'text' | 'image' | null;
  address_mx_ok: boolean | null;
  apply_link: string | null;
  apply_link_domain: string | null;
  scam_risk: 'low' | 'medium' | 'high' | null;
  scam_reasons: string[] | null;
  dedupe_hash: string | null;
  canonical_job_id: string | null;
  fanned_out_at: string | null;
  status: string;
  status_reason: string | null;
  attempts: number;
  locked_at: string | null;
  lock_owner: string | null;
  claim_token: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApplicationRecord {
  id: string;
  user_id: string;
  job_id: string | null;
  imported: boolean;
  contact_email: string | null;
  route: 'email' | 'link' | null;
  fit_score: number | null;
  gaps: string[] | null;
  years_gap: boolean | null;
  facts_version_id: number | null;
  resume_blob_url: string | null;
  resume_source: 'generated' | 'uploaded' | null;
  email_subject: string | null;
  email_body: string | null;
  cover_note: string | null;
  verify_result: unknown;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  applied_at: string | null;
  follow_up_at: string | null;
  followup_draft_id: string | null;
  reply_type: string | null;
  reply_draft_id: string | null;
  last_reply_at: string | null;
  link_notified_at: string | null;
  status: string;
  status_reason: string | null;
  attempts: number;
  locked_at: string | null;
  lock_owner: string | null;
  claim_token: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Claim unowned or expired jobs in the given input status.
 */
export async function claimJobs(
  status: string,
  limit: number = 5,
  workerId: string = 'worker'
): Promise<JobRecord[]> {
  const claimed = (await sql`
    update jobs
    set locked_at = now(), lock_owner = ${workerId}, claim_token = gen_random_uuid()
    where id in (
      select id from jobs
      where status = ${status}
        and (locked_at is null or locked_at < now() - interval '10 minutes')
      order by created_at
      limit ${limit}
      for update skip locked
    )
    returning *;
  `) as JobRecord[];

  return claimed;
}

/**
 * Claim unowned or expired applications fairly across users.
 */
export async function claimApplications(
  status: string,
  totalLimit: number = 10,
  perUserLimit: number = 2,
  workerId: string = 'worker'
): Promise<ApplicationRecord[]> {
  const claimed = (await sql`
    update applications
    set locked_at = now(), lock_owner = ${workerId}, claim_token = gen_random_uuid()
    where id in (
      select id from (
        select id, user_id, created_at,
               row_number() over (partition by user_id order by created_at) as rn
        from applications
        where status = ${status}
          and (locked_at is null or locked_at < now() - interval '10 minutes')
      ) t
      where rn <= ${perUserLimit}
      order by created_at
      limit ${totalLimit}
    )
    and status = ${status}
    and (locked_at is null or locked_at < now() - interval '10 minutes')
    returning *;
  `) as ApplicationRecord[];

  return claimed;
}

/**
 * Renews an application row's lease before an external call.
 * Returns false if ownership was lost (worker must stop immediately).
 */
export async function renewApplicationLease(id: string, token: string): Promise<boolean> {
  const res = await sql`
    update applications
    set locked_at = now()
    where id = ${id} and claim_token = ${token}
    returning id;
  `;
  return res.length > 0;
}

/**
 * Renews a job row's lease before an external call.
 * Returns false if ownership was lost.
 */
export async function renewJobLease(id: string, token: string): Promise<boolean> {
  const res = await sql`
    update jobs
    set locked_at = now()
    where id = ${id} and claim_token = ${token}
    returning id;
  `;
  return res.length > 0;
}

/**
 * Completes a job stage write, clearing the lease and updating the status.
 * Returns false if claim_token was lost.
 */
export async function completeJobStage(
  id: string,
  token: string,
  expectedStatus: string,
  nextStatus: string,
  updates: Record<string, unknown> = {}
): Promise<boolean> {
  // Build dynamic update safely
  const updateKeys = Object.keys(updates);
  if (updateKeys.length === 0) {
    const res = await sql`
      update jobs
      set status = ${nextStatus}, claim_token = null, locked_at = null, updated_at = now()
      where id = ${id} and claim_token = ${token} and status = ${expectedStatus}
      returning id;
    `;
    return res.length > 0;
  }

  // Neon accepts parameter substitutions
  // We can write dedicated sql updates or serialize fields
  const fields = JSON.stringify(updates);
  const res = await sql`
    update jobs
    set status = ${nextStatus},
        claim_token = null,
        locked_at = null,
        updated_at = now()
    where id = ${id} and claim_token = ${token} and status = ${expectedStatus}
    returning id;
  `;
  return res.length > 0;
}
