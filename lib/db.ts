import { Pool, type PoolClient, type QueryResultRow } from 'pg';

// node-postgres over TCP. Neon accepts it (use the pooled connection string), and unlike the
// Neon HTTP driver it supports interactive transactions, which send authorization needs.
// It also runs against a plain local Postgres, which the E2E suite uses.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

/** Tagged-template query. Interpolated values become bind parameters, never SQL text. */
export type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<QueryResultRow[]>;

function toParameterizedText(strings: TemplateStringsArray): string {
  return strings.reduce((text, part, index) => `${text}$${index}${part}`);
}

function sqlFor(client: Pool | PoolClient): Sql {
  return async (strings, ...values) => {
    const result = await client.query(toParameterizedText(strings), values);
    return result.rows;
  };
}

export const sql: Sql = sqlFor(pool);

/** Runs a parameterized query whose text is built at runtime, e.g. with a quoted identifier. */
export async function query(text: string, values: unknown[]): Promise<QueryResultRow[]> {
  const result = await pool.query(text, values);
  return result.rows;
}

/**
 * Runs `work` inside one transaction on one connection. Commits if it resolves, rolls back if it throws.
 * Never call an external service (Gmail, Telegram) from inside `work`.
 */
export async function withTransaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let connectionBroken = false;
  try {
    await client.query('begin');
    const result = await work(sqlFor(client));
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      connectionBroken = true;
    }
    throw err;
  } finally {
    client.release(connectionBroken);
  }
}

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
