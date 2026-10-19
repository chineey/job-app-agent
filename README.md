# Job Application Agent

A Telegram-controlled job-application tool for a small invited group. The target
design discovers jobs on X, prepares applications from each user's accepted resume
facts, and sends through their own Gmail account.

**Current scope:** the development foundation only. It provides a Next.js backend,
a liveness endpoint, a tested cron-authorization primitive and local/CI quality
checks. Job discovery, users, database access, Telegram, Gmail and sending are not
implemented. There is no dashboard or home page; `/` returns 404.

## Local setup

Use Node 24 and npm 11 or 12. With nvm:

```bash
nvm install
nvm use
npm ci
npm run dev
```

Open [the liveness endpoint](http://localhost:3000/api/health). It returns
`{"status":"ok"}` and reports only that the HTTP application is responding. It
does not check a database or external provider.

The foundation does not need credentials or a `.env.local` file. `.env.example`
documents keys reserved for future features. Configure and validate credentials
per integration when implementing it; keep values out of Git. Shared Vercel/Neon
linking, provisioning and migrations belong to a later, reviewed setup step.

## Commands

| Command                | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `npm run dev`          | Run the local development server                   |
| `npm run build`        | Create a production build                          |
| `npm start`            | Serve an existing production build                 |
| `npm run format`       | Apply Prettier formatting                          |
| `npm run format:check` | Check formatting                                   |
| `npm run lint`         | Check code and import boundaries; fail on warnings |
| `npm run typecheck`    | Generate route types and check TypeScript          |
| `npm test`             | Run behavior tests once                            |
| `npm run test:watch`   | Watch tests locally                                |
| `npm run check`        | Run formatting, lint, types, tests and build       |

Run `npm run check` before opening a PR. GitHub Actions runs `npm ci` and the same
gate without credentials, provisioning or deployment. Branch protection must be
configured by the repository owner if passing CI is to be a required merge gate.

## Working together

The default branch is `master`. Create a feature branch, keep the PR focused and
review shared contracts together. Dependencies use exact versions and a committed
lockfile; use `npm ci` for a fresh checkout.

- [Repository instructions](AGENTS.md): how contributors and coding agents work.
- [Architecture and ownership](docs/architecture.md): boundaries and next steps.
- [Engineering decisions and skill sources](docs/engineering.md): rationale.
- [Build spec v3.2](job-agent-build-spec-v3_2.md): target behavior and rollout.

The next Dev B slice is database/user isolation followed by Telegram invitations,
consent, `/status`, `/pause` and `/resume`. Resolve the shared interfaces listed in
the architecture document with Dev A before implementing their consumers.
