import { sql } from './db';
import { JobRecord } from './claims';

export interface FanoutResult {
  fannedOutCount: number;
  userIds: string[];
}

/**
 * Fan-out stage (Section 7.4)
 * Evaluates newly extracted jobs and creates applications rows for eligible users.
 */
export async function fanoutJobToEligibleUsers(job: JobRecord): Promise<FanoutResult> {
  const isManual = job.source === 'manual';
  const submittingUserId = job.submitted_by;
  const today = new Date().toISOString().slice(0, 10);

  // 1. Fetch eligible active users with active facts
  const eligibleUsers = (await sql`
    select 
      u.id as user_id,
      us.daily_read_cap,
      coalesce(usp.reviewed, 0) as reviewed_today,
      fv.id as facts_version_id
    from users u
    join user_settings us on us.user_id = u.id
    join facts_versions fv on fv.user_id = u.id and fv.status = 'active'
    left join user_spend usp on usp.user_id = u.id and usp.day = ${today}
    where u.status = 'active'
      and us.paused = false
      ${isManual && submittingUserId ? sql`and u.id = ${submittingUserId}` : sql``}
  `) as { user_id: string; daily_read_cap: number; reviewed_today: number; facts_version_id: number }[];

  // Filter users by review budget
  const usersUnderBudget = eligibleUsers.filter(
    (u) => Number(u.reviewed_today) < Number(u.daily_read_cap)
  );

  // 2. Filter users by 30-day contact email dedupe (if email route)
  const qualifiedUsers: typeof usersUnderBudget = [];
  for (const user of usersUnderBudget) {
    if (job.contact_email) {
      const pastApplications = (await sql`
        select id from applications
        where user_id = ${user.user_id}
          and contact_email = ${job.contact_email}
          and created_at >= now() - interval '30 days'
        limit 1
      `) as { id: string }[];

      if (pastApplications.length > 0) {
        // Skip user - already applied or queued to this email in last 30 days
        continue;
      }
    }
    qualifiedUsers.push(user);
  }

  // 3. Shuffle qualified users randomly so the same people are not always first
  const shuffled = [...qualifiedUsers].sort(() => Math.random() - 0.5);

  // Max applications per job (default 10)
  const maxAppsSetting = (await sql`
    select value from global_settings where key = 'max_applications_per_job' limit 1
  `) as { value: string }[];
  const maxApps = maxAppsSetting.length > 0 ? parseInt(maxAppsSetting[0].value, 10) : 10;

  const selectedUsers = shuffled.slice(0, maxApps);

  const createdUserIds: string[] = [];

  for (const user of selectedUsers) {
    const route = job.apply_method === 'email' ? 'email' : 'link';

    // Insert application row
    await sql`
      insert into applications (
        user_id,
        job_id,
        contact_email,
        route,
        facts_version_id,
        status
      )
      values (
        ${user.user_id},
        ${job.id},
        ${job.contact_email},
        ${route},
        ${user.facts_version_id},
        'queued'
      )
      on conflict (user_id, job_id) do nothing
    `;

    // Increment user reviewed count for today
    await sql`
      insert into user_spend (user_id, day, reviewed)
      values (${user.user_id}, ${today}, 1)
      on conflict (user_id, day) do update
      set reviewed = user_spend.reviewed + 1
    `;

    createdUserIds.push(user.user_id);
  }

  // Update job fanned_out_at timestamp
  await sql`
    update jobs
    set fanned_out_at = now()
    where id = ${job.id}
  `;

  return {
    fannedOutCount: createdUserIds.length,
    userIds: createdUserIds,
  };
}
