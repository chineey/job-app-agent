# X Job Application Agent: Build Spec (v3.2, multi-user)

A TypeScript tool that finds job posts on X (text and image posts), extracts the role details once, then lets each invited user's own resume and settings decide what happens next. For each user it tailors a resume PDF and application email, sends the application from that user's own Gmail, and logs everything. Recruiter replies and follow-ups are drafted for the user to send. Everything the user does (upload a resume, connect Gmail, set limits, pause, review alerts) happens in Telegram. There is no manual approval before an application is sent, so safety comes from hard gates in code, a slow per-user ramp, a dry-run mode for every new user, and pause switches.

v3 is built for a small, invited test group (roughly 3 to 20 people), not a public launch.

---

## 0. What changed from v2

| Area | v2 | v3 |
|---|---|---|
| Users | One person | Many invited users, each with their own resume facts, Gmail, settings, ramp and alerts |
| Telegram access | One allowed chat ID | `users` table, invite codes, admin role |
| Gmail | One refresh token in env vars | Per-user OAuth through a Telegram link, refresh token encrypted in Postgres |
| Settings | Global key/value | Per-user settings, plus a small set of global admin settings |
| X reads and extraction | One person's budget | One shared X budget and one shared extraction per post. Each user has their own limit on how many shared posts are reviewed for them per day |
| Jobs table | One row did everything | `jobs` holds shared post data. `applications` holds each user's matching, resume, email and send state |
| Resume | Generated from a fixed template | **Default unchanged.** A fresh PDF from one fixed template. From v3.2 each user can instead attach their own uploaded PDF (`resume_mode`) |
| Personal details | From facts | Same, now stated as locked: name, contact details and links come from code, never the LLM |
| Row claiming | Set `status = 'processing'` | Claim sets a lease only and leaves status unchanged, so crashed rows are reclaimed correctly |
| Cleanups | Duplicate decision row, duplicate `link_notified_at` column | Removed |
| Personal hard-coding | Name in file name, project IDs, framing text | Moved into each user's facts |

### Changes in v3.1 (sending and concurrency review)

| Gap found | Fix | Where |
|---|---|---|
| A crash or timeout after Gmail accepts a message could cause a second send, because a database transaction cannot include Gmail's action | A durable `send_attempts` record is written before Gmail is called, with a stable RFC Message-ID and states `reserved`, `sending`, `sent`, `failed`, `send_unknown`, `released`. Uncertain outcomes are reconciled against the user's Sent mail and otherwise resolved by a person. Nothing resends automatically | 6, 7.8, 7.9, 7.9a |
| Two workers handling different applications for the same Gmail account could both pass the cap, spacing and recipient-domain checks | Send authorization is serialized per user: lock the user's `send_state`, check limits including pending and uncertain attempts, reserve a slot, commit, then call Gmail. One active send per account | 6, 7.8 |
| An expired lease does not prove the earlier worker stopped, so a delayed worker could publish stale results | Every claim carries a unique `claim_token`. Completion writes must match the token and expected status, leases are renewed, and a worker that lost its claim stops. Send outcomes are recorded against the attempt, not the lease | 4, 4.1 |
| The spec said row claiming and status checks make every retry a no-op | Replaced by four explicit guarantees | 4.1 |

### Changes in v3.2 (resume mode)

