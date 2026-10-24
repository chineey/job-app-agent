# Dev A: Intake & Tailoring Pipeline Specification

> **Branch:** `input-op-x`  
> **Role:** Dev A (Intake, Multimodal Intelligence, Gates, Matching, Tailoring, Verification, and Resume Parsing Engine)  
> **Target Release:** v3.2

---

## 1. Overview & Mission

Dev A is responsible for the **Intake and Tailoring Engine** of the Job Application Agent. This subsystem discovers software engineering job opportunities on X (Twitter), expands author threads, extracts structured role parameters using multimodal LLMs (Gemini Vision), executes adversarial security and quality gates, fans out opportunities to eligible candidates, scores fit, tailors honest ATS-compliant application packages, audits them against candidate master facts, and renders one-page resume PDFs.

The pipeline stops at **`status = 'verified'`** (or routing link posts to manual notifications). Once verified, the application is handed off to **Dev B** (Platform, Telegram Bot, OAuth & Gmail Delivery) for delivery and lifecycle management.

```text
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │                              DEV A: INTAKE & TAILORING PIPELINE                        │
 └────────────────────────────────────────────────────────────────────────────────────────┘

  X Search (Shared, Budget-Capped)        Manual Ingest (Single Post URL)
                 │                                        │
                 ▼                                        ▼
      [ 1. Post Ingestion ] ────────────────────► jobs (status = 'found')
                 │
                 ▼
      [ 2. Thread Expansion ] ──► Expand original author replies; fetch text & image attachments
                 │
                 ▼
      [ 3. Multimodal Extraction ] ──► Gemini 1.5 Flash: Vision + Text -> Structured JSON
                 │
                 ▼
      [ 4. Shared Gates (Round 1) ] ──► Regex email check, DNS MX check, scam detector, dedupe
                 │
                 ▼
      [ 5. Candidate Fan-Out ] ──► 30-day contact dedupe, review budgets -> applications (status = 'queued')
                 │
                 ▼
      [ 6. Fit Scoring & Match ] ──► Gemini 0–100 candidate fit score vs Master Facts JSON
                 │
                 ▼
      [ 7. Application Tailoring ] ──► Bullet selection, ATS summary, honest email cover copy
                 │
                 ▼
      [ 8. Truth Verification Pass ] ──► Adversarial audit: catches any hallucinated skill/experience
                 │
                 ▼
      [ 9. PDF Resume Rendering ] ──► @react-pdf/renderer: ATS 1-page PDF, locked candidate fields
                 │
                 ▼
    applications (status = 'verified')
                 │
                 └───────────────────────────────► [ Handoff to Dev B: Delivery & Telegram ]
```

---

## 2. Dev A vs Dev B Boundary Map

| Feature / Responsibility | Owner | Dev A Ownership Detail |
| :--- | :---: | :--- |
| **X Ingestion & Rate Caps** | **Dev A** | Searches X v2 API, respects `$20/mo` and `300 reads/day` caps, stores raw tweets in `jobs`. |
| **Thread Expansion** | **Dev A** | Gathers follow-up tweets from original author to find contact emails and apply links. |
| **Gemini Multimodal Vision** | **Dev A** | Extracts job metadata, transcribes job flyers/images, parses requirements into JSON. |
| **Shared Gates (Round 1)** | **Dev A** | Enforces scam heuristics, valid regex email format, active DNS MX records, and post deduplication. |
| **User Fan-Out** | **Dev A** | Distributes valid jobs to active users, enforcing 30-day email dedupe and daily read caps. |
| **Fit Scoring & Matching** | **Dev A** | Evaluates candidate skills vs job requirements (0–100) and flags technical gaps. |
| **Application Tailoring** | **Dev A** | Selects best projects/bullets from user bank; drafts honest, punchy email body. |
| **Truthfulness Verification** | **Dev A** | Adversarial second-pass audit against master facts; blocks unverified claims. |
| **PDF Resume Renderer** | **Dev A** | Generates 1-page ATS PDF with hard-locked identity fields, uploads to Vercel Blob. |
| **Resume Parsing Utility** | **Dev A** | Validates PDF/DOCX safety (magic bytes, size, no JS) and parses text into `MasterFacts` schema. |
| **Telegram Bot & Commands** | Dev B | Telegram webhook, user registration, `/start`, `/reads`, `/cap`, `/pause`, `/dry`, admin commands. |
| **User Onboarding & Invites** | Dev B | Manages user table, invite codes, TOS agreement (`/agree`), master facts versioning acceptance. |
| **Gmail OAuth & Delivery** | Dev B | Gmail token management, AES-256 encryption, serialized `send_state` locks, `users.messages.send`. |
| **Reconciliation & Inbound** | Dev B | RFC Message-ID reconciliation, bounce scanner, inbound reply and follow-up drafts. |

---

## 3. Detailed Component Architecture

