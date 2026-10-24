# Dev B: Platform, Delivery & Lifecycle Pipeline Specification

> **Branch:** `output-op-y`  
> **Role:** Dev B (Platform, Sending Engine, Users & Invites, Telegram Bot & Commands, Gmail OAuth & AES-256 Token Encryption, Send Authorization & Attempts, Reconciliation Engine, Inbox & Reply Drafts, Ramp Schedule, and Auto-Pause Safety)  
> **Target Release:** v3.2

---

## 1. Overview & Mission

Dev B is responsible for the **Platform, Delivery, and Lifecycle Engine** of the Job Application Agent. This subsystem picks up verified applications handed off by Dev A at **`status = 'verified'`** (for the email delivery route) and **`status = 'link_ready'`** (for manual application links), securely manages multi-user onboarding and private data, provides a Telegram-based command and alert interface, serializes send reservations, executes delivery via each candidate's own Gmail account, guarantees zero duplicate sends via durable pre-send attempt records and RFC Message-ID reconciliation, monitors inboxes for recruiter responses and bounces, drafts verified follow-ups and replies, and enforces a conservative per-user ramp schedule with automated safety pause switches.

```text
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │                        DEV B: PLATFORM, DELIVERY & LIFECYCLE PIPELINE                  │
 └────────────────────────────────────────────────────────────────────────────────────────┘

  [ Dev A Handoff ] ──► applications (status = 'verified' | 'link_ready')
                                │
   ┌────────────────────────────┴───────────────────────────┐
   │                                                        │
   ▼ (email route: 'verified')                              ▼ (link route: 'link_ready')
 [ 1. Send Authorization & Serialization ]             [ Telegram Card Dispatch ]
   • Lock send_state (FOR UPDATE)                        • Role, Company, Link, Deadline
   • Check window, spacing, caps, domain limits          • Cover note + Tailored PDF
   • Dry-run intercept (Telegram mock preview)           • User applies manually (/done)
   • Commit 'reserved' attempt in send_attempts
            │
            ▼
 [ 2. Atomic Send Execution ]
   • Build MIME message with RFC Message-ID
   • Attach PDF ({FirstName}_{LastName}_Resume.pdf)
   • Transition attempt to 'sending' (started_at)
   • Gmail API: users.messages.send
            │
            ├──────────────────────────┬──────────────────────────┐
            ▼ (HTTP 200)               ▼ (Confirmed 4xx)          ▼ (Timeout / 5xx / Crash)
    [ Success Outcome ]        [ Confirmed Failure ]      [ Uncertain Outcome ]
    • Attempt: 'sent'          • Attempt: 'failed'        • Attempt: 'send_unknown'
    • App: 'sent'              • App: back to 'ready'     • App: 'send_unknown'
    • Next gap: 2–8m           • Auth error: pause user   • Freeze user sending
    • Telegram sent card                                          │
                                                                  ▼
 [ 3. Reconciliation Engine ] ◄───────────────────────────────────┘
   • Search Sent folder: in:sent rfc822msgid:<id>
   • Found: mark 'sent', clear block
   • Lagging (<30m): retry next cron pass
   • Inconclusive (>=30m): Telegram prompt -> /resolve <id> sent|notsent
            │
            ▼
 [ 4. Inbox Scanner & Bounce Monitor ] (cron every 2h, user rotation)
   • Bounces (mailer-daemon): mark 'bounced', retry 2nd address or 'needs_manual'
   • Inbound recruiter threads: Gemini classification (interview, assessment, question, rejection, auto)
            │
            ▼
 [ 5. Contextual Drafting Engine ]
   • Reply Drafter: saves verified Gmail draft in thread, alerts via Telegram
   • Follow-up Drafter: 7 days after send without reply, drafts follow-up in thread
            │
            ▼
 [ 6. Ramp & Auto-Pause Circuit Breakers ] (cron hourly / daily 20:00 local)
   • Multi-stage cap progression (Stages 0 to 5)
   • Circuit breakers: bounce rate > 5%, 3 consecutive failures, uncertain send, auth loss
```

---

## 2. Dev A vs Dev B Boundary Map