| Request | Change | Where |
|---|---|---|
| Let a user attach their own resume instead of a generated one | New per-user setting `resume_mode`: `generated` (default, the fixed template) or `uploaded` (the user's own PDF attached byte for byte). Set with `/resumemode`. Uploaded PDFs are validated, stored privately, and hashed. In uploaded mode only the email is tailored | 3.4, 3.5, 6, 7.6, 7.7, 7.13, 8, 9, 11, 13 |

---

## 1. Decisions

| Area | Choice |
|---|---|
| Language and framework | TypeScript, Next.js route handlers on Vercel |
| Scheduler | External cron service calling secured routes (no dependency on Vercel Cron) |
| Database | Neon Postgres |
| LLM | Gemini, structured JSON output, with vision for image posts |
| Job source | X API v2 recent search (shared by all users) plus manual URL ingest via Telegram |
| Users | Small invited group. Invite code or admin allowlist, one Telegram account per user |
| Role scope | Any software role (fullstack, backend, AI/ML, automation, others) |
| Location scope | Anywhere, including relocation, subject to each user's own `open_to_relocation` fact |
| Pay filter | None (pay is extracted and logged only) |
| Experience gap | Apply anyway and name the gap honestly |
| Sending | Gmail API from each user's own Gmail, connected by OAuth |
| Send safety | Per-account send reservations (one active send per account, cap and spacing enforced under a lock), a durable send-attempt record before every Gmail call, reconciliation of uncertain outcomes, and no automatic resend after an uncertain outcome |
| Volume | Per-user ceiling of 20 per day (admin can lower it per user), reached by a gradual per-user ramp |
| Resume | By default, a new PDF generated per job from the user's master facts, using one fixed template for everyone. Each user can choose `/resumemode uploaded` to attach their own PDF unchanged instead |
| Resume rewriting | None in v1. The model selects and orders the user's own bullets, projects and skills |
| Personal details | In generated mode, name, email, phone, links, education, employers, titles, dates and certs are rendered by code from the facts and never produced by the LLM. In uploaded mode the tool never edits the file | 
| Image posts | Read with Gemini vision |
| Posts with an application link or form | Logged and sent to the user on Telegram with a tailored resume PDF and a suggested cover note. The user applies themselves. The tool never opens, fetches, or fills the link |
| Recruiter replies | Draft a reply in the user's Gmail for the user to send |
| Follow-ups | Draft only, the user sends |
| X API budget | Under $20 per month for the whole group |
| Alerts and control | Telegram bot, one private chat per user |
| Approval | None before sending. Automated gates, caps, ramp, dry-run, `/pause`. The only deliberate approval is `/accept` on a new facts version |
| Agent framework | None. Plain functions |

---

## 2. Architecture

```
X search (scheduled, shared)     Telegram URL paste (per user)
          |                               |
          v                               v
       [ingest] ------------------> jobs (status = found)
                                      |
                              [extract]  Gemini: text + images -> structured fields (once per post)
                                      |
                              [gates 1]  shared rules in code (job level)
                                      |
                              [fan-out]  one application per eligible user, within each user's daily review limit
                                      |
        ---------------- per user from here (applications) ----------------
                                      |
                              [gates 2]  per-user dedupe
                                      |
                              [match]    fit score + gaps vs the user's facts
                                      |
                              [tailor]   resume JSON -> PDF, email slots
                                      |
                              [verify]   second Gemini call vs the user's facts
                                      |
                              [authorize] per-account reservation: pause, cap, window, spacing, domain limit, dry-run
                                      |
                              [send]     durable attempt record, then Gmail API (the user's account) + PDF
                                      |
                              [reconcile] uncertain sends checked against the user's Sent mail
                                      |
                  +-------------------+--------------------+
                  v                   v                    v
            [bounce/reply scan]  [reply drafter]     [follow-up drafter]
                                      |
                  Telegram alerts to the user (sends, blocks, replies, daily summary)
```

Extraction, thread expansion and shared gates run once per post no matter how many users there are. Match, tailor, verify and send run once per user per post. Every stage reads and writes a `status` column. A stage only picks up rows in its input status and must still hold its claim when it writes a result (section 4.1).

---

## 3. Users, onboarding and access

### 3.1 Roles

- **Admin:** you. Identified by `ADMIN_CHAT_ID`. Creates invites, sets global limits, can suspend users, and also uses the bot as a normal user.
- **User:** an invited person. Can only see and change their own data.

### 3.2 Onboarding flow (each user, once)

1. Admin runs `/invite` and gets a one-time code. Admin sends it to the person.
2. The person messages the bot `/start <code>`. The bot checks the code (unused, not expired, user count under `MAX_USERS`), creates the user, and shows a short privacy notice. The person replies `/agree` to continue. Until then the user is `pending` and every other command is refused.
3. The person sends their resume as a PDF or Word file. The bot extracts the text, builds a proposed facts version, and sends a summary. The person fixes years and relocation with `/set years N` and `/set relocation yes|no`, then sends `/accept`.
4. The person sends `/connect`. The bot replies with a one-time Google sign-in link. They approve Gmail access and the bot confirms "Gmail connected as name@gmail.com".
5. The person sets preferences, for example `/reads 100`, `/cap 3`, `/window 9 17`, `/timezone Africa/Lagos`.
6. Every new user starts in **dry run**. See section 12 for the conditions to turn it off.

Users with no accepted facts version, or who are paused, suspended, or deleted, are never fanned out to (section 7.4).

### 3.3 Gmail connect flow

1. `/connect` creates a row in `oauth_states` with a random `state`, the `user_id`, and a 10-minute expiry. The bot sends `${APP_BASE_URL}/api/oauth/gmail/start?state=...`.
2. `/start` route validates the state, then redirects to Google's consent URL with `access_type=offline`, `prompt=consent`, the three Gmail scopes (section 10), and the same `state`.
3. Google redirects to `/api/oauth/gmail/callback`. The route checks the `state` (exists, unused, not expired), exchanges the code for tokens, calls `users.getProfile` to read the Gmail address, encrypts the refresh token with AES-256-GCM using `TOKEN_ENCRYPTION_KEY`, stores it on the user row, marks the state used, and sends a Telegram confirmation.
4. If Google returns no refresh token (the user previously authorized and Google skipped it), the route tells the user to revoke the app at their Google account permissions page and run `/connect` again.
5. `/disconnect` revokes the token with Google, deletes it from the database, and sets `gmail_status = 'disconnected'`.

Tokens are decrypted only inside the function that needs them, and access tokens are never stored.

### 3.4 What each user controls (and what they cannot)

| User controls | Admin controls |
|---|---|
| Pause, resume, dry run (with conditions), cap up to their ceiling, send window, timezone, daily review limit up to their ceiling, resume upload, resume mode (generated or uploaded), facts accept/reject/rollback | Invites, user suspension, per-user ceilings (`max_cap`, `max_reads_ceiling`), global X read limit, global thread limit, global pause |

### 3.5 Privacy and data handling

- Show a plain-language notice at `/start`: what is stored (parsed resume facts, generated PDFs, the uploaded resume PDF, applications, encrypted Gmail token), that the tool sends email from their account, and that it only reads mail it needs (section 10).
- Store `consented_at` and `consent_version`.
- Word files are parsed and discarded. PDF uploads are kept privately, because uploaded mode attaches them unchanged. Retention rules are in section 8 under Resume mode.
- `/delete_me` revokes the Gmail token, deletes the user's facts, applications, events, uploaded resume files and Blob PDFs, and marks the user `deleted`.

---

## 4. Scheduling with an external cron

Use cron-job.org, QStash, or similar to call your routes. Vercel Cron on the Hobby plan is limited to once per day, so it is only an optional fallback.

- Every request carries `Authorization: Bearer ${CRON_SECRET}`. Routes return 401 without it.
- If Vercel Deployment Protection is on, configure the protection bypass for these routes or the scheduler will be blocked. The OAuth callback and the Telegram webhook must also be reachable from the public internet.
- External schedulers may retry on failure, so every route must tolerate being called twice. Section 4.1 says exactly which guarantees make that safe.
- Set `maxDuration` on each route within your plan's limit and process small batches.

### Overlap protection (row claiming with a lease and an ownership token)

Neon's HTTP driver runs each query as a separate stateless request, so session-level advisory locks do not hold between statements. Claim rows with a lease instead. The claim sets `locked_at`, `lock_owner` and a fresh `claim_token`, and **leaves `status` unchanged**. When the stage finishes it writes the next status and clears the lease, but only if it still owns the claim. A crashed run leaves the old status and an expired lease, so the next run can pick the row up again.

Jobs (shared stages):

```sql
update jobs
set locked_at = now(), lock_owner = $1, claim_token = gen_random_uuid()
where id in (
  select id from jobs
  where status = $2
    and (locked_at is null or locked_at < now() - interval '10 minutes')
  order by created_at
  limit $3
  for update skip locked
)
returning *;   -- includes claim_token
```

Applications (per-user stages, fair across users): choose candidates with at most `$4` rows per user, then re-check the status and lease on the update so two overlapping runs cannot both take the same row.

```sql
update applications
set locked_at = now(), lock_owner = $1, claim_token = gen_random_uuid()
where id in (
  select id from (
    select id, user_id, created_at,
           row_number() over (partition by user_id order by created_at) as rn
    from applications
    where status = $2
      and (locked_at is null or locked_at < now() - interval '10 minutes')
  ) t
  where rn <= $4
  order by created_at
  limit $3
)
and status = $2
and (locked_at is null or locked_at < now() - interval '10 minutes')
returning *;   -- includes claim_token
```

Completion write (every stage, for jobs and applications):

```sql
update applications
set status = $next, /* stage results */ claim_token = null, locked_at = null
where id = $id and claim_token = $token and status = $expected;
-- 0 rows updated: ownership was lost. The worker discards its results and stops.
```

Lease renewal (call before each external call and between steps of a long stage):

```sql
update applications set locked_at = now() where id = $id and claim_token = $token;
-- 0 rows updated: ownership was lost. Stop.
```

Keep each stage's time budget well inside the lease. Set the lease to at least twice the route's `maxDuration`, and have workers stop and release their claim when they approach `maxDuration`.

### 4.1 Guarantees (what row claiming does and does not promise)

Row claiming and status checks do **not** by themselves make every retry a no-op. The system relies on four separate controls, each with a limited job:

1. **Application leases** coordinate processing of individual rows. Normally only one worker holds a row at a time. An expired lease does not prove the earlier worker stopped, so a lease alone never authorizes a send.
2. **Ownership tokens** reject stale workers. A worker that lost its claim (its conditional completion or renewal updates 0 rows) must stop and publish nothing. This protects database state. It cannot cancel an external request already in flight. For side effects that cannot be undone, write to token-scoped locations or deduplicate: resume PDFs go to a path that includes the `claim_token` (section 8) and only the winning worker stores the URL, and Telegram messages are keyed by event so a repeat is skipped.
3. **Per-account send reservations** enforce the daily cap, recipient-domain limit, spacing, and one active send per Gmail account (section 7.8).
4. **Durable send attempts and reconciliation** handle uncertain Gmail outcomes (sections 7.9 and 7.9a). An expired lease on an application in `sending` is never treated as ordinary unsent work.

Send outcomes are recorded against the send attempt, not against the lease. A worker that lost its lease but already sent an email still records that the email went out.

### Routes and schedules

| Route | Schedule (UTC, example) | Job |
|---|---|---|
| `/api/cron/ingest` | every 2 hours, active hours only | X search for all users, small page, insert new posts |
| `/api/cron/process` | every 10 minutes | extract and shared gates (jobs), fan-out, then match, tailor, verify (small fair batch across users) |
| `/api/cron/send` | every 10 minutes | first reconcile uncertain sends for all users (section 7.9a), then for each live user inside their own send window, authorize and send ready applications within that user's cap, with spacing (sections 7.8 and 7.9) |
| `/api/cron/inbox` | every 2 hours | bounces, replies, reply drafts, a few users per run in rotation |
| `/api/cron/followups` | daily | draft follow-ups for silent applications, per user |
| `/api/cron/summary` | hourly | send each user's daily summary when their local time passes 20:00, run their ramp review, and send the admin summary once a day |
| `/api/telegram` (POST) | webhook | commands, file uploads, manual URL ingest |
| `/api/oauth/gmail/start` (GET) | user click | validate state, redirect to Google |
| `/api/oauth/gmail/callback` (GET) | Google redirect | store the encrypted refresh token |

Cron services use UTC. Each user has their own timezone for the send window, so the send route converts per user.

---

## 5. Project layout

```
app/api/cron/ingest/route.ts
app/api/cron/process/route.ts
app/api/cron/send/route.ts
app/api/cron/inbox/route.ts
app/api/cron/followups/route.ts
app/api/cron/summary/route.ts
app/api/telegram/route.ts
app/api/oauth/gmail/start/route.ts
app/api/oauth/gmail/callback/route.ts
lib/db.ts            Neon client, claim helpers, event logger, user-scoped query helper
lib/users.ts         users, invites, oauth state, consent, suspension
lib/crypto.ts        AES-256-GCM encrypt/decrypt for refresh tokens
lib/x.ts             search, single-post fetch, media fetch, spend tracking
lib/gemini.ts        structured calls with Zod schemas, vision input
lib/schemas.ts       Zod schemas for extract, match, tailor, verify, reply
lib/gates.ts         all gate functions, pure and unit-tested
lib/fanout.ts        create applications per eligible user within their limits
lib/facts.ts         loads and types a user's master facts
lib/parse-resume.ts  PDF/DOCX text extraction and facts conversion
lib/pdf/Resume.tsx   the one fixed resume layout (@react-pdf/renderer)
lib/gmail.ts         builds a Gmail client for a given user; send, drafts, search, thread read
lib/claims.ts        claim, renew and complete helpers that enforce the claim_token
lib/send.ts          send authorization, attempt records, Gmail send, reconciliation
lib/telegram.ts      send message to a user, command handlers, admin handlers
lib/auth.ts          cron secret, webhook secret, user and admin checks
data/facts.json      optional seed for the admin's own first facts version
```

Rules:

- Keep gates as pure functions with unit tests. They are the safety layer, so they should be the most tested code in the project.
- Every query on a user-owned table (`applications`, `facts_versions`, `events`, `user_settings`, `user_spend`) goes through a helper that requires a `user_id`. Add a test that proves user A can never read or change user B's rows.

---

## 6. Data model (Postgres)

```sql
create table users (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint unique not null,
  telegram_username text,
  display_name text,
  role text not null default 'user',             -- user | admin
  status text not null default 'pending',        -- pending | active | suspended | deleted
  consented_at timestamptz,
  consent_version text,
  gmail_address text,
  gmail_refresh_token_enc text,                  -- AES-256-GCM, never logged
  gmail_status text not null default 'disconnected', -- disconnected | connected | error
  gmail_connected_at timestamptz,
  last_inbox_scan_at timestamptz,
  last_summary_on date,
  created_at timestamptz default now()
);

create table invites (
  code text primary key,
  created_by uuid references users(id),
  max_uses int not null default 1,
  uses int not null default 0,
  expires_at timestamptz,
  created_at timestamptz default now()
);

create table oauth_states (
  state text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used boolean not null default false
);

create table user_settings (
  user_id uuid primary key references users(id) on delete cascade,
  paused boolean not null default false,
  dry_run boolean not null default true,
  dry_run_drafts_shown int not null default 0,
  ramp_stage int not null default 0,             -- 0 = dry run, 1..5 per section 12
  ramp_stage_started_at timestamptz,
  current_cap int not null default 3,
  max_cap int not null default 20,               -- admin can lower per user
  daily_read_cap int not null default 50,        -- shared posts reviewed for this user per day
  max_reads_ceiling int not null default 100,    -- admin ceiling for /reads
  manual_daily_cap int not null default 5,       -- manual URL pastes per day
  fit_threshold int not null default 40,
  timezone text not null default 'UTC',
  send_window_start int not null default 9,      -- local hour, 0-23
  send_window_end int not null default 17,
  min_send_gap_seconds int not null default 120,
  last_raise_at timestamptz,
  availability_note text,                        -- optional, used by the reply drafter
  resume_mode text not null default 'generated'  -- generated | uploaded (section 8)
);

create table global_settings (
  key text primary key,
  value text not null
);
-- keys: global_paused, x_daily_read_cap, x_daily_thread_cap, max_applications_per_job

create table facts_versions (
  id serial primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz default now(),
  source text,                                   -- seed | telegram_upload | manual
  facts jsonb not null,
  diff_summary text,
  source_file_url text,                          -- original PDF, private Blob path (null for Word uploads and seeds)
  source_file_sha256 text,
  source_file_pages int,
  status text not null default 'pending'         -- pending | active | rejected | superseded
);
create index on facts_versions (user_id, status);

-- Shared: one row per post, extracted once.
create table jobs (
  id uuid primary key default gen_random_uuid(),
  post_id text unique not null,
  post_url text not null,
  author_handle text,
  posted_at timestamptz,
  source text not null default 'search',         -- search | manual
  submitted_by uuid references users(id),        -- set for manual ingest
  raw_text text not null,
  raw_json jsonb,
  media_urls jsonb,                              -- image URLs from the post
  transcribed_text text,                         -- Gemini transcription of images
  conversation_id text,
  author_id text,
  thread_fetched boolean default false,
  thread_post_ids jsonb,
  thread_text text,                              -- author's own follow-up posts, joined

  -- extracted
  is_job boolean,
  is_software_role boolean,
  company text,
  role text,
  location text,
  remote boolean,
  relocation_required boolean,
  visa_sponsorship text,                         -- yes | no | unknown
  min_years int,
  salary text,                                   -- logged only, never filtered
  deadline date,
  requirements jsonb,
  apply_method text,                             -- email | form | dm | link | unknown
  contact_email text,                            -- from regex only
  address_source text,                           -- text | image
  address_mx_ok boolean,
  apply_link text,                               -- from X post entities, never from the model
  apply_link_domain text,
  scam_risk text,                                -- low | medium | high
  scam_reasons jsonb,
  dedupe_hash text,
  canonical_job_id uuid references jobs(id),     -- set when marked duplicate

  fanned_out_at timestamptz,
  status text not null default 'found',
  status_reason text,
  attempts int not null default 0,
  locked_at timestamptz,
  lock_owner text,
  claim_token uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index on jobs (status);
create index on jobs (contact_email);
create index on jobs (apply_link);
create index on jobs (dedupe_hash);

-- Per user: one row per (user, job).
create table applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  job_id uuid references jobs(id),               -- null for imported past applications
  imported boolean not null default false,
  contact_email text,                            -- copied from the job at fan-out
  route text,                                    -- email | link

  fit_score int,
  gaps jsonb,
  years_gap boolean,
  facts_version_id int references facts_versions(id),
  resume_blob_url text,
  resume_source text,                            -- generated | uploaded
  email_subject text,
  email_body text,
  cover_note text,                               -- link route
  verify_result jsonb,

  gmail_message_id text,
  gmail_thread_id text,
  applied_at timestamptz,
  follow_up_at timestamptz,
  followup_draft_id text,
  reply_type text,                               -- interview | assessment | question | rejection | auto | other
  reply_draft_id text,
  last_reply_at timestamptz,
  link_notified_at timestamptz,                  -- when a link/form post was sent to the user

  status text not null default 'queued',
  status_reason text,
  attempts int not null default 0,
  locked_at timestamptz,
  lock_owner text,
  claim_token uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, job_id)
);

create index on applications (user_id, status);
create index on applications (status);
create index on applications (user_id, contact_email);
create index on applications (gmail_thread_id);

-- One row per user: the serialization point for sending.
create table send_state (
  user_id uuid primary key references users(id) on delete cascade,
  active_attempt_id uuid,                        -- the one attempt in reserved or sending state, if any
  next_send_at timestamptz not null default now(),
  updated_at timestamptz default now()
);

-- Durable record of every send, written before Gmail is called.
create table send_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  application_id uuid not null references applications(id),
  state text not null default 'reserved',        -- reserved | sending | sent | failed | send_unknown | released
  recipient text not null,
  recipient_domain text not null,
  rfc_message_id text not null,                  -- stable RFC Message-ID sent in the MIME headers
  subject text not null,
  body_hash text not null,                       -- hash of the exact body sent
  resume_blob_url text not null,
  resume_sha256 text not null,
  reserved_at timestamptz not null default now(),
  started_at timestamptz,                        -- set just before the Gmail call
  finished_at timestamptz,
  gmail_message_id text,
  gmail_thread_id text,
  error text,
  reconcile_checks int not null default 0,
  last_reconcile_at timestamptz,
  resolved_by text                               -- auto | user | admin
);
-- at most one attempt per account may be reserved or sending
create unique index send_attempts_one_active_per_user
  on send_attempts (user_id) where state in ('reserved', 'sending');
-- at most one live (non-terminal) attempt per application
create unique index send_attempts_one_live_per_application
  on send_attempts (application_id) where state in ('reserved', 'sending', 'send_unknown');
create index on send_attempts (user_id, reserved_at);

create table spend (
  day date primary key,
  x_reads int default 0,
  x_cost_est numeric default 0,
  llm_calls int default 0
);

create table user_spend (
  user_id uuid references users(id) on delete cascade,
  day date,
  reviewed int default 0,                        -- applications created for this user today
  manual_reads int default 0,
  llm_calls int default 0,
  primary key (user_id, day)
);

create table events (
  id bigserial primary key,
  user_id uuid references users(id) on delete cascade,
  job_id uuid references jobs(id),
  application_id uuid references applications(id),
  at timestamptz default now(),
  type text,
  detail jsonb
);
```

### Status values

Jobs (shared): `found` > `extracted` (passed shared gates, ready to fan out). Off-path: `rejected`, `duplicate`, `needs_manual`, `expired`, `failed`.

Applications, email route: `queued` > `matched` > `drafted` > `verified` > `ready` > `sending` > `sent` > `replied`

Applications, link route: `queued` > `matched` > `drafted` > `verified` > `link_ready` > `applied_manually`

Application off-path: `rejected`, `duplicate`, `needs_manual`, `bounced`, `expired`, `failed`, `skipped`, `interview`, `closed_by_employer`, `send_unknown`.

Send attempts: `reserved` > `sending` > `sent`, or `failed` (confirmed failure), `send_unknown` (uncertain outcome), `released` (slot freed because the email was confirmed not sent).

Every off-path status must have a `status_reason`. A job-level `needs_manual` on a search-sourced post goes into the admin summary only, so users are not alerted about posts that were never queued for them. For a manual ingest, the submitting user is alerted.

### Past applications import

Before a user goes live, they can send `/import` followed by the contact emails of people they already emailed. Each becomes an `applications` row with `imported = true`, `status = 'sent'`, and no job, so the tool never re-applies to an address that user already emailed.

---

## 7. Pipeline stages

### 7.1 Ingest (shared)

Budget math first, because it is the binding constraint. With a budget under $20 per month for the whole group, you can afford roughly 130 post reads per day at $0.005 per post read (confirm current pricing in the X developer console). That pool is shared. Each extra user does not add X cost, because one search serves everyone, but the pool is not 130 per user.

- Search recent posts with narrow queries, for example:
  `("hiring" OR "we are hiring" OR "send your CV" OR "send your resume" OR "apply via email") (developer OR engineer OR "full stack" OR backend OR frontend OR "AI engineer" OR devops OR "software") -is:retweet -is:reply lang:en`
- Run several narrow queries rather than one broad one, and rotate them.
- Use small pages. Per-run page size times runs per day times the per-read price must stay under the daily budget (monthly budget divided by 30). For example, 12 runs a day at a page size of 10 is about 120 reads.
- Store the highest post ID as `since_id`.
- Request only the fields you need. Expansions (author, media) may count as billable resources, so check usage in the console after the first day and adjust.
- Request media: `expansions=attachments.media_keys` and `media.fields=url,type` so image URLs come back in the same call.
- Insert with `on conflict (post_id) do nothing`.
- Write each call's reads and estimated cost to `spend`. When the daily estimate reaches the budget, stop ingesting and alert the admin.
- The global daily read limit comes from `global_settings.x_daily_read_cap`, which defaults to the monthly budget divided by 30. The admin can override it for the current day with `/admin xreads N`. The override resets the next day and can never exceed `X_MAX_DAILY_READS`, so a typo cannot blow the budget. It is a limit, not a quota: ingest stops at N reads or sooner if the queries run dry.
- **Per-user `/reads N` is different.** It limits how many shared posts are reviewed (fanned out, matched, tailored) for that user today. It controls that user's Gemini usage and noise, not X cost. It resets daily and is capped by the user's `max_reads_ceiling`.
- Manual path: when a user sends a tweet URL to the bot, fetch that single post and insert it with `source = 'manual'` and `submitted_by` set. It costs one X read from the shared pool and counts against that user's `manual_daily_cap`. Manual posts are processed first, and by default create an application only for the submitting user.
- Cheap pre-filter before any LLM call: drop posts with no apply signal in text, and keep posts with images even if the text is thin.

### 7.1a Thread expansion (the author's own posts only, shared)

The search queries use `-is:reply`, so a thread's follow-up posts (which are replies to the author's own first post) never appear in search results. Without expansion, a post that says "details in thread" would reach extraction with no apply method.

