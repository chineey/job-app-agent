# Link applications

When a job asks applicants to use a link or form, the agent never opens or fills it. Dev A's pipeline tailors the resume and a cover note and sets the application to `link_ready`; Dev B sends the user a card, and the user applies themselves and reports it with `/done`.

## Rules

1. Each `link_ready` application of an active, unpaused user gets one card. The send cron sends cards every 10 minutes. A card Telegram refuses is retried on the next run.
2. The card shows the apply link's domain on its own line, so a lookalike domain is easy to spot.
3. The resume is sent as its own document, not as the card's caption, which Telegram limits to 1024 characters.
4. One reminder goes out when the deadline is under 48 hours away, if the card was sent before that window. A card sent inside it is already marked urgent.
5. `/done <id>` only changes the user's own application, and only while it is `link_ready`.
6. `/links` lists the user's waiting link applications, soonest deadline first.

## Failure modes

| # | Failure | Before | Handling now | E2E scenario |
| --- | --- | --- | --- | --- |
| 1 | A job applies by link | Nothing sent `link_ready` applications to users; they waited forever | The send cron dispatches cards | Card sent once |
| 2 | A long card with a resume | The card was the PDF's caption; over 1024 characters Telegram rejected it and the card was lost | Card and resume sent separately | Card sent once (900-character cover note) |
| 3 | `/done` on another user's id, or on an email application | Any id of the user's own was marked `applied_manually`, including email applications in the send queue; unknown ids still got a success reply | Own `link_ready` applications only; unknown ids are refused | `/done` scenario |
| 4 | Deadline approaching | No reminder | One reminder | Reminder scenario |
| 5 | `/links` | Not implemented | Lists waiting applications | `/links` scenario |

## Proof the suite detects these bugs

Reintroduced and confirmed failing: `/done` on any of the user's applications.

## Running

These scenarios are in `e2e/link-applications.e2e.mts` and run with the rest of the suite (`npm run build && npm run test:e2e`).