| Feature / Responsibility | Owner | Dev B Ownership Detail |
| :--- | :---: | :--- |
| **X Ingestion & Thread Expansion** | Dev A | Dev A runs search API, tracks X spend, expands author-only threads. |
| **Multimodal Extraction & Vision** | Dev A | Dev A transcribes flyers, parses role parameters, outputs structured JSON. |
| **Shared Gates (Round 1)** | Dev A | Dev A enforces scam detection, regex email extraction, DNS MX lookups, deduplication. |
| **User Fan-Out & Fit Scoring** | Dev A | Dev A distributes jobs, checks candidate 30-day contact dedupe, scores fit (0–100). |
| **Tailoring, Truth Audit & PDF** | Dev A | Dev A selects project bullets, validates truthfulness, compiles ATS resume PDF buffer. |
| **Resume Parsing & Facts Engine** | Dev A | Dev A parses uploaded PDF/DOCX into `MasterFacts` schema and computes diffs. |
| **User Onboarding & Invites** | **Dev B** | Admin `/invite`, `/start <code>`, privacy notice, `/agree`, status transitions (`pending` -> `active`). |
| **Telegram Bot & Command Center** | **Dev B** | Webhook at `/api/telegram`, rate-limiting, full suite of user and admin slash commands. |
| **Gmail OAuth & Token Encryption** | **Dev B** | Web OAuth flow, AES-256-GCM encryption/decryption, token revocation, error handling. |
| **Send Authorization & Locks** | **Dev B** | Per-user `send_state` row-level locks, send window, daily caps, domain limits, spacing intervals. |
| **Send Execution & MIME Builder** | **Dev B** | Builds MIME with custom RFC `Message-ID`, attaches resume PDF, calls Gmail `users.messages.send`. |
| **Durable Attempts & Reconciliation** | **Dev B** | Pre-send `send_attempts` records, `in:sent rfc822msgid:<id>` query pass, `/resolve` command. |
| **Link Route Job Notification** | **Dev B** | Formats Telegram cards for `link` / `form` jobs, attaches PDF and cover note, handles `/done`. |
| **Inbox & Bounce Scanner** | **Dev B** | Scans bounces (`mailer-daemon`), monitors application threads, classifies replies with Gemini. |
| **Reply & Follow-up Drafter** | **Dev B** | Generates verified Gmail drafts (`users.drafts.create`), 7-day follow-up triggers, zero auto-send. |
| **Ramp Schedule & Auto-Pause** | **Dev B** | Automated stage elevation (1 to 5), dry-run conditions, circuit-breaker auto-pause triggers. |

---

## 3. Detailed Component Architecture

### 3.1. User Management, Invites & Onboarding ([`lib/users.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/users.ts))
- **Role Differentiation:**
  - `admin`: Identified strictly by `ADMIN_CHAT_ID`. Manages invites, modifies global limits, inspects multi-user health, triggers manual ingests, and uses the tool as a regular user.
  - `user`: Authenticated by their private `telegram_chat_id`. Can only access, inspect, and modify their own settings, applications, facts, and drafts.
- **Invite Code Management (`invites` table):**
  - Generated via admin command `/invite`. Creates an 8-character cryptographic token (`code`), tracks `uses`, `max_uses = 1`, and optional expiration.
  - Enforces `MAX_USERS = 20` cap: rejects `/start` if active user count reaches the ceiling.
- **Onboarding Lifecycle:**
  1. User issues `/start <code>`. Bot verifies code exists, is unused, and not expired.
  2. Creates user record with `status = 'pending'`. Presents plain-language Privacy & Data Notice (what is stored, Gmail send access, read scope).
  3. User confirms with `/agree`. Transitions `status = 'active'`, stores `consented_at = now()`, `consent_version = 'v3.2'`. All other commands are rejected until agreed.
  4. User sends their resume (PDF or DOCX). Dev A parses text, diffs with existing schema, and outputs a proposed `facts_versions` row in `pending` state.
  5. User fine-tunes non-inferable attributes: `/set years N`, `/set relocation yes|no`, `/set framing <text>`, then issues `/accept`.
  6. User issues `/connect` to link their Gmail account.
  7. User configures preferences: `/reads 100`, `/cap 3`, `/window 9 17`, `/timezone Africa/Lagos`.
  8. Every new user begins in **Dry Run** mode (`user_settings.dry_run = true`, `ramp_stage = 0`).
- **User Account Deletion (`/delete_me`):**
  - Interactive confirmation prompt. Upon confirmation: revokes Gmail token with Google, cascades deletes through `user_settings`, `facts_versions`, `applications`, `send_attempts`, `send_state`, and `events`, removes uploaded resume PDFs from Vercel Blob, and sets user `status = 'deleted'`.
- **Tenant Isolation Safeguard:**
  - All queries touching user-owned tables (`applications`, `facts_versions`, `events`, `user_settings`, `user_spend`, `send_state`, `send_attempts`) must route through helper functions enforcing explicit `user_id` filtering.

---

### 3.2. Telegram Bot & Interactive Command Center ([`app/api/telegram/route.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/app/api/telegram/route.ts), [`lib/telegram.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/telegram.ts))
- **Webhook Endpoint:** `POST /api/telegram`
  - Validates `X-Telegram-Bot-Api-Secret-Token` matching `TELEGRAM_WEBHOOK_SECRET`. Returns `401` on mismatch.
  - Rate-limits incoming messages per chat ID (maximum 30 requests/minute).
  - Authorizes sender: matches incoming `message.chat.id` against `users.telegram_chat_id`. Unknown chats are discarded unless executing `/start <code>`.
- **Comprehensive User Command Suite:**