- Request `conversation_id`, `author_id`, `in_reply_to_user_id`, and `referenced_tweets` in `tweet.fields` so each stored post knows which conversation it belongs to.
- Expand only when it is likely to pay off: the first extraction pass says `is_job` is true but the apply method or contact is missing, or the post signals a thread (a thread emoji, "1/", "see below", "details in comments", "apply below").
- Fetch with a search for `conversation_id:{id} from:{author_handle} -is:retweet`. This returns the author's posts in that conversation. Cap it at 10 posts per thread.
- Use only posts whose `author_id` matches the root post's author. Replies from other accounts are never used for apply details. Scammers often reply under real job posts with fake application addresses, so ignoring them is a safety feature.
- Sort the thread by post ID, join the text into `thread_text`, collect any images, and run extraction again on the combined content. The second pass replaces the first.
- Budget: each fetched post is a billable read. Cap thread expansions per day (for example 15, set with `/admin threads N`) and count them in `spend`. When the cap is reached, process the root post only and set `needs_manual` with reason `thread_not_read` if details are missing.
- Manual path: when a user pastes a tweet URL, expand its thread automatically (author-only), since they have already judged it worth the reads.
- Known limit: a thread whose first post has none of your search keywords (for example just "Big news 🧵") will not be found by search. Add a query variant for thread openers if the dry run shows you are missing these.

