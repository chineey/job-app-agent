# Ramp schedule and auto-pause

There is no human approval before an application is sent. The spec relies on a slow per-user ramp, dry run for new users, and automatic pauses to protect each sender's reputation. This document lists how those protections failed in the existing code, how each is handled now, and the E2E scenario for each.

## Rules

| Stage | Daily cap | Moves up after |
| --- | --- | --- |
| 0 (dry run) | 0 | the dry-run exit conditions, then `/dry off confirm` |
| 1 | 3 | 3 active days, no bounces, no confirmed send failures |
| 2 | 5 | 3 active days, bounce rate under 3% |
| 3 | 10 | 4 active days, bounce rate under 3%, no confirmed send failures |
| 4 | 15 | 4 active days, bounce rate under 3% |
| 5 | 20 | steady state |

1. An **active day** is a day in the user's timezone on which at least one application was sent. Calendar days without sends prove nothing about a sender's reputation, so they do not count.
2. The stage clock starts when the user enters the stage, including stage 1 on `/dry off confirm`.
3. The cap that applies is the lowest of the user's `/cap`, the stage cap and the admin's `max_cap`. `/cap` can lower it (the spec's "veto" of a raise) but never raise it above the stage cap. *This deviates from the spec's wording, which lets `/cap` go up to `max_cap` at any stage and so bypass the ramp; agreed with the project owner on 2 November 2026.*
4. An automatic pause sets `paused = true` and tells both the user and the admin why. It triggers on:
   - a bounce rate above 5% over the user's last 20 sends (including when they have sent fewer than 20);
   - three consecutive confirmed send failures;
   - Gmail answering 401 (authorization lost) or 403 (account or policy problem).
5. An uncertain send blocks that account's sending until it is reconciled or resolved (see `send-safety.md`). It does not set `paused`, because reconciliation usually settles it within minutes and would otherwise leave the user waiting on a manual `/resume`.
6. In dry run, each application is previewed once. Only distinct previews count toward the 5 required to leave dry run.

## Failure modes

| # | Failure | Before | Handling now | E2E scenario |
| --- | --- | --- | --- | --- |
| 1 | `/dry off confirm` | Set stage 1 without a stage start time; the ramp measured from 1970 and promoted at the first evening summary | The stage start time is set on every stage change | Leaving dry run starts the stage clock |
| 2 | A user sends nothing for 3 days | Calendar days counted; zero sends meant zero bounces, so the user was promoted | Only active days count | No promotion without active days |
| 3 | `/cap 20` at stage 1 | Allowed up to `max_cap`; the ramp could be skipped on day one | Refused above the stage cap; `authorizeSend` also enforces the lowest cap | `/cap` cannot exceed the stage cap |
| 4 | Three confirmed send failures in a row | Not implemented | Pauses the user, alerts user and admin | Three consecutive failures pause |
| 5 | Gmail answers 403 (quota, suspended account, policy) | Counted as an ordinary failure; sending carried on | Pauses the user, alerts user and admin | A 403 pauses |
| 6 | Bounces while the user has sent fewer than 10 | The breaker required at least 10 sends, so a stage-1 user with 1 bounce in 3 kept sending | Rate over the last 20 sends, however many there are | High bounce rate pauses |
| 7 | Bounce rate computed from all applications with `applied_at` | Link applications marked `/done` counted as sends | Computed from sent attempts only | High bounce rate pauses |
| 8 | Auto-pause alert | Only the user was told, and only for some triggers | Every automatic pause tells the user and the admin | Covered by the three pause scenarios |
| 9 | Dry run | Each cron run re-sent the same preview and counted it, so one application met the 5-preview gate in 50 minutes | Previewed once, counted once | Dry run previews each application once |
| 10 | Stage 1 with a bounce | Promotion checked bounces correctly, but nothing proved it | Unchanged | A bounce blocks promotion |

## Known gaps, not addressed here

- "No warnings" for stage 3 has no definition in the spec; only confirmed send failures are checked.
- Bounces are found by the inbox scan every 2 hours, so a bounce from the last few hours before the 20:00 review is not yet counted.
- After leaving dry run, applications that were previewed are still eligible to send.

## Proof the suite detects these bugs

Each defect was reintroduced, the server rebuilt, and the suite run (two builds, because two defects share a scenario):

| Reintroduced defect | Failing scenario |
| --- | --- |
| Calendar days instead of active days | "Not promoted for days on which nothing was sent" |
| `/dry off confirm` leaves the stage clock unset | "Leaving dry run starts the stage clock" |
| `/cap` allowed up to `max_cap` | "`/cap` cannot exceed the stage cap" |
| Sending obeys `current_cap` without the stage cap | "`/cap` cannot exceed the stage cap": a fourth send went out at stage 1 |
| No consecutive-failure breaker | "Three consecutive confirmed failures" |
| 403 treated as an ordinary failure | "A 403 from Gmail pauses the user" |
| Bounce breaker requires 10 sends | "A bounce rate over 5% pauses the user" |
| Dry run previews on every run | "Dry run previews each application once" |

A user with `dry_run = false` and `ramp_stage = 0` can now send nothing: stage 0's cap is 0. The old `/dry off confirm` always set stage 1, so only hand-edited rows are affected.

## Running

These scenarios are in `e2e/ramp-and-auto-pause.e2e.mts` and run with the rest of the suite:

```bash
npm run build
npm run test:e2e
```