| Command | Arguments | Description & State Mutation |
| :--- | :--- | :--- |
| `/start` | `<code>` | Validates invite code, initializes `pending` user account, presents Privacy Notice. |
| `/agree` | *none* | Accepts terms, sets `status = 'active'`, activates command permissions. |
| `/connect` | *none* | Generates 10-minute CSRF token in `oauth_states`, replies with Google OAuth link. |
| `/disconnect` | *none* | Revokes token via Google API, wipes DB credentials, sets `gmail_status = 'disconnected'`. |
| `/pause` | *none* | Sets `paused = true`. Immediately freezes active sends and fan-out matching. |
| `/resume` | *none* | Sets `paused = false`. Resumes automated processing and sending. |
| `/status` | *none* | Summarizes application pipeline counts, today's sends vs cap, ramp stage, and Gmail status. |
| `/cap` | `<N>` | Sets daily send cap (enforces `N <= max_cap`). |
| `/reads` | `<N>` | Sets daily shared post review limit (enforces `N <= max_reads_ceiling`). |
| `/dry` | `on` \| `off [confirm]` | Toggles dry run. Disabling dry run requires meeting strict safety prerequisites. |
| `/window` | `<H1> <H2>` | Sets daily sending window in local hours (e.g. `/window 9 17` for 9 AM to 5 PM). |
| `/timezone` | `<zone>` | Sets IANA timezone identifier (e.g. `/timezone Africa/Lagos`, `America/New_York`). |
| `/last` | *none* | Lists the candidate's last 5 sent applications with timestamps and recipients. |
| `/drafts` | *none* | Lists pending reply drafts and follow-up drafts with direct Gmail links. |
| `/skip` | `<id>` | Rejects a queued or ready application before it is reserved for sending. |
| `/resolve` | `<id> sent\|notsent` | Manually settles an uncertain send outcome after an inconclusive reconciliation. |
| `/done` | `<id>` | Marks a link application as applied (`status = 'applied_manually'`). |
| `/links` | *none* | Lists pending link/form applications waiting for manual submission, sorted by deadline. |
| `/run` | *none* | Triggers an immediate execution cycle for the user's ready queue within remaining limits. |
| `/import` | `<emails...>` | Imports past recipient emails (`imported = true`, `status = 'sent'`) to prevent re-applying. |
| `/accept` | *none* | Deliberate approval: activates pending facts version, resets unsent drafts to `queued`. |
| `/reject` | *none* | Discards proposed pending facts version. |
| `/rollback` | *none* | Reverts to previous facts version, re-activating prior schema and resume PDF. |
| `/set` | `years <N>` | Sets verified years of professional experience. |
| `/set` | `relocation yes\|no` | Sets candidate's willingness to relocate for on-site positions. |
| `/set` | `gaps <a, b...>` | Sets candidate's known technical gaps. |
| `/set` | `framing <text>` | Configures personal gap framing sentence. |
| `/resumemode`| `generated\|uploaded` | Switches between ATS template rendering and byte-for-byte static uploaded PDF attachment. |
| `/delete_me` | *none* | Triggers interactive confirmation to purge account, files, and database records. |
| *Tweet URL* | `https://x.com/...` | Ingests a single post for this user (`source = 'manual'`), expands thread, processes queue. |

- **Administrative Command Suite (`ADMIN_CHAT_ID` only):**

| Command | Arguments | Administrative Function |
| :--- | :--- | :--- |
| `/invite` | *none* | Generates a new single-use invite code. |
| `/users` | *none* | Displays system-wide roster with statuses, Gmail states, ramp stages, and daily stats. |
| `/suspend` | `<user_id>` | Suspends user account (`status = 'suspended'`). Freezes all processing. |
| `/unsuspend` | `<user_id>` | Restores user account to `active`. |
| `/limits` | `<user_id> cap N reads N` | Adjusts per-user `max_cap` and `max_reads_ceiling`. |
| `/admin xreads` | `<N>` | Overrides today's global X read cap (capped at `X_MAX_DAILY_READS = 300`). |
| `/admin threads` | `<N>` | Overrides today's global thread expansion quota. |
| `/admin ingest` | *none* | Manually triggers an out-of-band X ingestion run. |
| `/admin pauseall`| *none* | Global emergency kill-switch: sets `global_paused = 'true'`. Halts all sends. |
| `/admin resumeall`| *none* | Clears global kill-switch: sets `global_paused = 'false'`. |

- **Proactive Telegram Notifications:**
  - **Live Send Card:** Dispatched immediately upon verified Gmail delivery. Includes Role, Company, Recipient Email, Fit Score, Gap Analysis, Address Source (`text` vs `image`), and full email body.
  - **DRY RUN Card:** Formats the complete simulated application, email body, and indicates which PDF would be attached.
  - **Link Opportunity Card:** Role, Company, Remote/Location, Salary, Deadline urgency, Apply Link (raw domain), Post Link, tailored Cover Note, and the generated/uploaded PDF attached as a document.
  - **Urgent Action Alerts:** Recruiter replies (interview/assessment flags), delivery bounces, uncertain send prompts requiring manual resolution, and auto-pause safety notifications.
  - **Daily Summaries:** Candidate summary delivered at 20:00 local time; Admin daily overview sent once per day.

---