### 7.2 Extract (text and images, once per post)

One Gemini call per post. Pass the post text and up to 4 images. The call returns:

```json
{
  "transcribed_text": "full text visible in any images, verbatim",
  "is_job": true,
  "is_software_role": true,
  "role": "string",
  "company": "string | null",
  "location": "string | null",
  "remote": "boolean | null",
  "relocation_required": "boolean | null",
  "visa_sponsorship": "yes | no | unknown",
  "min_years": "number | null",
  "salary": "string | null",
  "deadline": "YYYY-MM-DD | null",
  "requirements": ["string"],
  "apply_method": "email | form | dm | link | unknown",
  "scam_risk": "low | medium | high",
  "scam_reasons": ["string"]
}
```

Rules:

- Post text and image content are untrusted data. The prompt says so, and the model has no tools.
- The model does not return the recipient address as a field. The address is extracted by regex in code from `raw_text`, `thread_text`, and `transcribed_text`.
- Validate with Zod. On failure, retry once with the validation error appended, then set `needs_manual`.
- If a post is not a software role, set `rejected` with reason `not_software`.

### 7.3 Gates, round 1 (shared, code not model)

A job moves to `extracted` only if all of these pass:

1. `is_job` and `is_software_role` are true.
2. `apply_method` is `email`, `form`, or `link`. Email posts continue on the email route. Form and link posts take the link route (section 7.13) and skip gates 3 and 4, which apply to the email route only. Any other method (DM, unknown) becomes `needs_manual`.
3. Regex finds exactly one distinct email address across `raw_text`, `thread_text`, and `transcribed_text`. Zero or several means `needs_manual`.
4. The address domain has MX records (DNS lookup in the Node runtime). This catches transcription mistakes on image-sourced addresses, such as `l` read as `1` or `0` read as `O`.
5. `scam_risk` is `low`. Flag anything asking for fees, ID or bank details, or moving the conversation to WhatsApp or Telegram.
6. No other job has the same `dedupe_hash` or the same `apply_link`. If one does, mark this job `duplicate` and set `canonical_job_id`. Because extraction is shared, the canonical job already reached every eligible user once.
7. Not expired (`deadline` in the past).

Things that are deliberately not gates: location, relocation, visa sponsorship, pay, and years of experience requested. These are extracted and handled per user in the email (section 9).

Address source is stored in `address_source`. Image-sourced addresses are the riskiest, so each user's first week of live sends should include a Telegram note on each one.

### 7.4 Fan-out (jobs to applications)

For each newly `extracted` job, create one `applications` row (status `queued`) for each eligible user, then set `fanned_out_at`. A user is eligible if all of these are true:

- `users.status = 'active'` and `user_settings.paused = false`.
- The user has an active facts version.
- `user_spend.reviewed` for today is under their `daily_read_cap`.
- For a manual job, only the submitting user, unless the admin changes that.
- For the email route, the number of existing applications for this job is under `max_applications_per_job` (default 10). Pick among eligible users in random order so the same people are not always first.
- Per-user dedupe (gate): the user has no application with the same `contact_email` in the last 30 days (imported rows count). If they do, create no row.

Each created row copies `contact_email` and `route` from the job, increments `reviewed`, and records the current `facts_version_id`.

Cost note: every application costs up to three Gemini calls (match, tailor, verify), so total LLM use scales with users times reviewed posts. Matching runs first and low-fit applications stop there, so most rows cost one call. Track `user_spend.llm_calls` and let the admin set a per-user ceiling if needed.

### 7.5 Match (per user)

Gemini scores fit from 0 to 100 against the user's master facts and returns specific gaps. Below the user's `fit_threshold` the application is logged as `rejected` with reason `low_fit`.

Start each user with a low threshold (about 40) and raise it only if their dry run shows too many poor matches. Set `years_gap = true` when `min_years` is greater than the user's years of professional experience in their facts.

### 7.6 Tailor (per user)

Inputs: extracted fields, the user's master facts, the email template.

Outputs:

- **Resume JSON:** summary line, ordered project IDs, selected bullet IDs, skill order. The model selects and orders from the user's bullet bank. In v1 it does not rewrite bullets.
- **Email slots:** opening line, one or two sentences on why the top projects fit, and the gap sentence.

The output schema has no fields for name, contact details, links, education, employers, titles, dates or certs. The PDF is rendered by fixed code from the resume JSON plus the locked fields in the facts (section 8).

**Uploaded mode:** when the user's `resume_mode` is `uploaded`, skip the resume JSON and the PDF rendering. Produce the email slots only. Copy the stored file's URL and SHA-256 from the active facts version onto the application, set `resume_source = 'uploaded'`, and record `facts_version_id` as usual. In generated mode set `resume_source = 'generated'`.

### 7.7 Verify (truthfulness check, per user)

A second Gemini call receives the user's master facts, resume JSON, and email slots, and returns:

```json
{ "supported": true, "unsupported_claims": [] }
```