### 3.1. X Ingestion & Read Limits ([`lib/x.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/x.ts))
- **Route:** `GET /api/cron/ingest` (runs every 15–30 minutes).
- **Search Query:** Targets high-intent engineering hiring phrases: `("hiring" OR "we are hiring" OR "send your CV" OR "apply via email") (developer OR engineer OR "full stack" OR backend OR frontend OR "software") -is:retweet -is:reply lang:en`.
- **Pre-Filter:** Discards text posts lacking basic apply keywords while preserving all image-bearing tweets for vision inspection.
- **Spend & Cap Accounting:**
  - Queries `global_spend` table before calling X API.
  - Hard caps: `$20/month` maximum (~4,000 reads/mo) and `300 reads/day`.
  - Increments usage atomically; skips ingest if limits are reached.
- **Idempotency:** Tracks `since_id` using the latest `post_id` in `jobs`. Inserts with `ON CONFLICT (post_id) DO NOTHING`.

### 3.2. Author-Only Thread Expansion ([`lib/x.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/x.ts))
- Often posters place the apply link or email in a follow-up reply in the thread.
- **Rules:**
  - Traverses `conversation_id` on X API v2.
  - **Strict Author Filter:** Only retains replies written by the original poster (`author_id == tweet.author_id`). Drops all third-party spam and replies.
  - Limits expansion to 5 tweets and caps spend.
  - Concatenates thread text into `thread_text` and appends all thread images to `media_urls`.

### 3.3. Multimodal Extraction with Vision ([`lib/gemini.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/gemini.ts))
- **Model:** `gemini-1.5-flash` with structured JSON output and temperature `0.1`.
- **Inputs:** Combined tweet text, expanded thread text, and up to 4 image URLs fetched and converted into base64 `Part` objects.
- **Security Rule (Prompt Injection Defense):** All post content and images are treated as UNTRUSTED data. The prompt explicitly instructs Gemini to ignore embedded instructions.
- **Outputs:** Validated via `JobExtractSchema` (Zod):
  - `is_job`: boolean
  - `is_software_role`: boolean
  - `role`, `company`, `location`, `remote`, `relocation_required`, `visa_sponsorship`
  - `min_years`, `salary`, `deadline`
  - `requirements`: string array
  - `apply_method`: `'email' | 'form' | 'dm' | 'link' | 'unknown'`
  - `scam_risk`: `'low' | 'medium' | 'high'`, `scam_reasons`: string array
  - `transcribed_text`: Raw OCR text from image flyers.

### 3.4. Shared Gates (Round 1) ([`lib/gates.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/gates.ts))
Code-level gate enforcement before user fan-out:
1. **Role & Intent Gate:** Must have `is_job === true` and `is_software_role === true`.
2. **Scam Risk Gate:** Must have `scam_risk === 'low'`. Rejects upfront fees, crypto tasks, WhatsApp/Telegram redirects, or personal ID requests.
3. **Contact Email Verification (For Email Route):**
   - Address extracted via strict regex.
   - Address checked against disposable/scam provider blocklists.
   - **DNS MX Check:** Validates that recipient email domain has active DNS MX records.
4. **Global Deduplication:** Computes normalized SHA-256 hash across `(company, role, contact_email, apply_link_domain)`. Drops duplicate listings posted within 30 days.

### 3.5. Fan-Out Engine ([`lib/fanout.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/fanout.ts))
- Translates verified `jobs` into per-user `applications`.
- Selects active, unpaused users who haven't exceeded their `daily_read_cap`.
- **Per-User 30-Day Contact Deduplication:** If the job has a `contact_email`, checks `applications` table to ensure candidate has not applied to or been queued for that email in the past 30 days.
- Shuffles eligible candidates and inserts up to `max_applications_per_job` with status `'queued'`.

### 3.6. Candidate Fit Scoring & Match ([`lib/gemini.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/gemini.ts))
- Compares job requirements against the candidate's active `MasterFacts`.
- Computes `fit_score` (0–100) based strictly on tech stack overlap.
- Identifies concrete `gaps` and sets `years_gap = true` if job `min_years` exceeds candidate's experience.
- Persists result and advances application to `'matched'`.

### 3.7. Application Tailoring ([`lib/gemini.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/gemini.ts))
- **Two Resume Modes:**
  - `generated`: Gemini selects the most relevant project IDs and existing bullet IDs from the candidate's verified bank. **It does NOT rewrite bullets in v1** (eliminating hallucination).
  - `uploaded`: Uses the candidate's own uploaded static PDF; LLM only tailors the email copy.
- **Email Slots:**
  - `subject`: Standard professional subject line.
  - `opening_line`: Tailored role and company reference.
  - `project_fit_sentences`: 1–2 sentences highlighting matching projects.
  - `gap_sentence`: Honest acknowledgement of technical gaps using candidate's preset gap framing.
  - `cover_note`: Short suggested cover note for `link` / `form` applications.

### 3.8. Truthfulness Verification Audit ([`lib/gemini.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/gemini.ts))
- **Adversarial Second LLM Pass:** A separate prompt acting as a strict auditor compares the tailored email copy against the candidate's `MasterFacts`.
- **Strict Verification Rules:**
  - Rejects any claim of experience greater than `facts.years_experience`.
  - Rejects any technical skill not in `facts.skills.strong` or `facts.skills.working`.
  - Rejects any claim asserting visa sponsorship eligibility or work authorization.
  - Rejects any metric not grounded in the candidate's project/experience bank.
