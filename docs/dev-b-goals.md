# Dev B goals

Everything Dev B owns (platform, Telegram, Gmail, sending and the safety around it), written as goals with a test that proves each. Status as of 2 November 2026. Each goal's detail lives in the linked document.

## Done

| Goal | Proof |
| --- | --- |
| Sending never duplicates, exceeds a cap, or lets one user settle another's send | `docs/send-safety.md`, `e2e/send-safety.e2e.mts` |
| Only invited users get in; only the admin runs admin commands; webhook is authenticated | `docs/telegram-access.md`, `e2e/telegram-access.e2e.mts` |
| Gmail tokens are stored safely and really revoked | `docs/gmail-connection.md`, `e2e/gmail-connection.e2e.mts` |
| The ramp and automatic pauses protect each sender | `docs/ramp-and-auto-pause.md`, `e2e/ramp-and-auto-pause.e2e.mts` |

## In progress

### G1. The inbox scan handles each recruiter reply and bounce exactly once
- Each inbound message is classified, drafted and alerted once; a later message in the same thread is still seen.
- Threads are checked in rotation, not the same ten every run.
- A bounce marks only an application sent before it, and only one.
- Losing Gmail access during a scan pauses the user and asks them to reconnect.
- Reply drafts thread on the recruiter's message and are never sent.

### G2. Follow-up drafts are correct and never sent
- Only for active users, at most once per application.
- Threaded on the original application's Message-ID so the recruiter sees one conversation.

### G3. Telegram alerts are never silently lost
- Untrusted text (recruiter snippets, email bodies) can break Telegram's Markdown parsing, and the message was dropped without trace. A rejected message is resent as plain text.

### G4. Link applications reach users
- Each `link_ready` application is sent to its user once, as a card with the apply link's domain shown.
- `/links` lists the ones waiting; `/done <id>` only marks the user's own waiting link application.

### G5. `/run` cannot spend shared budget or leak secrets
- Users trigger only the send pass (the same one the cron runs, under every cap and lock). Ingest and processing, which spend the shared X and Gemini budget, are admin-only.
- No hardcoded cron secret anywhere in Dev B code.

### G6. Settings and admin commands are complete and validated
- `/reads` (up to the admin ceiling), `/skip <id>`, `/last`, `/drafts`.
- Admin: `/limits <user_id> cap N reads N`, `/suspend` and `/unsuspend` reject unknown ids, `/admin xreads N` and `/admin threads N` within their hard limits.

### G7. Operations are robust
- One application's unexpected error does not abort the send pass for everyone else.
- Per-chat rate limit on the webhook (30 per minute).
- `telegram_updates` rows older than a day are pruned.
- `/delete_me` also deletes the user's events.

### G8. CI runs the full gate on every pull request
- Type check, unit tests, production build and every E2E suite, with Postgres, on each push.

## Needs a decision with Dev A

These cross the Dev A / Dev B boundary, so they are proposals, not work Dev B should do alone.

- **Frozen payload.** The send attempt should store the exact email bytes and the resume's content hash, and the send must use those. Needs agreement on who freezes the payload and how the resume file is identified.
- **`verified` → `ready` ownership**, facts version carried through to the send, and how an edit invalidates unsent work.
- **Bounce retry to a second address** (spec section 13) needs Dev A to extract and store alternate addresses.
- **Resume file deletion on `/delete_me`**: the files are written by Dev A's pipeline to Vercel Blob; agree which side deletes them.
- **Testing policy and CI scope**: `AGENTS.md` (E2E first) is not on `master`, while `master` has vitest unit tests.
- **Dev A code flagged during review**: GET cron routes use Next's fetch cache (X searches can be a year stale); `scripts/pipeline.js` has a hardcoded `CRON_SECRET`.