Any unsupported claim means `needs_manual` with the claims stored in `verify_result`. No retry-and-send.

The verifier also checks for claims it must never allow: work authorization or visa status for any country, years of experience above the number in the user's facts, any skill not listed in the user's facts as `strong` or `working`, and any name or contact detail that differs from the facts. In uploaded mode there is no resume JSON, so the verifier checks the email slots only.

### 7.8 Send authorization (per account, before any Gmail call)

Application leases do not coordinate two workers handling different applications for the same Gmail account. Without more, two workers could each read "2 of 3 sent" and both send. So authorization is serialized per user, in a short transaction that is **committed before Gmail is contacted**. Never hold a database transaction open across the Gmail call.

In one transaction:

1. Lock the user's sending state: `select * from send_state where user_id = $1 for update` (insert the row first if missing). This is the serialization point.
2. Recheck current eligibility: `global_settings.global_paused` is false, `users.status` is `active`, `gmail_status` is `connected`, `user_settings.paused` is false, `dry_run` is false, and the application is still `ready`, still holds the caller's `claim_token`, has `attempts` under 3 (counting confirmed failures only), and has no live send attempt.
3. Account state: the user has no attempt in `reserved`, `sending` or `send_unknown`. One active send per account, and an uncertain send blocks further sending for that user until it is reconciled or resolved.
4. Spacing and window: `now() >= send_state.next_send_at` and the current time is inside the user's send window in their timezone.
5. Caps, counted for today in the **user's timezone** and including pending and uncertain attempts (states `reserved`, `sending`, `sent`, `send_unknown`; not `failed` or `released`): the total is under `current_cap`, and attempts to the same recipient domain are under 2.
6. Insert the `send_attempts` row in state `reserved` with the recipient, domain, subject, body hash, resume URL and resume hash. This is the immutable payload. Set the application to `sending` so nothing else (a `/skip`, or a facts change that re-queues work) touches it. Set `send_state.active_attempt_id`.
7. Commit.

If any check fails, no reservation is made, the application stays `ready`, and a later run tries again.

**Dry run:** when `dry_run` is true, skip reservation. Store the would-be email and PDF, send a Telegram message marked DRY RUN, and increment `dry_run_drafts_shown`.

**When a reserved slot can be released.** Only in these cases:

- The attempt is still `reserved` with no `started_at`. Gmail was never called, so it is safe to mark it `released` and return the application to `ready`.
- The attempt is `failed` with a confirmed failure (section 7.9).
- The attempt was reconciled as not sent, or a person resolved it as not sent (section 7.9a).

An attempt in `sending` or `send_unknown` is **never** released by a timer or by lease expiry. Its slot keeps counting against the cap and the domain limit.

### 7.9 Send

1. **Authorize** (section 7.8). Without a committed `reserved` attempt there is no send.
2. **Build the MIME message** from the stored payload, with the `Message-ID` header set to the attempt's `rfc_message_id`. Plain text body, no tracking pixels, consistent signature. Check the body hash and resume hash match the attempt record.
3. **Mark the attempt started:** `update send_attempts set state = 'sending', started_at = now() where id = $1 and state = 'reserved'`. If it updates 0 rows, stop. Commit before contacting Gmail.
4. **Call Gmail** `users.messages.send` with the PDF attached.
5. **Record the outcome**, keyed on the attempt, not on the claim token or lease:
   - **Success:** in one transaction set the attempt to `sent` with `gmail_message_id` and `gmail_thread_id`, set the application to `sent` with the same IDs, `applied_at = now()` and `follow_up_at` 7 days later, clear `send_state.active_attempt_id`, and set `next_send_at` to now plus a random 2 to 8 minutes. A worker that lost its lease still records a send that really happened.
   - **Confirmed failure:** Gmail definitively rejected the request (a 4xx response with an error body, a malformed message, an auth error, or a quota or rate-limit rejection). Set the attempt to `failed` with the error, add 1 to the application's `attempts`, and return the application to `ready` (or `failed` at 3 attempts). An auth error also sets `gmail_status = 'error'` and pauses the user. A retry creates a **new** attempt with a new Message-ID.
   - **Anything else is uncertain:** a timeout, a dropped connection, a 5xx or unparseable response, or a worker that crashed after step 3. Set the attempt to `send_unknown` (or leave it in `sending` if the worker died) and the application to `send_unknown`. Do not retry. Go to section 7.9a.
6. Telegram message after a confirmed send: role, company, recipient, fit score, gaps, address source, and the full email text.

A database transaction cannot include Gmail's external action, so saving the IDs and `sent` status in one transaction is not what prevents duplicate sends. The attempt record, the reservation and reconciliation are.

### 7.9a Reconciling uncertain sends

At the start of every `/api/cron/send` run, for all users and regardless of their send window, process attempts in `sending` for more than 2 minutes, and all attempts in `send_unknown`:

1. Search that user's Gmail **Sent** mail for the attempt's exact Message-ID (for example `in:sent rfc822msgid:<id>`). This is the only mailbox access this stage uses (see section 10).
2. **Found:** mark the attempt and the application `sent` with the Gmail IDs, using the message's send time as `applied_at`. Clear the block. Telegram: "confirmed sent".
3. **Not found:** leave it as `send_unknown` and check again on each run for 30 minutes (`reconcile_checks`), because Gmail's index can lag a few minutes.
4. **Still not found after 30 minutes:** the outcome is inconclusive and stays `send_unknown`. The user gets a Telegram message with the recipient, role, and time, and resolves it with `/resolve <id> sent` or `/resolve <id> notsent`. `notsent` marks the attempt `released` and returns the application to `ready`. `sent` marks it sent. The admin can resolve it too.

Rules:

- Expiring a lease never moves a `sending` application back to `ready`. Only reconciliation or a person can.
- Nothing resends automatically after an uncertain outcome.
- While an attempt is `send_unknown`, that user's sending is blocked (section 7.8 step 3) and the attempt still counts against their cap and domain limit. Other users are unaffected.
- A stable Message-ID makes the lookup possible. It does not make Gmail deduplicate repeated sends.

### 7.10 Inbox: bounces and replies (per user)

Every 2 hours, for a few live users per run in rotation (oldest `last_inbox_scan_at` first):

1. Search the user's Gmail for bounces (`from:mailer-daemon OR from:postmaster newer_than:2d`) and match to applications by thread or recipient. Mark `bounced` with the reason. If the original post had a second address, queue one retry to it, otherwise `needs_manual`.
2. For each stored `gmail_thread_id`, check for new inbound messages from the recipient domain.
3. Classify each reply with Gemini: `interview`, `assessment`, `question`, `rejection`, `auto`, or `other`.
4. Act by type:
   - `interview` or `assessment`: Telegram alert to that user immediately with the message text and thread link, and a drafted reply.
   - `question`: drafted reply.
   - `rejection`: set `closed_by_employer`, no draft, one-line Telegram note.
   - `auto`: ignore, do not change status.

The tool only runs these kinds of Gmail queries: bounce messages, threads it created, and an exact Message-ID lookup in Sent mail to reconcile an uncertain send (section 7.9a). It never lists, reads or searches the rest of the user's inbox.

### 7.11 Reply drafting (the user sends)

- Inputs: the full thread, the user's original application, the user's master facts.
- Output: a reply saved as a Gmail draft in the same thread (`users.drafts.create` with the `threadId`). It is never sent by the tool.
- The reply drafter follows the same style rules and goes through the same verifier. A draft that fails verification is not saved, and Telegram says why.
- For scheduling requests, the draft proposes no specific times unless the user has set `availability_note`. Leave a clear placeholder instead of inventing times.
- Telegram message: the reply type, a short summary of what they asked, the draft text, and a link to the draft in Gmail.

### 7.12 Follow-ups (draft only)

Seven days after `applied_at` with no reply and no bounce, generate a short follow-up, run the verifier, and save it as a Gmail draft in the thread. Send one Telegram message to that user with the draft and link. The tool never sends it. At most one follow-up draft per application.

### 7.13 Link and form applications (sent to the user)

When the job's `apply_method` is `form` or `link`, the tool does not apply. It logs the post and sends it to each eligible user on Telegram so they can apply themselves.

