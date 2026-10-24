# X Job Application Agent (v3.2)

An autonomous, multi-user TypeScript agent that monitors X (Twitter) for software engineering job postings, extracts role details using multimodal LLMs, matches candidates against their verified master facts, and sends tailored applications directly from each candidate's own Gmail account with strict safety gates, concurrency controls, and human-in-the-loop response drafting.

All user interactions—from onboarding, resume uploading, and Gmail OAuth connection to preference tuning, live send alerts, and draft reviews—take place inside **Telegram**.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture & Processing Pipeline](#architecture--processing-pipeline)
- [Tech Stack](#tech-stack)
- [System Guarantees & Send Safety](#system-guarantees--send-safety)
- [Resume Modes & Truthfulness Engine](#resume-modes--truthfulness-engine)
- [Database Schema](#database-schema)
- [Project Structure](#project-structure)
- [Telegram Command Reference](#telegram-command-reference)
- [Environment Variables](#environment-variables)
- [Setup & Deployment](#setup--deployment)
- [Ramp Schedule & Safety Controls](#ramp-schedule--safety-controls)
- [Contributing & Testing Guide](#contributing--testing-guide)
- [License](#license)

---

## Overview

Applying to jobs on social media is often fast-moving, fragmented, and tedious. Job posts on X regularly take the form of screenshots, short text snippets with links in threads, or direct requests for email applications.

The **X Job Application Agent** automates this lifecycle for a trusted group of invited users (3–20 candidates) while maintaining strict candidate safety, domain reputation, and truthfulness:

1. **Shared Discovery & Extraction**: Searches X and ingests posts (text and images) once within a strict monthly budget (<$20/mo).
2. **Per-User Matching & Tailoring**: Evaluates each post against individual candidates' verified facts. Tailors a one-page resume and concise, honest email copy without hallucinated skills or inflated experience.
3. **Safe Delivery via Personal Gmail**: Sends applications through each user's own connected Gmail address using serialized reservations, pre-send durable logging, and post-send reconciliation.
4. **Draft-Only Follow-ups & Replies**: Classifies inbound recruiter replies (interviews, assessments, rejections) and prepares Gmail drafts for the user to review and send.

---

## Key Features

- **Multimodal Post Extraction**: Ingests standard text posts as well as image-based job flyers using Gemini Vision. Recipient email addresses are validated via regex and verified with DNS MX record checks.
- **Author-Only Thread Expansion**: Automatically traverses conversation threads authored by the original poster to capture links and contact emails posted as follow-ups (while filtering out third-party scam replies).
- **Two Resume Modes**:
  - `generated` *(default)*: Generates a fresh, ATS-friendly one-page PDF from a fixed template using `@react-pdf/renderer`. Candidate name, contact details, dates, and employers are rendered directly from code and cannot be altered by the LLM.
  - `uploaded`: Attaches the candidate's existing PDF byte-for-byte, tailoring only the cover email.
- **Automated Verification Pass**: A second LLM pass audits the tailored email against the user's master facts to reject any unverified claims (e.g., exaggerated years of experience, unlisted skills, or unauthorized visa claims).
- **Zero Hallucination of Locked Fields**: Core identity data (name, phone, links, education, employers, dates, certifications) is rendered programmatically from validated facts and is never entrusted to the LLM.
- **Durable Concurrency & Send Safety**:
  - Lease-based row claiming with unique `claim_token`s.
  - Per-account serialized send locks to prevent double-sends across parallel cron workers.
  - RFC `Message-ID` pre-reservation in `send_attempts`.
  - Automatic reconciliation against Gmail Sent mail for uncertain network/worker outcomes.
- **Gradual Ramp & Automatic Pausing**: New users start in a mandatory dry-run mode. Once activated, daily volume ramps gradually (Stage 1: 3/day up to Stage 5: 20/day) with auto-pausing if bounce rates exceed 5% or send errors occur.
- **Link & Form Post Handling**: For positions requiring an external form or portal application, the bot compiles the tailored resume and cover note and delivers them to the user's Telegram chat with a direct link to apply manually.
- **Recruiter Reply & Follow-Up Drafting**: Automatically polls connected inboxes for replies and mailer bounces. Generates suggested reply drafts and 7-day follow-up drafts in Gmail without automatically sending them.

---

## Architecture & Processing Pipeline

```text
 X API Search (Scheduled, Shared)        Telegram URL Paste (Per User)
            │                                         │
            ▼                                         ▼
        [ Ingest ] ─────────────────────────► jobs (status = found)
                                                      │
                                           [ Multimodal Extract ]
                                        Gemini: text + images -> JSON
                                                      │
                                           [ Shared Gates (Round 1) ]
                                          Code rules: MX check, scam, dedupe
                                                      │
                                           [ User Fan-Out ]
                                        1 application per eligible user
                                                      │
    ┌─────────────────────────────────────────────────┴─────────────────────────────────────────────────┐
    │                                Per-User Processing Pipeline                                       │
    │                                                                                                   │
    │  [ Per-User Dedupe ] ──► Check 30-day contact email history                                      │
    │           │                                                                                       │
    │  [ Fit Scoring & Match ] ──► Gemini scores fit (0-100) vs user's master facts                     │
    │           │                                                                                       │
    │  [ Tailor Application ] ──► Resume JSON -> PDF (@react-pdf) + tailored email slots                │
    │           │                                                                                       │
    │  [ Truth Verification ] ──► Second Gemini call audits claims against facts JSON                   │
    │           │                                                                                       │
    │  [ Send Authorization ] ──► Atomic send_state lock: verify window, spacing, caps, dry-run         │
    │           │                                                                                       │
    │  [ Durable Reservation ] ──► Insert send_attempts (reserved state) with RFC Message-ID            │
    │           │                                                                                       │
    │  [ Send via Gmail API ] ──► users.messages.send from candidate's Gmail + PDF attachment           │
    │           │                                                                                       │
    │  [ Outcome & Reconcile ] ─► Mark sent, or reconcile uncertain attempts against Sent mail         │
    └─────────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                      │
                       ┌──────────────────────────────┼──────────────────────────────┐
                       ▼                              ▼                              ▼
              [ Mailer Bounce Scan ]        [ Inbound Reply Drafter ]     [ 7-Day Follow-Up Drafter ]
                       │                              │                              │
                       └──────────────────────────────┼──────────────────────────────┘
                                                      ▼
                                       Telegram Bot Notifications
                         (Live sends, manual apply links, draft alerts, summaries)
```

---

## Tech Stack

| Component | Technology | Rationale |
|---|---|---|
| **Framework** | Next.js (App Router, Route Handlers) | Serverless execution on Vercel with structured API endpoints |
| **Language** | TypeScript (Strict mode) | Type safety across Zod schemas, data contracts, and pipeline states |
| **Database** | Neon Postgres | Serverless PostgreSQL with JSONB support and transactional integrity |
| **Scheduler** | External Cron (cron-job.org / QStash) | Reliable invocation of route handlers secured with `CRON_SECRET` |
| **LLM & Vision** | Google Gemini API (with Vision) | Structured JSON output with Zod schemas for text extraction and verification |
| **Job Sourcing** | X API v2 (Recent Search) | Filtered recent search with rate-limit and spend tracking |
| **Email Service** | Google Gmail API (OAuth 2.0) | Authenticated sending from each user's personal Gmail mailbox |
| **Security** | Node `crypto` (AES-256-GCM) | Client-side encryption for stored OAuth refresh tokens |
| **User Interface** | Telegram Bot API | Webhook-driven bot interface for administrative and user controls |
| **PDF Generation** | `@react-pdf/renderer` | Lightweight, serverless-friendly, single-page ATS-compliant PDF generation |
| **Asset Storage** | Vercel Blob | Private storage for uploaded and generated resume PDF files |

---

## System Guarantees & Send Safety

Email sending is high-stakes. A double send, inflated resume claim, or rapid spam-like burst can compromise a candidate's professional reputation and Gmail account standing. The system enforces four hard architectural guarantees:

### 1. Lease Claims & Ownership Tokens
All background batch workers run under row leases (`locked_at`, `lock_owner`, and `claim_token`). If a worker encounters network latency or exceeds its time budget, the lease expires. The worker cannot complete its write without validating its `claim_token`. Stale workers stop immediately and discard their outputs.

### 2. Serialized Send Reservations
Gmail API calls are not part of database transactions. To prevent two concurrent workers from both approving a send when 1 slot remains:
- The user's row in `send_state` is locked with `SELECT ... FOR UPDATE`.
- The user's active window, spacing, daily cap, and domain limit (<2 sends per domain/day) are evaluated.
- A durable row in `send_attempts` is inserted with state `reserved` and a unique, pre-generated RFC `Message-ID`.
- The transaction commits **before** contacting the Gmail API.

### 3. Durable Send Logging & Reconciliation
Before any packet reaches Google's servers, the attempt is logged in Postgres. If a network interruption, timeout, or serverless container freeze occurs during the Gmail API call:
- The attempt transitions to `send_unknown`.
- The user's sending queue is paused to prevent duplicates.
- The scheduled reconciler searches the user's Gmail **Sent** folder specifically for the pre-assigned `rfc822msgid:<Message-ID>`.
- If found, the application is marked `sent`. If unresolved after 30 minutes, the candidate is pinged on Telegram to resolve it manually (`/resolve <id> sent|notsent`).

### 4. Zero Automatic Resends
An uncertain send outcome is never retried automatically. It must either be proven sent via Sent mailbox search or explicitly released by a human.

---

## Resume Modes & Truthfulness Engine

### Resume Modes

Candidates can toggle their resume delivery mode at any time using `/resumemode`:

- **Generated Mode (`generated`)**:
  - The system compiles a tailored one-page resume from the user's accepted master facts using a standardized layout.
  - Relevant bullet points and projects are selected and reordered to match the job post.
  - **Locked Fields**: Candidate name, email, phone, location, links, educational institutions, degrees, employers, titles, dates, and certifications are injected directly by code and cannot be modified by the LLM.
- **Uploaded Mode (`uploaded`)**:
  - The candidate attaches their own pre-designed PDF resume.
  - The agent validates the file (must be unencrypted, <3 pages, with an authentic text layer and no embedded scripts or launch actions).
  - The PDF is sent byte-for-byte; only the introductory email body is customized.

### Verification Pass

Before any application is finalized, a dedicated verification prompt evaluates the tailored email and resume against the user's master facts:
- Flags any skill mentioned in the application that is not listed under `strong` or `working` in the facts JSON.
- Verifies that years of experience exactly match the user's declared number (no rounding up).
- Blocks any unauthorized statements regarding visa sponsorship or work authorization.
- Rejects any email that includes banned stock phrasing (e.g., *"I am excited to apply"*, *"passionate about"*).

---

## Database Schema

The database model is organized around shared job discoveries and user-isolated applications:

```text
users ───────────────┬───► user_settings (daily cap, send window, dry-run, resume mode)
                     ├───► facts_versions (versioned master facts JSON, uploaded PDF SHA-256)
                     ├───► send_state (serialization lock, active attempt, next send window)
                     ├───► user_spend (daily review counter, manual reads, LLM calls)
                     └───► applications ─────────────► send_attempts (immutable send records)
                                ▲
jobs (shared posts) ────────────┘
```

### Core Tables

- **`users`**: Telegram identity, role (`user` | `admin`), onboarding status, and encrypted Gmail refresh token.
- **`user_settings`**: Per-user preferences including `daily_read_cap`, `current_cap`, `ramp_stage`, `dry_run`, `timezone`, `send_window_start`/`end`, and `resume_mode`.
- **`facts_versions`**: Immutable, versioned master facts parsed from uploaded resumes. Requires explicit candidate `/accept` before activation.
- **`jobs`**: Shared post discoveries from X. Holds raw text, Gemini image transcriptions, extracted role requirements, apply method, deduplication hashes, and verified email/link entities.
- **`applications`**: User-specific evaluation of a job. Contains fit scores, gaps, tailored resume references, drafted email copy, Gmail thread IDs, and delivery status.
- **`send_state`**: Single-row-per-user concurrency lock ensuring that only one worker can authorize sends for an account at any given moment.
- **`send_attempts`**: Audit trail of every attempted email delivery containing the RFC `Message-ID`, payload hashes, Gmail IDs, and reconciliation states.
- **`spend` & `user_spend`**: Monitors shared X API queries and per-user LLM consumption against cost caps.

---

## Project Structure

```text
├── app/
│   └── api/
│       ├── cron/
│       │   ├── ingest/route.ts        # X API query execution & post ingestion
│       │   ├── process/route.ts       # Multimodal extraction, fan-out, matching, tailoring
│       │   ├── send/route.ts          # Reconciliation, send authorization, Gmail dispatch
│       │   ├── inbox/route.ts         # Bounce tracking & inbound reply classification
│       │   ├── followups/route.ts     # 7-day follow-up draft generation
│       │   └── summary/route.ts       # Daily summaries, ramp upgrades & admin reports
│       ├── oauth/
│       │   └── gmail/
│       │       ├── start/route.ts     # User OAuth initialization & state creation
│       │       └── callback/route.ts  # Token exchange, profile check & AES-256 encryption
│       └── telegram/
│           └── route.ts               # Telegram webhook dispatcher & command router
├── lib/
│   ├── auth.ts                        # Cron token validation & Telegram signature checks
│   ├── claims.ts                      # Lease claiming, token renewal & conditional release
│   ├── crypto.ts                      # AES-256-GCM encryption/decryption for credentials
│   ├── db.ts                          # Neon Postgres client & tenant-isolated query helpers
│   ├── facts.ts                       # Master facts loader, diff generator & schema validation
│   ├── fanout.ts                      # Eligible user selection & application queueing
│   ├── gates.ts                       # Pure validation gates (MX check, scam filter, dedupe)
│   ├── gemini.ts                      # Structured Gemini calls with Zod schemas & Vision API
│   ├── gmail.ts                       # Authenticated Gmail client (send, drafts, thread search)
│   ├── parse-resume.ts                # PDF/Word text extraction & resume fact parsing
│   ├── pdf/
│   │   └── Resume.tsx                 # ATS-compliant fixed template (@react-pdf/renderer)
│   ├── schemas.ts                     # Zod contracts for extraction, tailoring, and verification
│   ├── send.ts                        # Atomic send reservations, dispatch, and reconciliation
│   ├── telegram.ts                    # User alert formatters and command controllers
│   ├── users.ts                       # Account lifecycle, invites, and permission enforcement
│   └── x.ts                           # X API client, thread expansion, and rate tracking
├── data/
│   └── facts.json                     # Initial seed template for administrative setup
└── job-agent-build-spec-v3_2.md       # Complete system specification
```

---

## Telegram Command Reference

### User Commands

| Command | Description |
|---|---|
| `/start <code>` | Initializes an account using a one-time invite code. |
| `/agree` | Consents to the data privacy and Gmail access agreement. |
| `/connect` | Generates a single-use Google OAuth link to connect personal Gmail. |
| `/disconnect` | Revokes Google OAuth access and purges encrypted tokens. |
| `/status` | Displays daily send count, active cap, ramp stage, and queue status. |
| `/resumemode [mode]`| Toggles between `generated` and `uploaded` resume modes. |
| `/cap <N>` | Sets daily send target (bounded by admin-assigned ceiling). |
| `/reads <N>` | Sets maximum shared posts to evaluate per day. |
| `/window <H1> <H2>` | Sets permitted local delivery hours (e.g., `/window 9 17`). |
| `/timezone <tz>` | Configures local timezone (e.g., `Europe/London`, `America/New_York`). |
| `/dry [on\|off]` | Toggles dry-run mode (requires qualification conditions to disable). |
| `/pause` / `/resume` | Halts or resumes all outbound matching and sending. |
| `/accept` / `/reject` | Activates or discards proposed master facts parsed from an uploaded resume. |
| `/rollback` | Reverts to the previous accepted version of master facts. |
| `/set years <N>` | Manually updates years of professional experience. |
| `/set relocation yes\|no` | Configures openness to relocation in cover messages. |
| `/set gaps <list>` | Declares known experience gaps for honest framing. |
| `/resolve <id> <sent\|notsent>` | Manually settles an inconclusive send attempt. |
| `/done <id>` | Marks an external link/form application as completed. |
| `/import <emails>` | Ingests previously emailed contacts to prevent duplicate outreach. |
| `/delete_me` | Erases user facts, history, files, and revokes credentials. |
| *Send PDF/Word file* | Ingests a new resume document and prepares updated master facts. |
| *Paste Tweet URL* | Manually submits a specific job post on X for immediate ingestion. |

### Admin Commands

| Command | Description |
|---|---|
| `/invite` | Generates a single-use onboarding invite code. |
| `/users` | Lists registered candidates, Gmail statuses, ramp stages, and daily volume. |
| `/suspend <user>` | Immediately halts activity for a specific user. |
| `/limits <user> cap <N> reads <N>` | Sets individual hard ceilings on daily sends and post reviews. |
| `/admin xreads <N>` | Adjusts today's global X search budget limit. |
| `/admin threads <N>` | Adjusts the global daily limit for thread expansion queries. |
| `/admin ingest` | Manually triggers an immediate X search ingestion cycle. |
| `/admin pauseall` / `/admin resumeall` | Global emergency switch to suspend or restore all system sends. |

---

## Environment Variables

Create a `.env.local` file with the following variables:

```bash
# Database & Base URL
DATABASE_URL="postgres://username:password@ep-sample-pool.us-east-1.aws.neon.tech/neondb?sslmode=require"
APP_BASE_URL="https://your-domain.vercel.app"

# Security & Cron Authentication
CRON_SECRET="your-high-entropy-cron-secret-key"
TOKEN_ENCRYPTION_KEY="your-32-byte-base64-encryption-key" # generated via openssl rand -base64 32
TELEGRAM_WEBHOOK_SECRET="your-telegram-webhook-token"

# Telegram Bot
TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
ADMIN_CHAT_ID="987654321"

# Google Cloud OAuth (Web Application Credentials)
GMAIL_CLIENT_ID="your-client-id.apps.googleusercontent.com"
GMAIL_CLIENT_SECRET="your-client-secret"
GOOGLE_REDIRECT_URI="https://your-domain.vercel.app/api/oauth/gmail/callback"

# Google Gemini API
GEMINI_API_KEY="AIzaSyYourGeminiApiKey"
GEMINI_MODEL="gemini-1.5-flash"

# X (Twitter) API v2
X_BEARER_TOKEN="your-x-api-bearer-token"
X_MONTHLY_BUDGET_USD="20"
X_MAX_DAILY_READS="300"

# Storage & Quotas
MAX_USERS="20"
BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..."
```

---

## Setup & Deployment

### 1. Database Provisioning
Create a project on [Neon](https://neon.tech) and run the initialization schema found in the build specification:
```bash
psql $DATABASE_URL -f schema.sql
```

### 2. Google Cloud Platform Configuration
1. Create a Google Cloud project and enable the **Gmail API**.
2. Configure the OAuth Consent Screen:
   - User Type: **External**.
   - Publishing Status: **In Production** (prevents refresh tokens from expiring after 7 days).
   - Scopes: `https://www.googleapis.com/auth/gmail.send`, `https://www.googleapis.com/auth/gmail.readonly`, and `https://www.googleapis.com/auth/gmail.compose`.
3. Create an **OAuth 2.0 Web Client ID** with the authorized redirect URI:
   `https://<your-domain>/api/oauth/gmail/callback`

### 3. Telegram Bot Setup
1. Create a new bot via [@BotFather](https://t.me/BotFather) and obtain the `TELEGRAM_BOT_TOKEN`.
2. Register the webhook endpoint with your secret token:
   ```bash
   curl -F "url=https://<your-domain>/api/telegram" \
        -F "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
        https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook
   ```

### 4. External Scheduler Configuration
Because Vercel Cron on the Hobby tier is limited to once-daily runs, configure an external scheduler (such as [cron-job.org](https://cron-job.org) or [Upstash QStash](https://upstash.com/docs/qstash)) to invoke endpoints with the header `Authorization: Bearer <CRON_SECRET>`:

| Endpoint | Frequency | Purpose |
|---|---|---|
| `/api/cron/ingest` | Every 2 hours | Executes targeted X job queries |
| `/api/cron/process` | Every 10 minutes | Multimodal extraction, fit scoring, tailoring, verification |
| `/api/cron/send` | Every 10 minutes | Reconciles uncertain attempts; delivers authorized emails |
| `/api/cron/inbox` | Every 2 hours | Checks for bounces and inbound recruiter responses |
| `/api/cron/followups`| Once daily | Prepares follow-up drafts for unanswered applications |
| `/api/cron/summary` | Hourly | Evaluates candidate ramp status and sends daily digests |

---

## Ramp Schedule & Safety Controls

To safeguard candidate domain reputation and email deliverability, every user must follow a structured warm-up ramp:

| Stage | Daily Cap | Progression Criteria |
|---|---|---|
| **0 (Dry Run)** | 0 (Drafts only) | Mandatory initial state. Requires 5 reviewed drafts and explicit confirmation via `/dry off confirm`. |
| **Stage 1** | 3 sends/day | 3 consecutive days with zero bounces or delivery errors. |
| **Stage 2** | 5 sends/day | 3 consecutive days with bounce rate under 3%. |
| **Stage 3** | 10 sends/day | 4 consecutive days with bounce rate under 3% and zero policy warnings. |
| **Stage 4** | 15 sends/day | 4 consecutive days meeting Stage 3 criteria. |
| **Stage 5** | 20 sends/day | Steady-state maximum volume. |

### Automatic Pause Triggers
Sending is automatically suspended (`paused = true`) for a user if:
- **Bounce Rate**: Exceeds 5% over their last 20 sends.
- **Consecutive Failures**: 3 consecutive confirmed delivery rejections occur.
- **Uncertain Send**: Any attempt remains in `send_unknown` pending reconciliation.
- **Authentication Failure**: Gmail returns an authorization or invalid grant error.

---

## Contributing & Testing Guide

Before enabling live email dispatches, execute the required validation suites:

1. **Isolation Test**:
   Verify that user data is strictly isolated across tenants:
   ```bash
   npm test tests/isolation.test.ts
   ```
2. **Send Concurrency & Double-Send Prevention**:
   Simulate two parallel workers competing for a single remaining daily slot for the same Gmail account:
   ```bash
   npm test tests/concurrency.test.ts
   ```
3. **Stale Worker Lease Expiry Test**:
   Verify that a delayed worker whose lease expires cannot commit results or trigger sends after another worker reclaims the row:
   ```bash
   npm test tests/leases.test.ts
   ```
4. **Crash-After-Accept Simulation**:
   Simulate a worker crash after Gmail accepts a message, confirming that the reconciler identifies the message in Sent mail by `Message-ID` without re-sending.

---

## License

This project is licensed under the [MIT License](LICENSE).