### 3.3. Gmail OAuth 2.0 & Token Cryptography ([`lib/crypto.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/crypto.ts), [`lib/gmail.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/gmail.ts))
- **Web OAuth 2.0 Architecture:**
  - One centralized Google Cloud project with Gmail API enabled and a Web Application OAuth Client ID.
  - Redirect URI: `${APP_BASE_URL}/api/oauth/gmail/callback`.
  - Required Scopes:
    - `https://www.googleapis.com/auth/gmail.send`
    - `https://www.googleapis.com/auth/gmail.readonly`
    - `https://www.googleapis.com/auth/gmail.compose`
  - Consent parameters: `access_type=offline`, `prompt=consent` (forces return of `refresh_token`).
- **OAuth State Lifecycle (`oauth_states` table):**
  - Endpoint `GET /api/oauth/gmail/start?state=...`:
    - Validates that `state` exists, is unused, and `expires_at > now()`.
    - Redirects user to Google OAuth consent screen with matching state parameter.
  - Callback `GET /api/oauth/gmail/callback?code=...&state=...`:
    - Validates state, marks `used = true`.
    - Exchanges `code` for Google OAuth tokens.
    - Inspects Google profile via `users.getProfile` to extract candidate's actual `gmail_address`.
    - Encrypts `refresh_token` using AES-256-GCM.
    - Updates user record: `gmail_address`, `gmail_refresh_token_enc`, `gmail_status = 'connected'`, `gmail_connected_at = now()`.
    - Emits Telegram confirmation: *"Gmail connected as candidate@gmail.com"*.
    - **Missing Refresh Token Fallback:** If Google returns only an access token (due to prior authorization), the callback notifies the user to revoke app permissions at their Google Account settings and run `/connect` again.
- **AES-256-GCM Cryptographic Standard:**
  - Key derived from `TOKEN_ENCRYPTION_KEY` environment variable (32 bytes base64 decoded).
  - Initialization Vector (IV): 12 bytes randomly generated per encryption operation.
  - Stored format in `users.gmail_refresh_token_enc`: `iv:authTag:ciphertext` (base64).
  - Tokens are decrypted **strictly in memory** within the execution scope of the worker needing them.
  - Raw refresh tokens and access tokens are **never logged**, never written to `events`, and ephemeral access tokens are never saved to disk or database.
- **Token Invalidation & Error Handling:**
  - If Google returns `invalid_grant` or any authentication error:
    - Sets `users.gmail_status = 'error'`.
    - Pauses candidate's sending (`user_settings.paused = true`).
    - Dispatches Telegram alert prompting candidate to re-authenticate with `/connect`.

---

### 3.4. Send Authorization & Concurrency Serialization ([`lib/send.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/send.ts))
- **The Concurrency Challenge:**
  - Row leases prevent duplicate processing of a single application row, but they do NOT serialize across different applications for the same Gmail account. Without serialization, two parallel workers could simultaneously read that a user has sent 2 of 3 daily emails, and both proceed to send, violating daily caps, domain limits, and spacing intervals.
- **The Solution: Account-Level Row Lock:**
  - Every send attempt must acquire a row-level lock on `send_state` for that specific candidate:
    ```sql
    select * from send_state where user_id = $1 for update;
    ```
- **Seven-Step Send Authorization Transaction:**
  Executed within a single database transaction committed **BEFORE** contacting Gmail:
  1. **Global & Account Pause Check:**
     - Verify `global_settings.global_paused === 'false'`.
     - Verify `users.status === 'active'`.
     - Verify `users.gmail_status === 'connected'`.
     - Verify `user_settings.paused === 'false'`.
  2. **Application State Validation:**
     - Verify `applications.status === 'verified'`.
     - Verify `applications.claim_token === worker_token`.
     - Verify `applications.attempts < 3` (counting confirmed failures only).
     - Verify application has no existing live send attempt.
  3. **Account Send State Check:**
     - Check `send_attempts` for any active attempt in `reserved`, `sending`, or `send_unknown`.
     - **Hard Rule:** Exactly one active send per account. Any uncertain send blocks all subsequent sending for that account until reconciled.
  4. **Time Window & Spacing Interval:**
     - Convert current time to candidate's configured `timezone`.
     - Ensure current local hour is between `send_window_start` and `send_window_end`.
     - Ensure `now() >= send_state.next_send_at`.
  5. **Daily Cap & Recipient Domain Limits:**
     - Calculate today's total sends for the candidate in their local timezone.
     - Count includes all attempts in `reserved`, `sending`, `sent`, and `send_unknown` (excludes `failed` and `released`).
     - Ensure total attempts for today < `user_settings.current_cap`.
     - Ensure total attempts to the recipient's domain today < 2.
  6. **Dry-Run Intercept:**
     - If `user_settings.dry_run === true`: bypass send reservation. Store draft copy, dispatch Telegram mock preview card, increment `dry_run_drafts_shown`, and stop without calling Gmail.
  7. **Durable Reservation Commit:**
     - Insert record into `send_attempts` in state `'reserved'` with: candidate ID, application ID, recipient email, recipient domain, stable RFC Message-ID, SHA-256 hash of email body, resume URL, and resume SHA-256 hash.
     - Update application `status = 'sending'`.
     - Update `send_state.active_attempt_id = attempt.id`.
     - **COMMIT transaction.**
  
  > [!IMPORTANT]
  > Never hold a database transaction open across the Gmail API call. The reservation must be committed to disk before the network request is initiated.

