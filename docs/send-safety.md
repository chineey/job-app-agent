# Send path safety

The send path is the one place where a bug causes harm that cannot be undone: a duplicate or wrong email reaches a recruiter from the candidate's own Gmail. This document lists the failure modes the send path must handle, how the code handles each, and the E2E scenario that proves it.

## Invariants

1. At most one attempt per Gmail account is `reserved`, `sending` or `send_unknown` at any time.
2. Daily cap, per-domain limit, spacing and send window are checked and the reservation is committed in **one** database transaction, serialized by a row lock on `send_state`.
3. Gmail is contacted only after the reservation and the `sending` transition are committed. No transaction is open during the Gmail call.
4. Only a definite rejection (an HTTP 4xx response from Gmail, or a failure before Gmail was contacted) frees a slot. A timeout, 5xx, dropped connection or crash leaves the attempt `send_unknown`; it is never retried automatically.
5. An outcome is written only if the attempt is still in the state the writer expects. A late writer cannot overwrite what reconciliation or `/resolve` already settled.
6. A user can only settle their own attempts, and only while they are `send_unknown`.

## Failure modes

| # | Failure | Before this change | Handling now | E2E scenario |
| --- | --- | --- | --- | --- |
| 1 | Two workers hold different applications for the same user when one slot is left | Each `sql` call ran as its own transaction over Neon HTTP, so `for update` released immediately; both could pass the cap check | `authorizeSend` runs in one `pg` transaction holding the `send_state` row lock | Concurrent last slot |
| 2 | A worker whose claim expired resumes after another worker reclaimed the row | Claim checked outside any lock | Application row is read `for update` with the worker's `claim_token` inside the same transaction; the stale worker finds no row | Stale worker |
| 3 | Gmail accepts the message but the response is lost (5xx, timeout) | Error text containing `400` (for example `4000ms`) was treated as a confirmed 4xx; the application went back to `ready` and was sent again | Classified by the HTTP status on the response; anything without a 4xx status is `send_unknown` | Accepted then 503 |
| 4 | The worker process dies after Gmail accepted | Attempt stuck in `sending`; reconciliation existed but was unproven | Reconciliation finds the message by RFC Message-ID and marks it sent without sending again | Worker killed mid-send |
| 5 | A late success or failure arrives after reconciliation or `/resolve` settled the attempt | Unconditional `update ... where id = $1` overwrote the settled state; a late 4xx could reset the application to `ready` | Outcome updates require `state in ('sending', 'send_unknown')`; a conflict is logged and reported instead of overwriting | Not exercised: on Vercel `maxDuration` (60s) ends the worker before reconciliation starts (2 min) |
| 6 | User B runs `/resolve <user A's attempt> notsent` | Any user could settle any attempt; settling a `sent` attempt as `notsent` made it sendable again | `/resolve` is scoped by `user_id` and only accepts `send_unknown` attempts | Cross-user and wrong-state `/resolve` |
| 7 | Token refresh fails (`invalid_grant`) or the resume cannot be fetched | Token refresh happened inside the send call; a missing resume sent the email without an attachment | Access token and resume bytes are obtained before the `sending` transition; failure there is a definite failure and Gmail is never contacted | Not exercised in this change |
| 8 | HTTP client retries the POST on its own | Depended on library defaults | `messages.send` is called with `retry: false` | Covered by scenario 3 (exactly one message reaches Gmail) |
| 9 | Next 14 serves `fetch()` from its Data Cache inside GET route handlers (every cron), POSTs included | A Telegram message with the same text as an earlier one was answered from cache and never delivered; the resume download could be a cached copy | `cache: 'no-store'` on Telegram sends and the resume download; `fetchCache = 'force-no-store'` on the send cron | Concurrent last slot and accepted-then-503 assert the notice arrives; the second run of the suite fails without the fix |

## Known gaps, not addressed here

- Other GET cron routes (`ingest`, `process`, `inbox`, `followups`, `summary`) still use the default fetch cache. `lib/x.ts` GET requests made from them can return year-old cached results.
- The attempt stores a hash of the body and of the resume URL, but the email is built from the live application row and the attachment hash is not checked. Freezing the exact payload needs the shared decision on frozen email bytes and attachment identity (see the handoff's open architecture questions).
- In dry run, every cron pass re-sends the same preview and increments `dry_run_drafts_shown`, so one application can satisfy the "5 drafts reviewed" gate.
- Invite redemption, Telegram update deduplication, and fail-open webhook/cron auth when secrets are unset.

## Proof the suite detects these bugs

Each original defect was reintroduced on its own, the server rebuilt, and the suite run twice:

| Reintroduced defect | Failing scenarios |
| --- | --- |
| Authorization without a transaction | Concurrent last slot (the second worker passed every check and crashed with a 500 on the unique index) |
| Classifying Gmail errors by message text | Accepted then 503; definite 4xx rejection |
| `/resolve` without user and state scoping | Cross-user and wrong-state `/resolve` |
| No fetch-cache opt-out | Concurrent last slot; accepted then 503 (second run only, once the cache is warm) |

## Running the E2E suite

The suite starts a throwaway Postgres cluster, a fake Google/Telegram server and the production Next.js server, then drives the real HTTP entry points (`GET /api/cron/send`, `POST /api/telegram`). No real Gmail or Telegram account is contacted.

```bash
npm run build
npm run test:e2e
```

The test-only variables `GOOGLE_API_ROOT_URL`, `GOOGLE_OAUTH_TOKEN_URL` and `TELEGRAM_API_BASE_URL` point the app at the fake server. They must stay unset in every real environment.

Requirements: Node 24 and PostgreSQL binaries (`initdb`, `pg_ctl`) on `PATH`. Reports are written to `artifacts/e2e/send-safety/` (`junit.xml`, `report.txt` and one JSON evidence file per scenario).
