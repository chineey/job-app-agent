import { neon, neonConfig } from '@neondatabase/serverless';

const connectionString = process.env.DATABASE_URL || 'postgres://mock:mock@localhost:5432/mock';

export const sql = neon(connectionString);

/**
 * Log an audit/system event to the events table.
 */
export async function logEvent(
  userId: string | null,
  type: string,
  detail: Record<string, unknown>,
  jobId: string | null = null,
  applicationId: string | null = null
): Promise<void> {
  try {
    await sql`
      insert into events (user_id, job_id, application_id, type, detail)
      values (${userId}, ${jobId}, ${applicationId}, ${type}, ${JSON.stringify(detail)})
    `;
  } catch (err) {
    console.error('Failed to log event:', err);
  }
}

/**
 * Safe query helper that enforces user_id isolation on user-owned tables.
 */
export function assertUserScope(userId: string): void {
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new Error('User isolation violation: userId is required for user-scoped queries');
  }
}
