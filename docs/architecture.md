# Architecture and ownership

## Current foundation

One TypeScript/Next.js application will run on Vercel. The product uses Telegram
as its interface, an external HTTP scheduler, Neon Postgres for durable workflow
state, and plain functions. This PR does not provision those services or install
provider SDKs.

Implemented files:

| Location                   | Responsibility                                                   |
| -------------------------- | ---------------------------------------------------------------- |
| `app/api/health/route.ts`  | Public liveness response with no provider/config access          |
| `app/layout.tsx`           | Minimal App Router layout; no product UI                         |
| `lib/auth.ts`              | Fail-closed bearer-secret verification for future cron handlers  |
| `lib/auth.test.ts`         | Missing configuration, malformed header and token mismatch cases |
| `.github/workflows/ci.yml` | Reproducible install and the local quality gate                  |

The authorization primitive receives configuration explicitly and compares token
bytes with Node's constant-time comparison after a byte-length check. No cron
endpoint exists yet; adding one requires wiring the guard before its work starts.

## Dependency direction

HTTP routes call named workflow functions. Workflow functions coordinate pure
rules and infrastructure functions. Pure rules do not perform I/O. `lib/` does
not import Next.js or routes; the lint configuration enforces that direction.

Use the spec's responsibility-based, flat `lib/` layout initially. Create modules
only when they have real behavior. Extract a feature directory when the code
develops a distinct responsibility; do not build an unused layered framework.
Controllable function arguments are enough for initial test seams.

## Target processing flow

1. **Shared intake:** X search/manual URL → optional author-only thread expansion
   → text/image extraction → shared gates → canonical shared job.
2. **Personal preparation:** fan-out → match against accepted facts → tailor
   email and selected resume content → verify → email-ready or link-ready output.
3. **Delivery:** dry-run preview, manual-link materials, or authorized Gmail send.
4. **Recovery and inbox:** reconcile uncertain sends, detect bounces/replies, save
   verified drafts and notify the user. Follow-ups remain drafts.

Jobs are shared; applications, accepted facts, settings, Gmail connections and
sending limits belong to individual users. In v3.2 a user's resume mode chooses
between a generated PDF and their original accepted PDF; both paths provide a
specific attachment reference and hash.

## Ownership

| Area                                                            | Owner                                             |
| --------------------------------------------------------------- | ------------------------------------------------- |
| Intake, X budget, threads, extraction, pure gates and fan-out   | Dev A                                             |
| Matching, tailoring, verification, parsing and PDF rendering    | Dev A                                             |
| Users, invites, consent, Telegram and settings                  | Dev B                                             |
| Gmail OAuth, token protection, sending and reconciliation       | Dev B                                             |
| Inbox/drafts, ramp, auto-pause and operational routes           | Dev B                                             |
| Shared migrations, schemas, claims, facts and handoff contracts | Joint review; name an implementation owner per PR |

`db.ts` will own database access. `claims.ts` will own claim/renew/complete helpers;
do not duplicate claim logic across both modules. DNS retrieval belongs at the I/O
boundary; a pure gate receives the lookup result. MX records concern the domain,
not the existence or correct transcription of a particular mailbox.

## Agreements required before feature implementation

- Define who publishes `verified → ready` / `link_ready` and the required fields.
- Pin one facts version and attachment identity throughout generation and sending.
  Define how `/accept`, `/rollback`, `/set` and resume-mode changes invalidate
  unsent work and stale workers without changing an existing attempt's payload.
- Agree where exact email bytes are frozen. The spec's body hash is not the body;
  reconciliation/recovery must reference the same immutable payload.
- Add an agreed application-level attachment hash when implementing persistence;
  section 8 requires it but the illustrative application schema omits the column.
- Agree safe reason codes, notification deduplication and usage-accounting helpers.
- Define canonical-job catch-up for users skipped by review caps or pauses, and
  represent separate users submitting the same manual post without losing either request.

These are recorded design questions, not implemented guarantees or changes to the
source spec. Address them in the corresponding feature PR with the other developer.

## Sending invariants for later work

Use all four controls from v3.1/v3.2: row leases, ownership tokens, per-account
reservations, and durable send attempts with reconciliation. A lease cannot undo
an external request. Stable Message-IDs support lookup, not provider deduplication.

Before enabling real sends, test the crash-after-accept, concurrent-last-slot and
stale-worker scenarios, plus cross-user access denial, against the actual relevant
boundaries. PostgreSQL locking needs PostgreSQL integration tests.
