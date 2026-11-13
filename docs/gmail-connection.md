# Gmail connection and token protection

Each user connects their own Gmail with OAuth. The refresh token can send email as that person for as long as Google honours it, so it is the most sensitive value the agent stores. This document lists the failure modes in connecting, storing and revoking it, plus the shared-secret checks on the cron routes, and the E2E scenario for each.

## Rules

1. A `/connect` link works once, for 10 minutes, for the user it was issued to.
2. A connection is stored only if Google granted every scope the agent needs.
3. One Gmail address belongs to at most one user, because sending is serialized per user and the daily caps protect that address's reputation.
4. While a send is reserved, in flight or uncertain, the user cannot switch to a different Gmail address, because reconciliation must search the mailbox that sent it.
5. Refresh tokens are encrypted with a 32-byte key from `TOKEN_ENCRYPTION_KEY`. There is no fallback key and no passphrase hashing.
6. `/disconnect` and `/delete_me` revoke the token with Google, then delete it. The user is told the truth if Google did not confirm the revoke.
7. Cron routes and the Telegram webhook reject requests when their secret is unset, and compare secrets in constant time.

## Failure modes

| # | Failure | Before | Handling now | E2E scenario |
| --- | --- | --- | --- | --- |
| 1 | User runs `/disconnect` | The *encrypted* token was sent to Google's revoke endpoint, which rejected it silently; the token stayed valid at Google while the user was told it was revoked | The token is decrypted and revoked; the reply says whether Google confirmed it | Disconnect revokes the real token |
| 2 | User runs `/delete_me confirm` | The prompt promised to revoke Gmail credentials; the code only nulled our copy | Deletion revokes first, then deletes | Delete revokes the real token |
| 3 | `TOKEN_ENCRYPTION_KEY` unset or weak | Outside production a hardcoded key from the repository was used; any string was accepted by hashing it | Encryption fails unless the key decodes to exactly 32 bytes; nothing is stored | Unsafe configuration fails closed |
| 4 | Google returns the consent callback twice, or a link is reused | The state was checked first and marked used only at the very end, so concurrent or repeated callbacks could all pass | The state is consumed atomically before anything else | Reused link is rejected |
| 5 | User unticks "send email" on Google's consent screen | The connection was stored as `connected`; every send then failed with 403 and counted as a failed attempt | Missing scopes are rejected, the partial grant is revoked, and the user is told which permission is needed | Missing send scope is rejected |
| 6 | Two users connect the same Gmail address | Allowed; each user had their own cap and spacing, so the address could send twice the limit | Rejected; backed by a unique index | Same address for two users is rejected |
| 7 | User reconnects with a different address while a send is uncertain | Reconciliation would search the new mailbox, never find the message, and the attempt would stay stuck | Switching address is refused while a send is reserved, in flight or uncertain | Address switch during an uncertain send is refused |
| 8 | `CRON_SECRET` unset | Any request was accepted outside production | 401 | Unsafe configuration fails closed |
| 9 | Callback error from Google or the token exchange | Internal error text was returned to the browser | A generic page; details go to the server log | Not exercised |

## Known gaps, not addressed here

- A `/connect` link is not bound to the browser that opens it. Anyone who gets the link within 10 minutes could connect *their* Gmail to the victim's account. The link is only ever sent in the user's private chat.
- `/delete_me` still keeps `events` rows and does not delete stored resume files (spec section 3.1); that belongs with the rest of account deletion.
- Existing tokens encrypted with a passphrase-derived key cannot be decrypted after this change; affected users must `/connect` again.

## Proof the suite detects these bugs

Each defect was reintroduced, the server rebuilt, and the suite run (two builds, because two defects share a scenario):

| Reintroduced defect | Result |
| --- | --- |
| `/disconnect` and `/delete_me` revoke the stored ciphertext | Both scenarios fail: Google received the ciphertext, not the token |
| Webhook and cron accept requests when no secret is configured | "Unsafe configuration" fails: the unauthenticated cron call ran |
| No scope check | "Grant without the send scope" fails |
| No address uniqueness (check and index) | "Address already connected" fails |
| State checked first, marked used at the end | "Connect link works once" fails: both racing callbacks connected |
| Passphrase hashed into a key | "Unsafe configuration" fails: a token was stored with the weak key |
| Address switch allowed with an open send | "Switching address" fails |

The cron fail-open existed only under `next dev`; `next start` already rejected requests when `CRON_SECRET` was unset. The webhook fail-open applied everywhere.

## Running

These scenarios are in `e2e/gmail-connection.e2e.mts` and run with the rest of the suite:

```bash
npm run build
npm run test:e2e
```
