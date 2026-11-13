# Setup Guide: Candidate Onboarding & System Configuration

This guide details the complete end-to-end setup process for administrators and candidates using the **X Job Application Agent (v3.2)**. It covers Google Cloud OAuth configuration, adding candidate Gmail accounts to the **Google Cloud Test Users** list, Telegram onboarding, resume ingestion, and account graduation.

---

## Table of Contents

1. [Prerequisites & System Architecture](#prerequisites--system-architecture)
2. [Google Cloud Console Setup (OAuth 2.0)](#google-cloud-console-setup-oauth-20)
   - [Enabling the Gmail API](#enabling-the-gmail-api)
   - [Configuring the OAuth Consent Screen](#configuring-the-oauth-consent-screen)
   - [CRITICAL STEP: Adding Gmail Addresses to the Test Users List](#critical-step-adding-gmail-addresses-to-the-test-users-list)
   - [Creating OAuth 2.0 Credentials](#creating-oauth-20-credentials)
3. [Environment Configuration (`.env`)](#environment-configuration-env)
4. [Step-by-Step Candidate Onboarding Walkthrough](#step-by-step-candidate-onboarding-walkthrough)
   - [Step 1: Admin Generates an Invite Code](#step-1-admin-generates-an-invite-code)
   - [Step 2: Admin Whitelists Candidate's Gmail](#step-2-admin-whitelists-candidates-gmail)
   - [Step 3: Candidate Joins via Telegram (`/start`)](#step-3-candidate-joins-via-telegram-start)
   - [Step 4: Candidate Accepts Terms (`/agree`)](#step-4-candidate-accepts-terms-agree)
   - [Step 5: Candidate Uploads Resume Document](#step-5-candidate-uploads-resume-document)
   - [Step 6: Reviewing & Locking Master Facts (`/accept`)](#step-6-reviewing--locking-master-facts-accept)
   - [Step 7: Connecting Gmail via OAuth (`/connect`)](#step-7-connecting-gmail-via-oauth-connect)
   - [Step 8: Configuring Send Window & Preferences](#step-8-configuring-send-window--preferences)
5. [Dry-Run Testing & Going Live](#dry-run-testing--going-live)
   - [Mandatory Dry-Run Safeguards](#mandatory-dry-run-safeguards)
   - [Exiting Dry-Run (`/dry off confirm`)](#exiting-dry-run-dry-off-confirm)
6. [Troubleshooting & FAQs](#troubleshooting--faqs)

---

## Prerequisites & System Architecture

Each candidate in the Job Application Agent sends applications directly through their personal Gmail account. To achieve this safely without exposing passwords:

- The system uses **Google OAuth 2.0** with offline refresh tokens.
- All stored refresh tokens are strongly encrypted using **AES-256-GCM** via `TOKEN_ENCRYPTION_KEY`.
- The bot interacts with users exclusively through **Telegram**.
- Job matches are verified against candidate-approved **Master Facts** to guarantee zero LLM hallucination of qualifications, dates, or employers.

---

## Google Cloud Console Setup (OAuth 2.0)

Because this agent operates for a private group (up to 20 candidates) using sensitive Gmail scopes (`gmail.send`, `gmail.readonly`, `gmail.compose`), the Google Cloud Project remains in **Testing** publishing status. This avoids lengthy Google app verification and security assessments, but requires **every candidate's Gmail address to be explicitly whitelisted as a Test User**.

### Enabling the Gmail API

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g., `Job-App-Agent`) or select your existing project.
3. Open the navigation menu and go to **APIs & Services** > **Library**.
4. Search for **Gmail API**.
5. Click **Enable**.

### Configuring the OAuth Consent Screen

1. In the left sidebar, navigate to **APIs & Services** > **OAuth consent screen**.
2. Select User Type:
   - Choose **External** (unless you have a Google Workspace organization and all candidates share that workspace domain).
   - Click **Create**.
3. Fill in the required App Information:
   - **App name**: `Job Application Agent`
   - **User support email**: Your admin email address.
   - **Developer contact information**: Your admin email address.
   - Click **Save and Continue**.
4. **Scopes**:
   - Click **Add or Remove Scopes**.
   - Add the following three Gmail scopes:
     - `https://www.googleapis.com/auth/gmail.send` (Send emails on user's behalf)
     - `https://www.googleapis.com/auth/gmail.readonly` (Read bounces and recruiter responses)
     - `https://www.googleapis.com/auth/gmail.compose` (Create follow-up and recruiter reply drafts)
   - Click **Update** and then **Save and Continue**.

---

### CRITICAL STEP: Adding Gmail Addresses to the Test Users List

> [!IMPORTANT]
> **Why this is mandatory:**
> When a Google Cloud OAuth app is in "Testing" mode, **only users added to the Test Users list can authorize the app**.
> If a candidate attempts to run `/connect` without being on this list, Google immediately blocks them with:
> `Error 403: access_denied - Access blocked: [App Name] has not completed the Google verification process`.

#### How to Add a Candidate's Gmail:
1. In Google Cloud Console, navigate to **APIs & Services** > **OAuth consent screen**.
2. Scroll down to the **Test users** section (or click **Test users** in the tab bar).
3. Click **+ ADD USERS**.
4. Enter the candidate's exact Gmail address (e.g., `candidate.name@gmail.com` or their Google Workspace email).
5. Click **Save**.
6. The email will now appear under **User email**. You can add up to 100 test accounts.

> Repeat this step for **every new candidate** before they authenticate.

---

### Creating OAuth 2.0 Credentials

1. Go to **APIs & Services** > **Credentials**.
2. Click **+ CREATE CREDENTIALS** > **OAuth client ID**.
3. Set **Application type** to **Web application**.
4. Set **Name** to `Job App Agent Server`.
5. Under **Authorized redirect URIs**, click **+ ADD URI**:
   - For local development: `http://localhost:3000/api/oauth/gmail/callback`
   - For production / Vercel: `https://your-domain.vercel.app/api/oauth/gmail/callback`
6. Click **Create**.
7. Copy the **Client ID** and **Client Secret**. Add them to your `.env` file:
   ```env
   GMAIL_CLIENT_ID="xxxx-xxxx.apps.googleusercontent.com"
   GMAIL_CLIENT_SECRET="GOCSPX-xxxx"
   GOOGLE_REDIRECT_URI="http://localhost:3000/api/oauth/gmail/callback"
   ```

---

## Environment Configuration (`.env`)

Ensure the following variables are defined in your `.env` (or `.env.local`):

```bash
# ==============================================================================
# DATABASE & APPLICATION BASE
# ==============================================================================
DATABASE_URL="postgres://username:password@ep-sample-pool.us-east-1.aws.neon.tech/neondb?sslmode=require"
APP_BASE_URL="http://localhost:3000"

# ==============================================================================
# SECURITY KEYS
# ==============================================================================
CRON_SECRET="dev-cron-secret-change-in-production"
# Generate a 32-byte base64 key with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
TOKEN_ENCRYPTION_KEY="your-32-byte-base64-encryption-key-here"

# ==============================================================================
# TELEGRAM BOT CONFIGURATION
# ==============================================================================
TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
TELEGRAM_WEBHOOK_SECRET="your-telegram-webhook-secret"
ADMIN_CHAT_ID="123456789" # Your personal Telegram chat ID
MAX_USERS="20"

# ==============================================================================
# GOOGLE CLOUD OAUTH (GMAIL)
# ==============================================================================
GMAIL_CLIENT_ID="your-client-id.apps.googleusercontent.com"
GMAIL_CLIENT_SECRET="your-client-secret"
GOOGLE_REDIRECT_URI="http://localhost:3000/api/oauth/gmail/callback"

# ==============================================================================
# AI & SEARCH APIS
# ==============================================================================
GEMINI_API_KEY="AIzaSyYourGeminiApiKey"
GEMINI_MODEL="gemini-1.5-flash"
X_BEARER_TOKEN="your-x-api-bearer-token"
X_MONTHLY_BUDGET_USD="20"
X_MAX_DAILY_READS="300"

# Vercel Blob (Optional for PDF artifact storage)
BLOB_READ_WRITE_TOKEN="vercel_blob_rw_token_here"
```

---

## Step-by-Step Candidate Onboarding Walkthrough

### Step 1: Admin Generates an Invite Code
In Telegram, the Admin sends:
```text
/invite
```
The bot responds with an 8-character single-use invite code (e.g., `8F3A2B1C`).

---

### Step 2: Admin Whitelists Candidate's Gmail
Before or immediately after sharing the invite code with the candidate:
1. Ask the candidate for the Gmail address they wish to send applications from.
2. In Google Cloud Console, open **OAuth consent screen** > **Test users**.
3. Add their Gmail address to the list and save.

---

### Step 3: Candidate Joins via Telegram (`/start`)
The candidate opens the bot on Telegram and sends:
```text
/start 8F3A2B1C
```
The bot initializes the candidate's account in `pending` status and sends the Privacy & Security Notice.

---

### Step 4: Candidate Accepts Terms (`/agree`)
The candidate reviews the permissions and types:
```text
/agree
```
The bot activates the account in safe **Dry-Run Mode** with default settings:
- Initial Cap: 3 sends/day
- Dry Run: `ON`
- Window: 9:00 - 17:00 UTC
- Resume Mode: `generated` (ATS 1-page PDF)

---

### Step 5: Candidate Uploads Resume Document
The candidate sends their current resume as a `.pdf` or `.docx` file attachment into the Telegram chat.

1. The bot downloads and validates the document:
   - Max 2 pages (for 1-page generation).
   - Validates that text is selectable (not a scanned image or encrypted PDF).
2. Gemini parses the resume into a structured **Master Facts** profile:
   - Full identity (Name, Email, Phone, LinkedIn, GitHub).
   - Professional experience & employment dates.
   - Projects and verified technical skills.
   - Identified gaps or unlisted attributes.

---

### Step 6: Reviewing & Locking Master Facts (`/accept`)
The bot prints a summary of the extracted profile and prompts the candidate to set key attributes:

1. **Set Professional Years of Experience** *(Mandatory before acceptance)*:
   ```text
   /set years 4
   ```
2. *(Optional)* **Set Openness to Relocation**:
   ```text
   /set relocation yes
   ```
3. *(Optional)* **Set Specific Gap Framing**:
   ```text
   /set framing Currently deepening Rust systems programming skills alongside 4 years of TypeScript experience.
   ```
4. **Approve Profile**:
   ```text
   /accept
   ```
   This locks the profile as the candidate's **Active Master Facts**. All subsequent job matching and resume tailoring will strictly audit against these verified facts.

---

### Step 7: Connecting Gmail via OAuth (`/connect`)
The candidate types:
```text
/connect
```
1. The bot returns a secure, 10-minute time-limited link:
   `http://localhost:3000/api/oauth/gmail/start?state=<unique-token>`
2. The candidate clicks or opens this link in their browser.
3. They sign into their whitelisted Gmail account.
4. Google displays the permissions request (`Send email`, `View emails/bounces`, `Create drafts`).
5. The candidate clicks **Allow**.
6. The callback securely stores the AES-256 encrypted refresh token in Neon Postgres and sends a confirmation message to Telegram:
   > *🎉 Gmail Connected Successfully! (connected as: candidate@gmail.com)*

---

### Step 8: Configuring Send Window & Preferences
Candidates can customize their operating parameters:

- **Local Timezone**:
  ```text
  /timezone Africa/Lagos
  ```
  *(or `America/New_York`, `Europe/London`, etc.)*

- **Permitted Send Hours**:
  ```text
  /window 9 17
  ```
  *(Emails will only dispatch between 09:00 and 17:00 local time on weekdays)*

- **Resume Generation Mode**:
  - `generated` *(default)*: Generates a tailored 1-page ATS PDF per role.
  - `uploaded`: Attaches the original uploaded PDF unchanged; tailors only email text.
  ```text
  /resumemode generated
  ```

---

## Dry-Run Testing & Going Live

### Mandatory Dry-Run Safeguards
Every newly registered candidate begins with **`dry_run = true`**. In this mode:
- No real emails are sent through Gmail.
- Whenever an email match occurs, the candidate receives a **Dry-Run Preview Card** on Telegram containing:
  - Role, Company, Location, Match Score (0-100).
  - Identified requirement gaps.
  - Recipient email and subject line.
  - Full tailored email body copy.
  - The generated tailored PDF resume attached.
- For external form applications (link posts), the candidate receives a card with the apply link and tailored cover note to apply manually.

### Exiting Dry-Run (`/dry off confirm`)

To protect email deliverability and avoid accidental sends, the system enforces **strict graduation prerequisites**:

1. Gmail must be actively connected (`user.gmail_status === 'connected'`).
2. Master Facts must be accepted (`/accept`).
3. Experience years must be specified (`/set years <N>`).
4. The candidate must have reviewed at least **5 dry-run drafts** (`dry_run_drafts_shown >= 5`).

Once all 4 conditions are met, the candidate graduates to live sending with:
```text
/dry off confirm
```

The user is placed into **Ramp Stage 1** (safe starting limit of 3 emails/day). The system automatically upgrades their daily send cap (up to 20/day) as bounce rates and delivery safety metrics remain clean over subsequent days.

---

## Troubleshooting & FAQs

### 1. `Error 403: access_denied` during `/connect`
- **Cause**: The candidate's Gmail address was not added to the **Test users** list in Google Cloud Console.
- **Fix**: Open Google Cloud Console > **OAuth consent screen** > **Test users**, click **Add Users**, type the candidate's exact Gmail address, and click **Save**. Have the candidate type `/connect` again.

### 2. "Google skipped returning a refresh token"
- **Cause**: Google only provides a `refresh_token` on the first authorization. If the user previously authorized the app and connects again, Google only issues a short-lived access token.
- **Fix**: The candidate must visit [Google Account Third-Party Access](https://myaccount.google.com/connections), remove access for **Job Application Agent**, and then type `/connect` again in Telegram.

### 3. "System user capacity reached (20 users)"
- **Cause**: The total number of active users has reached the configured `MAX_USERS` limit in `.env`.
- **Fix**: Increase `MAX_USERS` in `.env` or delete inactive accounts using `/delete_me` or `/suspend`.

### 4. Candidate's resume upload is rejected
- **Cause**: The PDF has more than 2 pages, is password protected, or is a scanned image without selectable text.
- **Fix**: Export the resume directly from Word or Google Docs as a clean, selectable PDF or `.docx` file with 1–2 pages maximum.

---

*(For full terminal instructions and a complete reference of all Telegram commands, see [how_to_use.md](file:///c:/Users/HP/Documents/Projects/job_app_agent/how_to_use.md))*
