# Dev B goals

Everything Dev B owns (platform, Telegram, Gmail, sending and the safety around it), written as goals, each with the E2E suite that proves it. Status as of 2 November 2026.

Every goal's suite was checked by reintroducing the original defects and confirming the scenario fails; the linked documents list each one. `npm run check` runs the whole gate (types, unit tests, production build, 56 E2E scenarios), and CI runs it on every pull request.

## Done

| Goal | Document | Suite |
| --- | --- | --- |
| Sending never duplicates, exceeds a cap, or lets one user settle another's send | `send-safety.md` | `send-safety` |
| Only invited users get in; only the admin runs admin commands; the webhook is authenticated, deduplicated and rate limited | `telegram-access.md` | `telegram-access` |
| Gmail tokens are stored safely and really revoked | `gmail-connection.md` | `gmail-connection` |
| The ramp and automatic pauses protect each sender | `ramp-and-auto-pause.md` | `ramp-and-auto-pause` |
| G1. The inbox scan handles each recruiter reply and bounce exactly once | `inbox-and-drafts.md` | `inbox-and-drafts` |
| G2. Follow-up drafts thread correctly, once, for active users, and are never sent | `inbox-and-drafts.md` | `inbox-and-drafts` |
| G3. Telegram alerts are never silently lost to broken markup | `inbox-and-drafts.md` | `inbox-and-drafts` |
| G4. Link applications reach users once, with a deadline reminder | `link-applications.md` | `link-applications` |
| G5. `/run` cannot spend shared budget; no fallback cron secret in Dev B code | `commands.md` | `commands` |
| G6. Settings and admin commands are complete and validated | `commands.md` | `commands` |
| G7. One application's error does not stop the send pass; chats are rate limited; old update ids are pruned; `/delete_me` deletes events | `commands.md`, `telegram-access.md` | `commands`, `telegram-access` |
| G8. CI runs the full gate on every pull request | `.github/workflows/ci.yml` | all |
| G9. Resume onboarding: uploads checked before parsing, one pending and one active version, `/accept` needs confirmed years, `/set` never edits the active version, `/accept` and `/rollback` re-queue unsent work, uploaded mode needs a stored PDF | `resume-onboarding.md` | `resume-onboarding` |

## Needs a decision with Dev A

These cross the Dev A / Dev B boundary, so they are proposals, not work Dev B should do alone.

- **Frozen payload.** The send attempt should store the exact email bytes and the resume's content hash, and the send must use those. Needs agreement on who freezes the payload and how the resume file is identified.
- **`verified` → `ready` ownership**, the facts version carried through to the send, and how an edit invalidates unsent work.
- **Reply drafts and the truth verifier.** The spec asks for Dev A's verifier to check reply drafts; they are only drafts today.
- **Bounce retry to a second address** (spec section 13) needs Dev A to extract and store alternate addresses.
- **Resume file deletion on `/delete_me`.** Dev A's pipeline writes the files to Vercel Blob; agree which side deletes them.
- **Storing uploaded PDFs** privately (spec: private Blob path). Until then uploaded resume mode is refused.
- **PDF parsing fix in Dev A's file.** `pdf-parse` misread uploaded PDFs depending on Node's buffer pool (17 of 30 valid uploads rejected). `lib/parse-resume.ts` now passes a plain `Uint8Array`; Dev A should review (`resume-onboarding.md`).
- **Re-queue scope.** Whether `matched` and unsent `link_ready` applications should also regenerate when facts change.
- **Manual post ingest.** Pasting a post URL triggers processing but never ingests the post.
- **Testing policy.** `AGENTS.md` (E2E first) is not on `master`, while `master` has vitest unit tests. CI now runs both.
- **Dev A code flagged during review.** The ingest and process cron routes use Next's fetch cache (X searches can be a year stale), and `scripts/pipeline.js` has a hardcoded `CRON_SECRET`.
- **Shared driver.** `lib/db.ts` moved from the Neon HTTP driver to `pg` so sends can use real transactions; Dev A should confirm.

## Before deploying

- Re-run `schema.sql`. Every statement uses `if not exists`, so this is safe.
- Set `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET` and a 32-byte `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`).
- Leave the test-only variables unset: `GOOGLE_API_ROOT_URL`, `GOOGLE_OAUTH_ROOT_URL`, `TELEGRAM_API_BASE_URL` and `GEMINI_API_BASE_URL`.
