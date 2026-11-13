# Telegram access and onboarding

The Telegram webhook is the only way users and the admin control the agent. This document lists who may do what through it, the failure modes found in the existing code, and the E2E scenario that proves each fix.

## Rules

1. The webhook rejects any request without the configured secret header, including when no secret is configured.
2. Only private chats are handled. In a group, `chat.id` is the group, so anyone in it would act as that "user".
3. Each Telegram `update_id` is handled at most once, so a redelivered update cannot run a command twice.
4. An invite code admits at most `max_uses` users, and the total stays within `MAX_USERS`, even when redeemed concurrently.
5. The admin (`ADMIN_CHAT_ID`) registers with `/start` without an invite; nobody else can.
6. Admin commands run only for the admin.
7. New users start in dry run. Leaving dry run requires a connected Gmail, accepted facts, verified years of experience and 5 reviewed previews, whether or not `confirm` is given.
8. User settings only accept values the rest of the system can use; one user's bad value cannot affect other users.

## Failure modes

| # | Failure | Before | Handling now | E2E scenario |
| --- | --- | --- | --- | --- |
| 1 | Any active user sends `/admin_pauseall` or `/admin_resumeall` | Every command starting with `/admin` reached the admin handler, which never checked the role; any user could lift the admin's emergency pause | Admin commands are rejected unless the sender is the admin | Non-admin cannot run admin commands |
| 2 | User sends `/dry off confirm` straight away | The prerequisites were only checked without `confirm`; with it, the account went live immediately | The prerequisites are checked on both paths | Dry run cannot be skipped |
| 3 | Two chats redeem the same single-use code at once | Validate, insert and increment ran as separate statements; both chats became users | Redemption runs in one transaction holding the invite row lock (and a registration lock for `MAX_USERS`) | Concurrent invite redemption |
| 4 | The same chat sends `/start <code>` twice (double tap or redelivery) | The second insert failed and the raw database error was sent to the user | The insert skips an existing chat; the reply says the chat is already registered | Covered by duplicate update and concurrent redemption |
| 5 | Telegram redelivers an update | Handled again: `/invite` made a second code | `update_id` is recorded before handling; repeats are ignored | Duplicate update |
| 6 | `/start <code>` is sent from a group | The group chat became a registered user | Non-private chats are ignored | Group chat is ignored |
| 7 | Webhook secret missing or wrong | When `TELEGRAM_WEBHOOK_SECRET` was unset, every request was accepted | 401 unless a configured secret matches (constant-time comparison) | Wrong or missing secret |
| 8 | User sets `/timezone Mars/Olympus` | Stored as is; every later send query (`at time zone`) threw, failing the send cron for all users | Rejected unless it is a valid IANA zone; stored in canonical form | Invalid timezone is rejected |
| 9 | The admin has no account yet | `/start` required an invite, and only an admin can create one, so the first admin could never register | `/start` from `ADMIN_CHAT_ID` creates the admin without an invite | Onboarding flow |
| 10 | Unexpected registration error | `err.message` (database text) was sent to the user | Generic reply; details go to the server log | Not exercised |
| 11 | One chat floods the bot | Every update was handled | Over 30 updates a minute per chat are ignored without a reply | Throttled chat |
| 12 | `telegram_updates` grows forever | Nothing pruned it | The hourly summary cron deletes ids older than a day (Telegram redelivers for at most a day) | Pruning |
| 13 | `/delete_me` | Kept the user's events | Deletes them, and the chat's update ids | `/delete_me` deletes events |

## Known gaps, not addressed here

- The failing webhook secret check with no secret configured is not exercised: the E2E server always has one.

## Proof the suite detects these bugs

Six of the original defects were reintroduced together (each affects only its own scenario), the server rebuilt, and the suite run:

| Reintroduced defect | Result |
| --- | --- |
| No admin check on admin commands | "Only the admin can run admin commands" fails: a user lifted the global pause |
| `confirm` skips the dry-run prerequisites | "Dry run cannot be skipped" fails |
| Registration without the invite row lock and registration lock | "Concurrent chats" fails: both chats registered |
| No `update_id` dedupe | "Redelivered update" fails: two invites |
| Group chats accepted | "Group chats are ignored" fails: the group registered |
| Timezone not validated | "Unknown timezone" fails |

The secret scenario passed under the old code too, because a secret is always configured in the E2E server. The fail-closed path with no secret is not exercised.

## Running

These scenarios are in `e2e/telegram-access.e2e.mts` and run with the rest of the suite:

```bash
npm run build
npm run test:e2e
```