- **Slot Release Conditions:**
  - A reserved slot may be released back to `ready` **only** if:
    1. The attempt is still in `reserved` state with `started_at IS NULL` (Gmail was never contacted).
    2. The attempt failed with a confirmed, definitive rejection (HTTP 4xx).
    3. The attempt was reconciled as not sent via Sent mailbox search or manual resolution.
  - An attempt in `sending` or `send_unknown` is **never** released by a timeout or lease expiration.

---

### 3.5. Gmail Delivery & MIME Message Assembly ([`lib/send.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/send.ts), [`lib/gmail.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/gmail.ts))
- **MIME Construction:**
  - Generates a compliant RFC 2822 multipart/mixed message.
  - Injects stable `Message-ID: <{rfc_message_id}>` header.
  - Sets `To`, `From` (candidate's verified Gmail address), `Subject`, `Date`.
  - Body: Plain text UTF-8, no HTML, no open tracking pixels, consistent sign-off.
  - Resume Attachment:
    - Fetches resume buffer from Vercel Blob using `resume_blob_url`.
    - Validates SHA-256 hash matches the hash recorded in the reserved attempt.
    - Encodes attachment in base64 with filename `{FirstName}_{LastName}_Resume.pdf` (derived from candidate's verified `MasterFacts.identity.name`).
- **Delivery Protocol:**
  1. Transition attempt state:
     ```sql
     update send_attempts
     set state = 'sending', started_at = now()
     where id = $attempt_id and state = 'reserved';
     ```
     If 0 rows updated, stop immediately. Commit before calling Gmail.
  2. Invoke Gmail API: `users.messages.send` with encoded raw MIME payload.
  3. **Outcome Triage & Handling:**
     - **Case A: Confirmed Success (HTTP 200)**
       - Transactionally update:
         - `send_attempts`: `state = 'sent'`, `gmail_message_id`, `gmail_thread_id`, `finished_at = now()`.
         - `applications`: `status = 'sent'`, `gmail_message_id`, `gmail_thread_id`, `applied_at = now()`, `follow_up_at = now() + interval '7 days'`.
         - `send_state`: `active_attempt_id = null`, `next_send_at = now() + (random() * (480 - 120) + 120) * interval '1 second'` (random 2 to 8 minute spacing).
       - Dispatch Telegram Live Send Card to candidate.
     - **Case B: Confirmed Failure (Definitive HTTP 4xx / Quota / Policy)**
       - Update attempt: `state = 'failed'`, `error = response_error`, `finished_at = now()`.
       - Increment `applications.attempts = attempts + 1`.
       - If `attempts < 3`: return application `status = 'ready'`.
       - If `attempts >= 3`: set application `status = 'failed'`, alert candidate.
       - Clear `send_state.active_attempt_id`.
       - If error indicates invalid token or auth failure: set `users.gmail_status = 'error'`, pause candidate sends (`user_settings.paused = true`), alert candidate.
     - **Case C: Uncertain Outcome (Timeout / 5xx / Network Drop / Crash)**
       - Worker was interrupted after `started_at`.
       - Attempt remains or is set to `state = 'send_unknown'`.
       - Application set to `status = 'send_unknown'`.
       - **DO NOT RETRY.** Do not release the slot.
       - Send queue for this candidate is blocked.
       - Escalate directly to Reconciliation Engine.

---

### 3.6. Durable Reconciliation Engine ([`app/api/cron/send/route.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/app/api/cron/send/route.ts), [`lib/send.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/send.ts))
- **Execution Lifecycle:**
  - Runs at the beginning of every invocation of `/api/cron/send` across all users, independent of local sending windows.
  - Queries `send_attempts` for:
    1. Attempts stuck in `state = 'sending'` with `started_at < now() - interval '2 minutes'`.
    2. All attempts in `state = 'send_unknown'`.
- **Sent Mailbox Search:**
  - Queries candidate's Sent folder using exact Message-ID:
    `in:sent rfc822msgid:<rfc_message_id>`
  - Uses candidate's Gmail client with restricted read scope.
- **Triage Matrix:**
  1. **Message Located in Sent Mail:**
     - Message was indeed delivered by Gmail before network failure.
     - Transactionally mark attempt `state = 'sent'`, application `status = 'sent'`, populate `gmail_message_id` and `gmail_thread_id`.
     - Set `applied_at = message.internalDate`.
     - Clear `send_state.active_attempt_id`.
     - Dispatch Telegram notification: *"Application to {Company} confirmed sent via reconciliation."*
  2. **Message Not Found (< 30 minutes elapsed):**
     - Gmail search indices may lag up to several minutes.
     - Increment `reconcile_checks = reconcile_checks + 1`, update `last_reconcile_at = now()`.
     - Leave attempt in `send_unknown`. Candidate sending remains paused. Re-check on next cron pass.
  3. **Message Not Found (>= 30 minutes elapsed / `reconcile_checks >= 15`):**
     - Inconclusive state reached. Automatic checks cease.
     - Alert candidate and admin via Telegram with details (role, company, recipient, attempt ID).
     - Prompts candidate for manual resolution:
       - `/resolve <attempt_id> sent`: Marks attempt and application as `sent`.
       - `/resolve <attempt_id> notsent`: Marks attempt as `'released'`, resets application `status = 'ready'`, frees the reservation slot.

---

### 3.7. Link & Form Application Dispatcher ([`lib/telegram.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/telegram.ts), [`lib/send.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/send.ts))
- **Trigger:** Jobs identified with `apply_method = 'link' | 'form'` that reach `applications.status = 'link_ready'`.
- **Operational Rules:**
  - The agent **never** opens, scrapes, or submits external web forms.
  - Link applications do NOT count against daily Gmail caps, do NOT require send window checks, and do NOT enforce spacing intervals.
  - They count toward candidate's daily shared post review limit (`user_spend.reviewed`).
- **Interactive Telegram Delivery Card:**
  - Role, Company, Location or Remote designation.
  - Stated Salary (if extracted, for information only).
  - Application Deadline: flagged as **🚨 URGENT** if remaining time is <= 48 hours.
  - Fit Score (0–100) and specific Gaps identified by Gemini.
  - Original Post URL and Apply Link (displaying raw target domain to safeguard against phishing).
  - Suggested Cover Note: tailored by Dev A and audited by the truth verifier, formatted for immediate copy-pasting.
  - Tailored Resume PDF: attached directly as a downloadable document (`.pdf`).
- **Candidate Commands & Follow-ups:**
  - Candidate applies manually via browser, then reports: `/done <application_id>`.
  - Sets application `status = 'applied_manually'`, `applied_at = now()`.
  - Automated reminder: If application remains in `link_ready` within 48 hours of deadline and has not been marked `/done`, bot sends a one-time reminder alert.

---

### 3.8. Inbox Scanner, Recruiter Replies & Follow-up Drafter ([`app/api/cron/inbox/route.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/app/api/cron/inbox/route.ts), [`app/api/cron/followups/route.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/app/api/cron/followups/route.ts), [`lib/gmail.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/gmail.ts))
- **Inbox Scanner (`/api/cron/inbox`, every 2 hours):**
  - Rotates across active users, prioritizing candidates with oldest `last_inbox_scan_at`.
  - **Bounce Processing:**
    - Queries candidate's mailbox: `from:mailer-daemon OR from:postmaster newer_than:2d`.
    - Matches bounce notification to sent application via recipient address or thread ID.
    - Sets application `status = 'bounced'`, records bounce detail in `events`.
    - If job listing provided an alternate contact address, queues a single retry to that alternate address; otherwise transitions to `needs_manual`.
    - Tracks user bounce rate against auto-pause thresholds.
  - **Recruiter Thread Monitoring:**
    - Inspects stored `gmail_thread_id` records for new inbound messages from recipient domains.
    - Scans strictly application-created threads (zero inspection of candidate's unrelated personal emails).
- **Inbound Message Classification (Gemini 1.5 Flash):**
  - Evaluates message text and returns structured category:
    - `interview`: Recruiter requests phone screen, technical chat, or interview availability.
    - `assessment`: Automated coding challenge, take-home task, or assessment link.
    - `question`: Technical or administrative follow-up question.
    - `rejection`: Explicit notice of non-advancement.
    - `auto`: Automated out-of-office or receipt acknowledgement.
    - `other`: Uncategorized communication.
- **Automated Response Actions:**
  - `rejection`: Sets application `status = 'closed_by_employer'`. Sends a brief 1-line Telegram notification. Generates no draft.
  - `auto`: Ignores message; leaves status unchanged.
  - `interview` / `assessment` / `question`:
    - Dispatches an **Immediate Telegram Alert** with recruiter text snippet and thread link.
    - Invokes Reply Drafter to generate a response draft directly in candidate's Gmail.
- **Reply Drafter:**
  - Compares inbound recruiter query against candidate's `MasterFacts` and original application.
  - Creates a response draft in the existing thread using Gmail API `users.drafts.create(threadId)`.
  - Audited by Dev A truth verifier: prevents hallucination of skills or availability.
  - Scheduling: leaves a clean placeholder for interview availability unless candidate explicitly populated `user_settings.availability_note`.
  - **Zero Auto-Send Guarantee:** Drafts are saved in Gmail for candidate review and transmission. The agent never sends replies automatically.
  - Dispatches Telegram card containing draft summary, full text, and direct Gmail link.
- **Follow-up Drafter (`/api/cron/followups`, daily):**
  - Identifies applications where `status = 'sent'`, `applied_at <= now() - interval '7 days'`, with zero inbound recruiter replies and no bounce records.
  - Generates a concise, polite follow-up inquiry referencing the original role and submission date.
  - Validates follow-up copy through truth verifier.
  - Saves as a Gmail draft in the existing thread and notifies candidate on Telegram.
  - Hard limit: At most one automated follow-up draft per application.

---

### 3.9. Ramp Schedule & Auto-Pause Safety Engine ([`app/api/cron/summary/route.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/app/api/cron/summary/route.ts), [`lib/users.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/users.ts))
- **Conservative Multi-Stage Ramp Progression:**
  Every invited user advances through an isolated ramp schedule to safeguard sender domain reputation:

| Stage | Daily Send Cap | Progression Criteria to Advance |
| :---: | :---: | :--- |
| **Stage 0 (Dry Run)** | 0 (simulation only) | Prerequisites met + 5 drafts viewed + explicit user confirmation `/dry off confirm`. |
| **Stage 1** | 3 sends / day | 3 consecutive active days with 0 bounces and 0 send errors. |
| **Stage 2** | 5 sends / day | 3 consecutive active days with bounce rate < 3%. |
| **Stage 3** | 10 sends / day | 4 consecutive active days with bounce rate < 3% and no account warnings. |
| **Stage 4** | 15 sends / day | 4 consecutive active days with bounce rate < 3%. |
| **Stage 5** | 20 sends / day (Max) | Steady state ceiling (admin can lower via `max_cap`). |

- **Dry-Run Exit Gate:**
  User command `/dry off` is rejected until all four conditions are met:
  1. Candidate's Gmail is connected (`gmail_status = 'connected'`).
  2. Candidate has an active accepted facts version (`facts_versions.status = 'active'`).
  3. Candidate has explicitly set verified `years_experience` via `/set years N`.
  4. Candidate has reviewed at least 5 simulated drafts (`dry_run_drafts_shown >= 5`).
  Upon meeting prerequisites, candidate enters `/dry off confirm` to enter Stage 1.
- **Daily Automated Ramp Review:**
  - Handled by `/api/cron/summary` evaluated when candidate's local time passes 20:00.
  - Calculates active days and bounce metrics. If criteria are met, elevates `ramp_stage`, updates `current_cap`, and sends Telegram notification. Candidate can override at any time via `/cap <N>`.
- **Auto-Pause Circuit Breakers:**
  The system automatically halts sending (`user_settings.paused = true`) and alerts candidate and admin upon detecting any of the following:
  1. **Elevated Bounce Rate:** Bounce rate exceeds 5% over candidate's last 20 sends.
  2. **Consecutive Delivery Failures:** Three consecutive confirmed send rejections from Gmail.
  3. **Uncertain Delivery Stuck:** Any send attempt remaining in `send_unknown`.
  4. **Authentication Revocation:** Gmail API returns `invalid_grant` or token revocation (`gmail_status = 'error'`).
- **Global Administrative Kill-Switch:**
  - Admin command `/admin pauseall` sets `global_settings.global_paused = 'true'`. Instantly halts all reservation, sending, and fan-out activities across all users.

---

## 4. Database Schema Interaction (Dev B)

Dev B manages user records, authentication credentials, serialization locks, send attempts, and delivery state transitions across Neon Postgres:

| Table | Dev B Access | Key Operations & Responsibilities |
| :--- | :---: | :--- |
| `users` | **Read / Write** | Manages onboarding state (`pending` -> `active`), stores encrypted Gmail tokens, updates `gmail_status`, records `last_inbox_scan_at` and `last_summary_on`. |
| `invites` | **Read / Write** | Creates invite tokens (`/invite`), verifies valid usage, increments `uses` counter, enforces `MAX_USERS`. |
| `oauth_states` | **Read / Write** | Inserts 10-minute CSRF state tokens during `/connect`, verifies and marks `used = true` during callback. |
| `user_settings` | **Read / Write** | Manages candidate limits (`current_cap`, `daily_read_cap`, `send_window`, `timezone`), tracks `dry_run`, updates `ramp_stage`. |
| `send_state` | **Read / Write** | **Concurrency serialization point.** Acquired via `SELECT ... FOR UPDATE`. Updates `active_attempt_id` and calculates `next_send_at` spacing. |
| `send_attempts` | **Read / Write** | Creates pre-send durable reservations (`reserved`), transitions to `sending`, finalizes `sent` / `failed` / `send_unknown` / `released`. |
| `applications` | **Read / Write** | Reads `verified` and `link_ready` rows; updates `status` to `sending`, `sent`, `bounced`, `applied_manually`; records Gmail IDs and draft IDs. |
| `global_settings` | **Read / Write** | Reads and modifies `global_paused`, `x_daily_read_cap`, `x_daily_thread_cap`. |
| `user_spend` | **Read / Write** | Increments manual read usage for candidate-submitted tweet URLs. |
| `events` | **Write** | Logs immutable audit records for sends, bounces, reconciliation events, and auto-pause triggers. |

---

## 5. Environment Variables for Dev B

Dev B requires database, cron authentication, Google OAuth credentials, cryptography keys, and Telegram credentials:

```env
# Database & Core
DATABASE_URL="postgres://username:password@ep-sample-pool.us-east-1.aws.neon.tech/neondb?sslmode=require"
APP_BASE_URL="https://your-domain.vercel.app"

# Cron Security
CRON_SECRET="dev-cron-secret-change-in-production"

# Google OAuth 2.0 (Gmail Sending & Inbox)
GMAIL_CLIENT_ID="1234567890-abcdef.apps.googleusercontent.com"
GMAIL_CLIENT_SECRET="GOCSPX-..."
GOOGLE_REDIRECT_URI="https://your-domain.vercel.app/api/oauth/gmail/callback"

# Token Cryptography (32 random bytes, base64-encoded)
TOKEN_ENCRYPTION_KEY="base64-encoded-32-byte-key=="

# Telegram Bot
TELEGRAM_BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
TELEGRAM_WEBHOOK_SECRET="random-secure-webhook-secret"
ADMIN_CHAT_ID="987654321"

# Multi-Tenant Controls
MAX_USERS="20"

# Storage Access (for downloading resume PDFs during send attachment)
BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..."

# LLM Access (for recruiter reply classification & reply drafting)
GEMINI_API_KEY="AIzaSy..."
GEMINI_MODEL="gemini-1.5-flash"
```

> [!NOTE]
> X (Twitter) API credentials (`X_BEARER_TOKEN`, `X_MONTHLY_BUDGET_USD`) belong strictly to **Dev A** and are not utilized by Dev B pipeline stages.

---

## 6. Cron Routes & Execution Schedule

| Route | Schedule (UTC) | Target & Frequency | Subsystem Responsibility |
| :--- | :---: | :---: | :--- |
| `/api/cron/send` | `*/10 * * * *` | Every 10 mins | First runs reconciliation on uncertain sends across all users; then authorizes and delivers ready applications within user local windows and caps. |
| `/api/cron/inbox` | `0 */2 * * *` | Every 2 hours | Scans bounces and recruiter replies across active users in rotation; classifies replies and drafts responses. |
| `/api/cron/followups`| `0 14 * * *` | Daily at 14:00 UTC | Scans for sent applications 7 days past delivery with no replies; creates follow-up drafts in Gmail. |
| `/api/cron/summary` | `0 * * * *` | Hourly | Evaluates candidate local time: if >= 20:00 and not yet summarized today, dispatches user summary and evaluates ramp stage. Dispatches admin summary once daily. |
| `/api/telegram` | Webhook (Instant) | On-demand POST | Handles interactive commands, file uploads, manual tweet URLs, and administrative controls. |
| `/api/oauth/gmail/start` | Browser GET | On-demand | Initiates Google OAuth consent flow with CSRF validation. |
| `/api/oauth/gmail/callback`| Browser GET | On-demand | Exchanges OAuth code for tokens, encrypts refresh token, links Gmail address. |

---

## 7. How to Develop & Test Dev B Locally

### 7.1. Running the Test Suite
Dev B unit and integration tests validate token encryption, command routing, send serialization, reconciliation, and ramp calculations:

```bash
# Run complete test suite
npm test

# Run tests in watch mode
npx vitest

# Run specific Dev B sending and concurrency tests
npx vitest tests/send.test.ts
npx vitest tests/crypto.test.ts
```

### 7.2. Three Mandatory Send Safety Tests
Before deploying to production or enabling live sends for any user, three critical concurrency scenarios must pass:

1. **Crash After Gmail Acceptance (Reconciliation Verification):**
   - *Scenario:* Simulate Gmail API returning `200 OK` followed immediately by worker crash before database write. Attempt remains in `sending`.
   - *Verification:* The next execution of `/api/cron/send` must find the message in Sent mail via `in:sent rfc822msgid:<id>`, mark both attempt and application `sent`, and **must not issue a second send**.
2. **Concurrent Workers Race Condition:**
   - *Scenario:* Configure candidate with 1 remaining send slot for today. Launch two concurrent worker processes attempting to send different applications for that user.
   - *Verification:* The row-level lock on `send_state` must serialize them. Exactly one worker obtains a reservation (`reserved`); the second worker must fail the cap check and leave its application in `ready`.
3. **Stale Worker with Expired Claim Token:**
   - *Scenario:* Worker A reserves an application, but stalls until its claim lease expires. Worker B reclaims the application with a new `claim_token`. Worker A resumes.
   - *Verification:* Worker A's conditional update (`WHERE claim_token = worker_a_token`) updates 0 rows. Worker A immediately aborts without sending.

### 7.3. Simulating Webhooks & Cron Endpoints Locally
With the local server running (`npm run dev`):

```bash
# 1. Simulate Telegram Webhook command (/status)
curl -X POST http://localhost:3000/api/telegram \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: dev-webhook-secret" \
  -d '{
    "update_id": 10001,
    "message": {
      "message_id": 1,
      "from": { "id": 987654321, "first_name": "Test", "username": "tester" },
      "chat": { "id": 987654321, "type": "private" },
      "text": "/status"
    }
  }'

# 2. Trigger Send & Reconciliation Cron
curl -X GET http://localhost:3000/api/cron/send \
  -H "Authorization: Bearer dev-cron-secret-change-in-production"

# 3. Trigger Inbox Scanner Cron
curl -X GET http://localhost:3000/api/cron/inbox \
  -H "Authorization: Bearer dev-cron-secret-change-in-production"
```

### 7.4. Verifying TypeScript Type Safety
```bash
# Ensure 100% strict type safety across all Dev B modules
npx tsc --noEmit
```