- The application runs through the same match, tailor and verify stages as an email application, so the resume PDF and a suggested cover note are ready when the user opens the link. In uploaded mode the PDF is the user's own file, unchanged, and only the cover note is generated.
- Dedupe on `apply_link` as well as `dedupe_hash` at the job level (gate 6), so the same form reposted by several accounts reaches each user once.
- Scam checks still apply, with link-specific signals: URL shorteners, lookalike domains, and links that download a file. The tool never opens or fetches the apply link. The Telegram message shows the raw domain so the user can judge it before they click.
- If the post says to apply by link but no link can be extracted, set `needs_manual` with reason `link_missing`.
- On success, set status `link_ready` and `link_notified_at`.
- The Telegram message contains: role, company, location or remote, deadline (marked urgent if within 48 hours), salary if listed, fit score, gaps, the apply link, the post link, a short suggested cover note the user can paste into the form, and the resume PDF as an attachment (tailored in generated mode, the user's own file in uploaded mode).
- The cover note goes through the same verifier as email text.
- Link applications do not count against the daily send cap or the ramp, and they are not spaced, because nothing is sent from the user's Gmail. They do count toward the user's daily review limit.
- `/done <id>` marks the application `applied_manually` and sets `applied_at`.
- If a `link_ready` application has a deadline within 48 hours and is not marked done, send one reminder.

---

## 8. Resume PDF

By default every user's resume is generated from **one fixed template** (`resume_mode = generated`). A user can instead attach their own PDF unchanged (`resume_mode = uploaded`, see Resume mode below).

- Use `@react-pdf/renderer` or `pdf-lib`. Avoid headless Chrome on serverless because of bundle size and cold starts.
- One page, text-based, embedded standard fonts, single column, so applicant tracking systems parse it.
- Upload to Vercel Blob as `resumes/{user_id}/{application_id}/{claim_token}.pdf`. The token in the path means a stale worker cannot overwrite the winning worker's file. Only the worker that still holds the claim stores the URL and the file's SHA-256 on the application. At reservation time the URL and hash are copied into the send attempt and are never changed after that.
- Attachment file name: `{FirstName}_{LastName}_Resume.pdf`, taken from the user's `identity.name`.
- In generated mode the uploaded resume is only a source of content. Its original design is not copied, so the PDF employers receive will look different from the one the user uploaded. Tell users this during onboarding, along with the `/resumemode` option.

### Locked fields

The following are rendered by code straight from the user's active facts and are never sent to the LLM for editing: name, email, phone, location, GitHub, LinkedIn, portfolio, education, employer names, job titles, dates and certifications. The LLM output schema has no fields for them, and the verifier flags any generated text that contradicts them.

### What the LLM may vary (v1)

Summary line, which projects appear and in what order, which of the user's own bullets are selected, and skill order. Free rewriting of bullets is out of scope (section 17). If it is added later, it must happen inside the same template, never touch the locked fields, and have each rewrite checked by the verifier against the facts.

### Resume mode (per user)

| | `generated` (default) | `uploaded` |
|---|---|---|
| What employers receive | A fresh one-page PDF from the fixed template, with projects and bullets chosen for the job | The user's own PDF, byte for byte, the same for every application |
| Tailoring | Resume and email, per job | Email only |
| Design | The fixed template | The user's own |
| Locked fields | Rendered by code from the facts | Not applicable, because the tool never edits the file |
| Trade-off | Consistent and parseable, but not the user's design | Keeps the user's design, but the resume cannot be matched to each job and the tool cannot check how applicant tracking systems read the layout |

Rules:

- Set with `/resumemode generated|uploaded`. `/resumemode` alone shows the current mode, file name, upload date, and page count.
- Uploaded mode needs an accepted facts version that has a stored PDF. Word uploads are parsed and discarded, so they cannot be used. If there is no stored PDF, refuse the switch and ask the user to send one.
- **Validation at upload, before parsing:** `%PDF-` header, not encrypted, within the size limit, at most 3 pages, has a text layer, and no embedded files, JavaScript, or launch actions. The file goes to third parties, so a PDF that fails is rejected with a short reason and nothing is stored.
- **Storage:** private Blob path `resumes/{user_id}/uploads/{facts_version_id}.pdf`. The SHA-256 and page count are saved on the facts version when it is created. The file is never modified.
- **Attachment:** the file name is `{FirstName}_{LastName}_Resume.pdf` from the user's `identity.name`, with the bytes unchanged. At reservation the URL and hash are copied into the send attempt. Before attaching, re-hash the downloaded file and refuse to send on a mismatch.
- **Facts and file stay matched** because the facts were parsed from this file. `/set` commands change what emails say, not what the PDF says, so tell the user to upload a new PDF if their experience changes.
- **New facts version:** when a new version is accepted and has a stored PDF, new applications use it and unsent applications are re-queued (section 9). If the new version came from a Word file, switch the user back to `generated` and tell them why.
- **Mode change:** switching modes re-queues the user's unsent applications (drafted, verified, ready) so they regenerate. Applications in `sending` or `send_unknown`, and applications already sent, are untouched.
- **Retention:** keep the PDF for the pending and active versions, and for the previous version for 30 days so `/rollback` works. Delete rejected files immediately, older files after 30 days, and everything on `/delete_me`.
- Dry run shows which PDF would be attached.

---

## 9. Master facts and email template

### Building a user's master facts from their resume

Each user's resume arrives as a PDF or Word file, so the first step is extracting it into a facts JSON:

1. Extract the text from the file (PDF text extraction, or a Word-to-text library for .docx). The text is treated as data, not instructions. Reject files over about 5 MB or files of other types.
2. Gemini converts it into the JSON below, splitting each role and project into short bullets with IDs.
3. The user reviews the summary the bot sends. This file is the single source of truth, so every line must be something the user would defend in an interview.
4. The user sets the fields a resume cannot tell the tool (`years_experience`, `open_to_relocation`, `known_gaps`, `gap_framing`) with `/set` commands.

```json
{
  "identity": {
    "name": "", "email": "", "phone": "", "location": "",
    "links": { "github": "", "linkedin": "", "portfolio": "" }
  },
  "years_experience": 0,
  "open_to_relocation": false,
  "education": [ { "id": "", "school": "", "degree": "", "dates": "" } ],
  "certs": [ { "id": "", "name": "", "issuer": "" } ],
  "experience": [ { "id": "", "org": "", "title": "", "dates": "", "bullets": [ { "id": "", "text": "" } ] } ],
  "projects": [ { "id": "", "name": "", "one_liner": "", "stack": [], "email_note": "", "bullets": [ { "id": "", "text": "" } ] } ],
  "skills": { "strong": [], "working": [], "known_gaps": [] },
  "fixed_priority": [],
  "gap_framing": ""
}
```

Notes:

- `fixed_priority` is an optional ordered list of project IDs to mention first unless a post clearly favors another.
- `email_note` is an optional sentence a project always carries when mentioned. Example: a project that uses a specific tool can say so here. The verifier still checks it.
- `gap_framing` is the user's own standing sentence for naming a gap, for example how they learn new tools. If empty, the tool uses a plain default: "I pick up new tools quickly and learn by building."
- `years_experience` has no default and `/accept` is refused on a first version until the user sets it. `open_to_relocation` defaults to false.

### Updating the resume and facts from Telegram

A user sends an updated resume (PDF or Word) to the bot as a document, from their own chat only.

1. The webhook receives the file, downloads it through the Telegram file API, and extracts the text.
2. Gemini converts it into the facts schema above, with bullet IDs.
3. Code diffs the result against the user's active facts and sends them a summary: added, removed, and changed projects, bullets, certs, and dates. The proposed version is stored in `facts_versions` with status `pending`.
4. Fields a resume cannot tell the tool (`years_experience`, `known_gaps`, `open_to_relocation`, `fixed_priority`, `gap_framing`) carry over from the active version. Change them with `/set`.
5. Nothing changes until the user sends `/accept`. This is the one deliberate approval in the system, because the verifier trusts the facts file. A bad parse that went live would make the verifier approve wrong claims.
6. On `/accept`, the new version becomes active and the old one is marked `superseded`. That user's applications that are drafted, verified, or ready but not yet sent go back to `queued` so they regenerate with the new facts. Applications in `sending` or `send_unknown` are not touched, because their payload is already fixed in a send attempt. Applications already sent are untouched.
7. `/rollback` reactivates the previous version. `/reject` discards the pending one.

PDF uploads are also stored for uploaded mode, with their hash saved on the pending version (section 8, Resume mode). Word files are parsed and discarded.

The facts live in Postgres, not the repo, because a serverless function cannot write to its own deployment. `data/facts.json` only seeds the admin's first version.

### Email template

Hard-coded parts (never generated, filled from the user's facts):

- Subject: `{Role} Application`
- Links block: the user's GitHub, LinkedIn, portfolio
- Certs line: every certification in the user's facts
- Sign-off and name

Generated slots (each checked by the verifier):

1. **Opening line:** the role and one specific reason it fits.
2. **Project sentences:** one or two sentences on the top projects for this post, following `fixed_priority` unless the post clearly favors another. Add a project's `email_note` when that project is mentioned.
3. **Gap sentence**, only when `gaps` is non-empty. Use the user's `gap_framing` and name the actual gap.
4. **Years gap sentence**, only when `years_gap` is true. State the user's real years of professional experience from their facts, and say what they would bring. Never round up or imply more.
5. **Relocation sentence**, only when the role is on-site outside the user's location, not remote, and `open_to_relocation` is true. Use the fixed wording "I am open to relocation." Never claim work authorization for any country. If the post requires existing authorization and gives no sponsorship, the email states only that the user is open to relocation, and the verifier blocks anything stronger. If `open_to_relocation` is false, the tool leaves the sentence out.

Style rules for every generation prompt: short plain sentences, no em dashes, no stock phrases such as "I am excited to apply" or "passionate about", no bullet lists in the body.

---

## 10. Gmail (per-user accounts)

- One Google Cloud project with the Gmail API enabled and one **web OAuth client** for the whole app. Redirect URI: `${APP_BASE_URL}/api/oauth/gmail/callback`.
- Scopes: `gmail.send`, `gmail.readonly`, and `gmail.compose` (drafts).
- Publishing status: set the consent screen to **In production**. Publishing is free. Apps left in Testing mode have refresh tokens that expire after about 7 days, which would force every user to reconnect weekly.
- While the app is unverified, Google limits it to 100 users and shows each user an "unverified app" warning once (Advanced, then continue to the app). That is acceptable for a small invited group. Going beyond that, or removing the warning, needs Google's app verification. Because `gmail.readonly` and `gmail.compose` are restricted scopes, verification includes a security assessment. Confirm the current requirements before planning a wider launch.
- Users on a Google Workspace account may be blocked from authorizing by their admin. Tell them to use a personal Gmail if so.
- Refresh tokens are stored encrypted (AES-256-GCM, key in `TOKEN_ENCRYPTION_KEY`), decrypted only when needed, and never written to logs or events.
- If Google returns `invalid_grant` or any auth error for a user, set that user's `gmail_status = 'error'`, pause their sends, and tell them to run `/connect` again. Other users are unaffected.
- Because this is each person's real inbox and recruiters reply there, protect it:
  - Each user ramps separately (section 12).
  - Spread sends with random gaps and keep a daily send window.
  - Auto-pause a user on high bounce rates or any send error that looks like an account warning.
  - Keep every email individually tailored and plain text. Do not send identical bulk messages.
  - Tell users to check their Gmail security and spam folder regularly during the first weeks.
- Scope of reading: the tool only searches for bounce messages, reads threads it created, and looks up its own sent messages by exact Message-ID (sections 7.9a and 7.10).

---

## 11. Telegram

Webhook at `/api/telegram`. Verify the `X-Telegram-Bot-Api-Secret-Token` header on every request. Look up the sender's chat ID in `users`. An unknown chat ID can only use `/start <code>`. Everything else from it is ignored. Rate-limit each chat (for example 30 messages per minute), and accept only PDF and .docx documents under the size limit.

### User commands

| Command | Action |
|---|---|
| `/start <code>` | create the account with a valid invite code, then show the privacy notice |
| `/agree` | accept the privacy notice and activate the account |
| `/connect` | get the Google sign-in link to connect Gmail |
| `/disconnect` | revoke and delete the Gmail connection |
| `/pause` | `paused = true`, stops this user's sending and new applications |
| `/resume` | `paused = false` |
| `/status` | counts by status, today's sends vs cap, posts reviewed vs `/reads` limit, ramp stage, dry run on or off, Gmail status |
| `/cap N` | set the current cap (cannot exceed the user's `max_cap`) |
| `/reads N` | set today's review limit for shared posts (resets tomorrow, capped by `max_reads_ceiling`) |
| `/dry on` or `/dry off` | toggle dry run (see section 12 for the conditions to turn it off) |
| `/window H1 H2` | set the daily send window in local hours |
| `/timezone <zone>` | set timezone, for example `Africa/Lagos` |
| `/last` | last 5 sends with recipients |
| `/drafts` | pending reply and follow-up drafts with Gmail links |
| `/skip <id>` | mark a ready application as rejected |
| `/resolve <id> sent\|notsent` | settle a send the tool could not confirm. `notsent` frees the slot and returns the application to `ready`. `sent` records it as sent. Nothing resends on its own |
| `/done <id>` | mark a link application as applied (`applied_manually`) |
| `/links` | list link applications still waiting, soonest deadline first |
| `/run` | process this user's queue now, within today's remaining review limit |
| `/import <emails>` | add past application emails so they are never re-applied to |
| send a PDF or Word file | propose new master facts from the updated resume |
| `/accept` | activate the pending facts version |
| `/reject` | discard the pending facts version |
| `/rollback` | reactivate the previous facts version |
| `/set years N` | update years of experience |
| `/set relocation yes\|no` | update open to relocation |
| `/set gaps a, b, c` | update known gaps |
| `/set framing <text>` | update the gap framing sentence |
| `/resumemode generated\|uploaded` | choose whether applications attach a generated PDF (default) or your own uploaded PDF, unchanged. With no argument it shows the current mode and file. Named this way because `/resume` already un-pauses |
| `/delete_me` | delete the account and all data (asks for confirmation) |
| paste a tweet URL | manual ingest for this user |

### Admin commands (admin chat only)

| Command | Action |
|---|---|
| `/invite` | create a one-time invite code |
| `/users` | list users with status, Gmail status, ramp stage, today's sends |
| `/suspend <user>` / `/unsuspend <user>` | block or restore a user |
| `/limits <user> cap N reads N` | set a user's `max_cap` and `max_reads_ceiling` |
| `/admin xreads N` | set today's global X read limit (capped by `X_MAX_DAILY_READS`) |
| `/admin threads N` | set today's global thread-expansion limit |
| `/admin ingest` | run ingest now, within today's remaining reads |
| `/admin pauseall` / `/admin resumeall` | global pause switch for all sending |

### Automatic messages (sent to the affected user)

Every send, every link application (section 7.13), every `needs_manual` on their own applications with the reason and post link, every reply (with a draft), every bounce, every uncertain send that needs resolving, every auto-pause with its reason, a Gmail reconnect request when auth fails, and a daily summary (reviewed, rejected by reason, sent, bounced, replied).

The admin also gets: a daily summary of X spend vs budget, Gemini usage, users active, job-level `needs_manual` counts, and any auto-pause across all users.

---

## 12. Ramp schedule and auto-pause (per user)

| Stage | Cap per day | Move up when |
|---|---|---|
| Dry run | 0 (nothing sends) | see conditions below |
| 1 | 3 | 3 days, no bounces or errors |
| 2 | 5 | 3 days, bounce rate under 3% |
| 3 | 10 | 4 days, bounce rate under 3%, no warnings |
| 4 | 15 | 4 days, same conditions |
| 5 | 20 (max) | steady state |

The stage never exceeds the user's `max_cap`.

**Leaving dry run.** `/dry off` is refused until all of these are true: Gmail is connected, a facts version is active, the user has set `years_experience`, and at least 5 dry-run drafts have been shown to them. After that the user confirms with `/dry off confirm` and starts at stage 1. The admin should also ask each new tester to read their dry-run drafts for at least a few days.

The daily summary job checks each user's conditions and raises their cap by one stage, or leaves it where it is. A cap raise sends that user a Telegram message so they can veto it with `/cap`.

Auto-pause triggers (set `paused = true` for that user and alert them and the admin):

- Bounce rate above 5% over that user's last 20 sends
- Three consecutive confirmed send failures for that user
- Any send attempt left in `send_unknown`: sending for that user is blocked until it is reconciled or resolved (section 7.9a)
- Any Gmail API error that indicates an account or policy problem for that user

Global triggers (admin alerted):

- X or Gemini spend above the daily limit pauses ingest or processing only, not the inbox jobs
- Admin `/admin pauseall` stops all sending for everyone

---

## 13. Failure handling

| Failure | Handling |
|---|---|
| Email bounces | detect via mailer-daemon, mark `bounced`, try a second address from the post once, else `needs_manual` |
| Apply method is form or link | log it, send it to each eligible user on Telegram with their tailored resume and cover note (section 7.13), never open or fill the link |
| Link missing from a post that says to apply by link | `needs_manual` with reason `link_missing` |
| Apply method is DM or unknown | log with description and post link, `needs_manual`, no automation |
| Post deleted or job closed | description and link were stored at ingest |
| Address from an image fails MX check | `needs_manual` with the transcribed text stored |
| LLM returns invalid JSON | one retry with the error, then `needs_manual` |
| Verifier flags a claim | `needs_manual`, claims stored, never auto-fixed and sent |
| Image unreadable or too low quality | `needs_manual` with reason `image_unreadable` |
| Thread fetch fails or the daily thread budget is used up | process the root post only, `needs_manual` with reason `thread_not_read` if details are missing |
| Uploaded resume parses badly | nothing changes until the user sends `/accept`, so they send `/reject` and upload a corrected file |
| Uploaded file is the wrong type or too large | reject it with a short message, no parsing |
| PDF fails validation (encrypted, embedded files or scripts, too many pages, no text layer) | reject it with the reason, nothing stored |
| User is in uploaded mode but the active version has no stored PDF | switch to `generated`, tell the user, re-queue unsent applications |
| Stored PDF is missing or its hash does not match at send time | do not send, set `needs_manual` with reason `resume_file_invalid`, alert the user |
| X rate limit | back off, stop the run, resume next schedule |
| X budget reached | stop ingest, alert the admin, other stages continue |
| User's Gmail token revoked or expired | set `gmail_status = 'error'`, pause that user's sends, ask them to `/connect` again |
| Google returns no refresh token on connect | tell the user to revoke the app in their Google account and `/connect` again |
| Invite code invalid, used, or expired | refuse `/start`, no account created |
| Unknown chat ID messages the bot | ignore, except `/start <code>` |
| User hits their `/reads` limit | stop fan-out for that user until tomorrow, other users continue |
| User over their per-user LLM ceiling | pause new applications for that user until tomorrow and alert them |
| PDF generation fails | mark `failed`, never send without a resume |
| Run crashes mid-batch before sending | leases expire, rows keep their last status, next run reclaims them with a new `claim_token` |
| Worker crashes after Gmail accepted the message | the attempt is in `sending`. Reconciliation finds it in Sent mail by Message-ID and marks it sent. No resend |
| Gmail response lost or timed out | attempt becomes `send_unknown`, the user's sending is blocked, reconciliation runs, and if inconclusive the user resolves it with `/resolve`. No automatic resend |
| Lease expires while a worker is still running | the new owner gets a new `claim_token`. The old worker's completion and renewal updates change 0 rows, so it stops and publishes nothing. If it already sent, the outcome is recorded against the attempt |
| Two workers race for the last send slot | the lock on `send_state` serializes them. At most one gets a reservation. The other leaves its application `ready` |
| Scheduler calls a route twice | claims, ownership tokens, per-account reservations and send attempts (section 4.1) stop duplicate processing and duplicate sends. The second call picks up nothing it cannot safely take |
| One user's failure | contained to that user's applications and settings, never pauses anyone else |
| Reply draft fails verification | no draft saved, Telegram alert with the reason |
| Post or image tries to instruct the model | model has no tools, recipient comes from regex plus MX check, output still passes the verifier |

---

## 14. Environment variables

```
DATABASE_URL=
APP_BASE_URL=
CRON_SECRET=
X_BEARER_TOKEN=
X_MONTHLY_BUDGET_USD=20
X_MAX_DAILY_READS=300
GEMINI_API_KEY=
GEMINI_MODEL=
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
TOKEN_ENCRYPTION_KEY=              # 32 random bytes, base64
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
ADMIN_CHAT_ID=
MAX_USERS=20
BLOB_READ_WRITE_TOKEN=
```

Removed from v2: `GMAIL_REFRESH_TOKEN`, `GMAIL_SENDER` (now per user, in the database) and `TELEGRAM_CHAT_ID` (replaced by the `users` table and `ADMIN_CHAT_ID`).

---

## 15. Rollout

1. **Admin as user one, dry run, one week.** `dry_run = true`. Everything runs and logs, nothing sends. Read the Telegram DRY RUN messages daily, compare them with what you would have written, and tune prompts, the fit threshold, and the master facts.
2. **Verifier test.** Feed it deliberately inflated emails and confirm it blocks them. Include a case claiming work authorization, a case claiming too many years, and a case with a wrong name or contact detail.
3. **Image test.** Run 20 real image posts through extraction and check the transcribed addresses by eye.
4. **Isolation test.** With two test users, confirm each can only see and change their own facts, applications, settings and drafts, and that a failure or pause on one never affects the other.
5. **Send safety tests (all three must pass before any live send).**
   - *Crash after Gmail accepts:* simulate Gmail accepting a message and the worker dying before the database write. Recovery must reconcile the attempt and must not issue a second send.
   - *Concurrent workers:* with one daily slot left, run two workers on different applications for the same user. At most one may obtain a reservation. Repeat against the spacing rule and the recipient-domain limit.
   - *Stale worker:* pause worker A until its lease expires, let worker B reclaim the application, then resume A. A must be unable to publish results or authorize a send. If A had already started a Gmail request, recovery must reconcile that attempt, not resend.
6. **Go live as user one at stage 1** (3 per day) and follow the ramp in section 12.
7. **Invite 2 or 3 testers.** Each starts in dry run, connects Gmail, and reviews drafts before going live. Watch their bounce rates and the shared X and Gemini spend.
8. **Review weekly** per-user numbers and the shared budget, and adjust queries, fit thresholds, the ramp, and per-user ceilings. Add more users only when the budget and the numbers allow.

---

## 16. Build order

- [ ] Neon schema: users, invites, oauth_states, user_settings, global_settings, facts_versions, jobs, applications, spend tables
- [ ] Encryption helper and user-scoped query helper, with the cross-user isolation test
- [ ] Vercel project, `CRON_SECRET`, external scheduler jobs
- [ ] Telegram bot, webhook, secret check, user lookup, invite flow, `/agree`, admin role and commands
- [ ] Resume upload per user: parse PDF/Word, diff, `/accept` into the versioned facts table, `/rollback`, `/set` commands
- [ ] Gmail OAuth for users: `/connect`, start and callback routes, encrypted token storage, `/disconnect`
- [ ] Per-user settings commands: `/reads`, `/cap`, `/window`, `/timezone`, `/pause`, `/dry`
- [ ] Admin limits: `/admin xreads`, `/admin threads`, `/admin ingest`, `/admin pauseall`
- [ ] Manual URL ingest (single-post fetch) and the extract stage with vision
- [ ] Thread expansion (author-only, budget-capped), two-pass extraction
- [ ] Shared gates (round 1) with unit tests, including regex and MX check
- [ ] Fan-out with per-user limits and per-user dedupe
- [ ] Match, tailor, and verify stages, per user
- [ ] Fixed-template PDF renderer, locked fields, and Blob upload
- [ ] Resume mode: PDF validation, private storage with hash, `/resumemode`, uploaded path in tailor and link routes, fallback and re-queue rules, retention cleanup
- [ ] Claim tokens: claim, renew and conditional-complete helpers, with the stale-worker test
- [ ] `send_state` and `send_attempts`, send authorization under lock, one-active-send index, concurrency test
- [ ] Send path with per-user Gmail, dry-run mode, durable attempts, confirmed vs uncertain outcomes
- [ ] Reconciliation by Message-ID, `/resolve`, and the crash-after-accept test
- [ ] Dry run week (admin)
- [ ] X search ingest with `since_id` and spend tracking
- [ ] Link path: log, Telegram message with resume and cover note, `/done`, deadline reminder
- [ ] Inbox job: bounces, replies, classification, per-user rotation
- [ ] Reply drafter and follow-up drafter (Gmail drafts)
- [ ] Per-user ramp logic, auto-pause triggers, per-user and admin daily summaries
- [ ] `/import`, `/delete_me`, privacy notice
- [ ] Go live as user one at stage 1, then invite testers

---

## 17. Out of scope for v1

- Filling forms or opening apply links (they are sent to the user instead), and DMs
- Free rewriting of resume bullets (only selecting and ordering)
- Multiple resume templates, and editing or tailoring an uploaded PDF (a user who wants their own design uses uploaded mode, which attaches it unchanged)
- Automatic sending of replies or follow-ups
- Interview scheduling and calendar integration
- A public launch, open sign-up, or payments

---

## 18. Things to verify before building

- Current X API pricing, per-resource billing for expansions, and your actual spend after day one
- That a $20 per month read budget yields enough emailable posts for the whole group, and the query set that gets the best yield
- Gemini vision accuracy on email addresses in real images from your search results
- Each tester's Gmail behavior over the first two weeks of live sends
- Gemini model name and structured output support for image inputs
- That a `conversation_id` search works for your real thread cases, and how those reads are billed
- Google's current rules for unverified apps (user cap, warning screen) and restricted-scope verification requirements before you grow past a small test group
- That Gemini usage per user stays within your cost limit at the review limits you set
- That `.docx` and PDF text extraction handles your testers' real resumes, including two-column layouts
- That Gmail keeps a custom `Message-ID` header on API sends and that `in:sent rfc822msgid:` finds the message. If it rewrites the ID, fall back to matching recipient, subject and send time after `reserved_at`, and treat any ambiguous match as inconclusive
- How long Gmail's Sent search lags after a send, to tune the 30-minute reconciliation window
- Which Gmail API responses are definitive rejections and which are uncertain, so the confirmed-failure rule in section 7.9 is classified correctly
- That your testers' PDFs pass the upload checks (embedded files, scripts, page count, text layer) without rejecting normal resumes
