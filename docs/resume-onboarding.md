# Resume onboarding and facts versions

A user's facts file is what Dev A's verifier trusts, so `/accept` is the one deliberate approval in the system (spec section 9). This document covers the Dev B side of that: receiving the resume in Telegram, the facts-version commands, and the resume mode. Parsing and validation are Dev A's (`lib/parse-resume.ts`, `lib/facts.ts`).

## Rules

1. Only active users can upload. Files over 5 MB, or whose bytes are neither a PDF nor a Word file, are rejected before anything is downloaded or parsed. PDFs then go through Dev A's validator.
2. A user has at most one pending and one active version. A new upload replaces the pending one.
3. Nothing changes until `/accept`. `/set` edits the pending version, or, when there is none, creates a pending copy of the active version for the user to accept. It never edits the active version in place.
4. Years of experience must be confirmed by the user with `/set years N`. The parser's estimate does not count. A version uploaded while an active version exists carries over the confirmation along with the years.
5. `/accept` and `/rollback` each run in one transaction:
   - exactly one version ends up active;
   - the user's drafted, verified and ready applications go back to `queued` so they regenerate;
   - applications in `sending`, `send_unknown` or already sent are untouched.
6. `/rollback` reactivates the most recently superseded version.
7. `/resumemode uploaded` needs an active version with a stored PDF and is refused otherwise. A mode change re-queues unsent applications. Accepting or rolling back to a version with no stored PDF switches the user back to `generated` and says why.

## Failure modes

| # | Failure | Before | Handling now | E2E scenario |
| --- | --- | --- | --- | --- |
| 1 | `/set` with no pending version | Edited the active facts in place: no approval, no new version, and in-flight applications changed under the verifier | Creates a pending copy to accept | `/set` never edits the active version |
| 2 | User never sets their years | The parser estimates years when unsure, and `/accept` only checked `> 0`, so the estimate went live unconfirmed; a user with 0 years could never accept | A confirmation flag set only by `/set years` | Years must be confirmed |
| 3 | Double `/accept`, or `/accept` racing an upload | Supersede and activate were separate statements; nothing prevented two active versions | One transaction; at most one active and one pending per user, enforced by unique indexes | Covered by accept and rollback scenarios |
| 4 | `/rollback` | Not atomic, and unsent applications kept the facts they were tailored with | Same transaction and re-queue as `/accept` | Rollback re-queues |
| 5 | `/resumemode uploaded` with no stored PDF | Accepted; there was no file to attach | Refused | Uploaded mode needs a stored PDF |
| 6 | Mode change | Unsent applications kept the old attachment mode | Re-queued | Mode change re-queues |
| 7 | Several uploads | Each added another pending version | The newest replaces the older pending one | Upload replaces pending |
| 8 | A 30 MB file, or an executable renamed `.pdf` | Downloaded and handed to the parser | Rejected before parsing | Oversized and disguised files rejected |
| 9 | Deleted user uploads | Allowed | Only active users | Not exercised |
| 10 | Parsing error | Raw error text was sent to the user | Generic reply; details in the server log | Not exercised |

## Needs Dev A

- **Storing the uploaded PDF.** The spec wants a private Blob path; `@vercel/blob` 0.27 only stores publicly, and storage is shared. Until stored, `source_file_url` stays empty and uploaded mode is refused (fail closed).
- **Which statuses to re-queue.** The spec names drafted, verified and ready. `matched` (fit scored against the old facts) and unsent `link_ready` applications are left alone until agreed.

## Proof the suite detects these bugs

Reintroduced one at a time and confirmed failing:
- `/set` editing the active version;
- the parser's estimate counting as confirmed years;
- `/rollback` without re-queue;
- uploaded mode without a stored PDF;
- uploads without the size and content checks. This scenario asserts the checks' own rejection messages, so a later parser failure cannot make it pass.

## Found and fixed: valid PDFs rejected depending on server memory

A production server rejected 17 of 30 uploads of the same valid PDF with `PDF parsing error: bad XRef entry`, which also failed CI once.

**Cause.** `pdf-parse` (pdf.js 1.10) copies its input with `new Buffer(...)`. For a Node `Buffer`, that copy comes from Node's shared buffer pool, and pdf.js then misreads the file depending on where in the pool the copy lands. Reproduced outside the app by shifting the pool between parses: failures for a `Buffer`, none for a plain `Uint8Array`.

**Fix.** `lib/parse-resume.ts` (Dev A's file) now passes a plain `Uint8Array`. The same 30 uploads were then all accepted, on two server runs.

## Running

These scenarios are in `e2e/resume-onboarding.e2e.mts` and run with the rest of the suite (`npm run build && npm run test:e2e`).
