# Inbox scan and drafts

The inbox cron reads each user's bounce notices and the threads their applications started, classifies recruiter replies with Gemini, writes reply drafts, and alerts the user. The follow-up cron writes a follow-up draft 7 days after an unanswered send. The agent never sends any of these drafts; the user does, from Gmail.

## Rules

1. Gmail access is limited to bounce notices (`from:mailer-daemon OR from:postmaster newer_than:2d`), the threads of the user's own applications, and creating drafts.
2. Each inbound recruiter message is classified, drafted and alerted at most once. A later message in the same thread is handled as a new one.
3. Threads are checked in rotation (least recently checked first), ten per user per run.
4. A bounce notice marks one application: the latest one sent to that address before the notice arrived.
5. If classification fails, the user is still told a reply arrived.
6. A reply draft answers the recruiter's own Message-ID; a follow-up answers the original application's Message-ID, so both thread correctly in the recipient's mail client.
7. Follow-ups are drafted once per application, only for active users.
8. A Telegram message that Telegram rejects for its markup is resent as plain text.
9. If Gmail access was lost, the scan pauses the user and asks them to reconnect.

## Failure modes

| # | Failure | Before | Handling now | E2E scenario |
| --- | --- | --- | --- | --- |
| 1 | The same recruiter message on every scan | Messages were never marked handled. Unless the app moved to `replied`, every 2 hours brought another Gemini call and alert; out-of-office replies cost a Gemini call forever | The newest inbound message id is claimed before any side effect | Reply handled once |
| 2 | A recruiter writes again after the first reply | Only `sent` applications were scanned, so a second message was never seen | `replied` applications stay in rotation | Reply handled once; later message seen |
| 3 | More than ten sent applications | `limit 10` with no order scanned the same ten every run | Ordered by `thread_checked_at` | Threads in rotation |
| 4 | A bounce for an earlier send, then a new send to the same address | Every `sent` application whose address appeared in the notice was marked bounced, including the new one, which could also trip the bounce pause | Only the latest send before the notice | Bounce marks one application |
| 5 | Reply and follow-up drafts | `In-Reply-To` held the Gmail thread id, which is not a Message-ID, so recruiters saw a new conversation | The real Message-ID | Reply and follow-up scenarios check the header |
| 6 | Follow-ups for suspended users | Drafted into a suspended user's Gmail | Active users only | Follow-up scenario |
| 7 | An alert containing an unpaired `*` or `_` | Telegram rejected it with 400 and the alert was lost without trace | Resent as plain text; failures are logged | Reply scenario (the snippet has an unpaired `*`) |
| 8 | Gmail access revoked | Every scan failed silently in a log | `gmail_status = 'error'`, pause, reconnect request | Gmail access lost |
| 9 | Gemini fails on a reply | The scan for that user stopped and the reply went unannounced | The user is told a reply arrived | Not exercised |
| 10 | A failing user | Stayed first in the rotation forever | Moved to the back after every attempt | Not exercised |

## Known gaps

- Reply drafts are not checked by Dev A's truth verifier (the spec asks for it); they are drafts the user reviews, never sent.
- The spec's bounce retry to a second address needs alternate addresses from Dev A's extraction; a bounce ends at `bounced`.

## Proof the suite detects these bugs

Reintroduced and confirmed failing: handling the same message on every scan, blaming a later send for an old bounce, follow-ups for suspended users, and no plain-text fallback (checked on its own: the reply alert was lost).

## Running

These scenarios are in `e2e/inbox-and-drafts.e2e.mts` and run with the rest of the suite (`npm run build && npm run test:e2e`). Gemini is replaced by a fake via `GEMINI_API_BASE_URL`, which must stay unset in every real environment.
