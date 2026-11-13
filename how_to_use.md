# How to Use the Job App Agent

This guide explains in plain English how to run the app on your computer, how to run it after you deploy it online, and how to use it on Telegram.

---

## 1. Running Locally from Your Terminal

You only need two terminal windows to run everything on your computer.

### First-time setup
1. Install the packages:
   ```bash
   npm install
   ```
2. Make sure your `.env` file has your keys filled in (`DATABASE_URL`, `GEMINI_API_KEY`, `X_BEARER_TOKEN`, `TELEGRAM_BOT_TOKEN`, `CRON_SECRET`, `TOKEN_ENCRYPTION_KEY`, and your Google Gmail OAuth keys). Leave `BLOB_READ_WRITE_TOKEN=""` empty to store PDFs in Neon Postgres.
3. If you haven't created the database tables yet, run `schema.sql` in your Neon SQL Editor (or with `psql "$DATABASE_URL" -f schema.sql`).

### Start the app (2 terminals)
- **Terminal 1 — Start the server:**
  ```bash
  npm run dev
  ```
  Wait until you see `Ready`. Keep this window open.

- **Terminal 2 — Connect the Telegram bot:**
  ```bash
  npm run bot
  ```
  This listens for your Telegram messages and sends them to your local server. Keep this window open too.

### Optional terminal commands
- **Run a full job search + tailor + send pass right now:**
  ```bash
  npm run pipeline
  ```
- **Run the tests:**
  ```bash
  npm test
  ```

> **Important:** `npm run bot` turns off any live Telegram webhook so your computer can receive messages. When you switch back to your deployed site, re-enable the webhook (see below) and stop `npm run bot`.

---

## 2. Running After You Deploy (Vercel + Neon)

Once your app is deployed (for example, `https://your-app.vercel.app`), do these 4 things once:

### 1. Add your environment variables
In your hosting dashboard (e.g., **Vercel → Project → Settings → Environment Variables**), add the same keys from your `.env` file, but update these two to your live URL:
- `APP_BASE_URL` = `https://your-app.vercel.app`
- `GOOGLE_REDIRECT_URI` = `https://your-app.vercel.app/api/oauth/gmail/callback`
- Leave `BLOB_READ_WRITE_TOKEN` empty (or unset) to keep storing PDFs in Neon Postgres.

### 2. Update Google Cloud Console
In Google Cloud Console → **APIs & Services → Credentials** → your OAuth Client:
- Add `https://your-app.vercel.app/api/oauth/gmail/callback` under **Authorized redirect URIs**.
- Make sure any user who wants to connect Gmail is added under **OAuth consent screen → Test users** (unless your Google app is published).

### 3. Point Telegram to your live site
Run this once in your terminal (replace the `<...>` parts with your values):
```bash
curl -F "url=https://your-app.vercel.app/api/telegram" \
     -F "secret_token=<YOUR_TELEGRAM_WEBHOOK_SECRET>" \
     https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook
```
Make sure `npm run bot` is stopped on your computer.

### 4. Set up automatic schedules (Cron Jobs)
Use a free scheduler like **cron-job.org** or **Upstash QStash** to call these `GET` URLs automatically. Every request must include the header:
`Authorization: Bearer <YOUR_CRON_SECRET>`

| URL | How often | What it does |
|---|---|---|
| `https://your-app.vercel.app/api/cron/ingest` | Every 2 hours | Finds new tech jobs on X |
| `https://your-app.vercel.app/api/cron/process` | Every 10 minutes | Reads jobs, scores fit, writes resumes & emails |
| `https://your-app.vercel.app/api/cron/send` | Every 10 minutes | Sends approved emails & Telegram job cards |
| `https://your-app.vercel.app/api/cron/inbox` | Every 2 hours | Checks Gmail for bounces & recruiter replies |
| `https://your-app.vercel.app/api/cron/followups` | Once a day | Creates follow-up drafts after 7 days |
| `https://your-app.vercel.app/api/cron/summary` | Every hour | Sends your daily summary & updates daily limits |

---

## 3. Using the Bot on Telegram

### Getting started (first time)
1. **Contact the dev/admin before you start:**
   - Ask them to **add your Gmail address as a Test User** in Google Cloud (if they don't do this first, connecting your Gmail will fail with an `Access blocked` error).
   - Ask them for a **one-time invite code** (if you are the admin yourself, send `/invite` to the bot to generate one).
2. **Join the bot:** Open the bot on Telegram and send:
   `/start <invite-code>`
3. **Accept the privacy notice:** Send `/agree`
4. **Upload your resume:** Send your PDF or Word (`.docx`) resume file directly in the Telegram chat (under 5 MB). Wait for the bot to reply with the details it extracted.
5. **Confirm your years of experience:** Send `/set years <number>` (for example, `/set years 3`).
6. *(Optional)* **Set relocation & gaps:**
   - `/set relocation yes` or `/set relocation no`
   - `/set gaps <skills>` (for example, `/set gaps Go, Kubernetes`)
7. **Save your profile:** Send `/accept` (the bot will not match you to jobs until you accept).
8. **Connect your Gmail:** Send `/connect`, open the Google link the bot sends you, sign in with the Gmail address that was added as a Test User, and approve access.
9. **Set your timezone & sending hours:**
   - `/timezone <your-zone>` (for example, `/timezone Africa/Lagos` or `/timezone America/New_York`)
   - `/window 9 17` (sets the hours emails are allowed to go out, 9 AM to 5 PM)
10. **Practice mode (Dry Run) first:** New accounts start in practice mode so no real emails are sent. After you review at least 5 dry-run previews and are happy with them, turn on real sending with `/dry off confirm`.

### Applying to jobs
- **Paste any X (Twitter) job link** directly into the chat. The bot will read the post (and the author's replies), check your fit, tailor a resume + email (or cover note), and either:
  - Send a **dry-run preview** (while practice mode is on),
  - Send a **real email** from your Gmail (once live), or
  - Send you a **link card + PDF** if the job uses an external application form (reply `/done <id>` after you apply).

### Everyday commands
| Command | What it does |
|---|---|
| `/status` | Shows how many jobs are queued or sent today |
| `/run` | Runs a send pass right now |
| `/dry on` / `/dry off confirm` | Turns practice mode on or off (no real emails are sent while ON) |
| `/pause` / `/resume` | Pauses or restarts sending |
| `/cap <number>` | Sets your max emails per day |
| `/window <start> <end>` | Sets sending hours (example: `/window 9 17`) |
| `/timezone <zone>` | Sets your timezone (example: `/timezone Africa/Lagos`) |
| `/resumemode` | Switch between AI-tailored PDF (`generated`) or your original file (`uploaded`) |
| `/done <id>` | Marks a manual-link job as applied |
| `/disconnect` | Unlinks your Gmail |
