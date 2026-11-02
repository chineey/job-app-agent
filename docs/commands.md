# User and admin commands

The Telegram commands not covered by the other documents: running a pass early, settings, the user's own application lists, and admin controls. Every user command is scoped to the caller's own rows.

## Rules

1. `/run` runs the send pass, the same one the send cron runs, under every cap and lock. Only the admin's `/run` also starts ingest and processing, which spend the shared X and Gemini budget.
2. No Dev B code has a fallback cron secret; without `CRON_SECRET` the admin tools refuse to run.
3. `/reads N` must be between 1 and the user's admin-set ceiling.
4. `/skip <id>` skips the user's own application only before it is reserved for sending. A single conditional update makes this safe against a send worker reserving the same row.
5. `/import` records each past recipient address once per user and reports entries that are not addresses.
6. `/last` and `/drafts` show only the caller's applications.
7. `/suspend` and `/unsuspend` move only between active and suspended, never touch the admin or a deleted account, and refuse unknown ids. A suspended user sends nothing.
8. `/limits <user_id> cap N reads N` sets ceilings within 20 and 300; the user's current values are lowered to fit, never raised.
9. `/admin xreads N` and `/admin threads N` stay within the hard daily X read limit (`X_MAX_DAILY_READS`, 300).
10. One application's unexpected error is logged and counted; the send pass continues for everyone else.

## Failure modes

| # | Failure | Before | Handling now | E2E scenario |
| --- | --- | --- | --- | --- |
| 1 | Any user sends `/run` | Started the shared X ingest and Gemini processing for everyone, using a hardcoded cron secret as a fallback | Users get the send pass; ingest and processing are admin-only; no fallback secret | `/run` by a user |
| 2 | `/suspend` with a typo or unknown id | Reported success; could also flip a deleted or pending account to active via `/unsuspend` | Validated; refuses unknown, deleted, pending and admin accounts | Admin controls |
| 3 | `/limits`, `/reads`, `/skip`, `/last`, `/drafts`, `/import`, `/admin xreads`, `/admin threads`, `/admin ingest` | Not implemented ("Unknown command") | Implemented with validation | Commands scenarios |
| 4 | One user's bad data (an unknown timezone) | Threw inside the send loop and failed the whole cron with 500: no one's applications were sent | Isolated per application | Send pass isolation |

## Known gaps

- Pasting a post URL triggers processing but does not ingest the post: manual ingest belongs to Dev A's pipeline.
- `/admin threads` uses the X read limit as its ceiling because the spec gives no separate one.

## Proof the suite detects these bugs

Reintroduced and confirmed failing: `/skip` regardless of status, and the send loop without per-application isolation (the whole cron answered 500). The user `/run` scenario was not mutated, because the old behaviour would call the real X API.

## Running

These scenarios are in `e2e/commands.e2e.mts` and run with the rest of the suite (`npm run build && npm run test:e2e`).
