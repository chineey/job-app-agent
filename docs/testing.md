# E2E testing and evidence

E2E is the preferred sole testing mechanism. Exercise complete feature behavior
through its public entry point and observable state, including rejection, recovery
and concurrency outcomes. Do not import an internal helper and call that E2E.

Never write unit tests after implementation. If a system truly requires isolated
testing, first enumerate its failure modes, explain the specific failures E2E
cannot catch, and write the needed tests before implementing the system. Remove
unit tests without that distinct bug-catching value. No coverage/count targets.

## Current scenario and failure inventory

The foundation has only a public liveness endpoint. Its single smoke scenario
checks production build → fresh server process → HTTP route → response evidence.
It does not exercise users, persistence, Telegram, Gmail or sending.

| Failure                                           | Detection                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| The production application cannot build           | `npm test` fails at the build step                                      |
| The built server crashes or fails to become ready | Runner startup fails with a bounded timeout                             |
| Another process would produce a misleading result | Existing servers are never reused; an occupied address fails            |
| The route is missing or returns an error          | Fresh-server readiness or actual HTTP assertion fails                   |
| The response contract or caching behavior changes | Actual status, JSON, content type and cache policy are checked together |
| Evidence is absent from CI                        | The artifact-upload step fails rather than silently passing             |

This is startup/routing coverage, not a substitute for future feature scenarios.
When a protected route is implemented, test unauthorized calls and absence of
protected effects through that route instead of recreating a token-parser table.

## Replay

From the same source revision, with Node 24 and npm:

```bash
npm ci
npm test
npm run test:report
```

The runner builds production first and owns a server at `127.0.0.1:3107`. It shuts
that process down after the run. Free that address before replaying; do not reuse a
development server. This HTTP-only scenario uses no browser binaries or external
credentials. Do not install browsers unless a later scenario needs a browser UI.

## Artifacts

- `artifacts/e2e/report/index.html`: human-readable result and attachments.
- `artifacts/e2e/results.json`: machine-readable scenario status and failures.
- `artifacts/e2e/test-results/`: per-test runner evidence, when applicable.

The scenario attaches the actual HTTP status, selected response headers and body
before assertions; the HTML and JSON reports retain that attachment, so a response
mismatch remains inspectable. Startup failures
are recorded by the runner even if a request could not be made. CI uploads this
folder as `e2e-evidence` on success or failure and retains it for 7 days. If a build
fails before the runner starts, build logs are the evidence; no E2E pass is claimed.

Reports contain timings, so replay means repeatable commands and assertions, not
byte-identical report files. Share sanitized artifacts, not tokens, inbox contents
or real resumes. As features arrive, add their minimal fixtures, source revision
and replay instructions to the evidence needed to verify the actual outcome.