- **Gate Outcome:**
  - If `supported === true`: advances to PDF generation.
  - If `supported === false`: sets application status to `'blocked_truth'` with `unsupported_claims` recorded in DB for audit.

### 3.9. ATS PDF Resume Renderer ([`lib/pdf/Resume.tsx`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/pdf/Resume.tsx))
- Built with `@react-pdf/renderer` rendering an ATS-optimized, single-page PDF.
- **Hard-Locked Candidate Fields:**
  - Candidate Name, Email, Phone, Location, GitHub, LinkedIn, Portfolio.
  - Education (degrees, schools, dates) and Certifications.
  - Employer names, titles, and dates of employment.
  *(These fields are injected directly from verified code/data and cannot be altered by the LLM).*
- **Tailored Dynamic Content:**
  - Summary sentence tailored to role.
  - Selected project entries and prioritized bullet points.
  - Re-ordered skill list reflecting job relevance.
- **Storage:** Rendered PDF buffer is uploaded to `@vercel/blob` and stored in `applications.resume_blob_url`.

### 3.10. Resume Parsing & Master Facts ([`lib/parse-resume.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/parse-resume.ts), [`lib/facts.ts`](file:///c:/Users/HP/Documents/Projects/job_app_agent/lib/facts.ts))
- **Pre-Upload PDF Validation:**
  - Magic byte check: `%PDF-`.
  - Max size: `5 MB`.
  - Max page length: `3 pages`.
  - Active content scan: Rejects PDFs with `/JavaScript`, `/Launch`, or embedded scripts.
  - Text layer check: Ensures text is selectable (rejects scanned image PDFs).
- **DOCX Validation:** Parsed via `mammoth` with raw text extraction.
- **LLM Fact Extraction:** Extracts structured `MasterFacts` schema from raw resume text.
- **Fact Versioning & Diffing:** Carries over non-inferable attributes (`years_experience`, `open_to_relocation`, `gap_framing`) from previous active versions and computes human-readable diffs for user acceptance.

---

## 4. Database Schema Interaction (Dev A)

Dev A reads and writes to the following primary tables in Postgres (Neon):

| Table | Dev A Access | Purpose |
| :--- | :---: | :--- |
| `jobs` | **Read / Write** | Inserts newly discovered posts (`found`), updates extracted details, gates, and statuses (`extracted`, `rejected`). |
| `applications` | **Read / Write** | Creates queued rows during fan-out; updates `fit_score`, `email_body`, `resume_blob_url`, and transitions to `verified` or `blocked_truth`. |
| `facts_versions` | **Read** | Reads active candidate facts (`status = 'active'`) for matching, tailoring, and verification. |
| `user_settings` | **Read** | Checks `paused` status and candidate preferences. |
| `global_settings` | **Read** | Checks `max_applications_per_job` and system limits. |
| `global_spend` | **Read / Write** | Records X read usage and Gemini token costs to enforce budget ceilings. |
| `user_spend` | **Read / Write** | Tracks daily job reviews per candidate against their `daily_read_cap`. |
| `events` | **Write** | Logs immutable audit records for extraction, gate rejections, and truth block events. |

---

## 5. Environment Variables for Dev A

Dev A only requires variables relating to the intake pipeline, Gemini, X API, storage, and database:

```env
# Database & Core
DATABASE_URL="postgres://username:password@ep-sample-pool.us-east-1.aws.neon.tech/neondb?sslmode=require"
APP_BASE_URL="http://localhost:3000"

# Cron Security
CRON_SECRET="dev-cron-secret-change-in-production"

# Google Gemini API
GEMINI_API_KEY="AIzaSy..."
GEMINI_MODEL="gemini-1.5-flash"

# X (Twitter) API v2
X_BEARER_TOKEN="your-x-api-bearer-token"
X_MONTHLY_BUDGET_USD="20"
X_MAX_DAILY_READS="300"

# PDF Storage
BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..."
```

> [!NOTE]
> Telegram keys (`TELEGRAM_BOT_TOKEN`, `ADMIN_CHAT_ID`) and Google OAuth keys (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`) belong strictly to **Dev B** and are not needed for Dev A tasks.

---

## 6. How to Develop & Test Dev A Locally

### 6.1. Running the Test Suite
The project uses `vitest`. Dev A unit tests cover shared gates, facts validation, diffing, and PDF rendering:

```bash
# Run all Dev A tests
npm test

# Run tests in watch mode
npx vitest
```

### 6.2. Triggering Local Cron Pipelines
With local server running (`npm run dev`):

```bash
# 1. Trigger X Ingestion
curl -X GET http://localhost:3000/api/cron/ingest \
  -H "Authorization: Bearer dev-cron-secret-change-in-production"

# 2. Trigger Extraction, Matching, Tailoring & Verification
curl -X GET http://localhost:3000/api/cron/process \
  -H "Authorization: Bearer dev-cron-secret-change-in-production"
```

### 6.3. Verifying Types & Compiling
```bash
# Verify complete TypeScript type-safety
npx tsc --noEmit
```
