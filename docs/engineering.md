# Engineering decisions

The priority is code a teammate can read, change and verify. More layers, classes,
dependencies or instructions do not by themselves produce better software.

## Choices for this foundation

- **One deployable backend:** retain the agreed Next.js route-handler stack and
  plain functions. No agent framework, monorepo tooling, queues or provider SDKs
  are needed to establish this first slice.
- **Explicit boundaries:** transport stays in `app/`; named application and
  infrastructure functions live in `lib/`. Pure gates later receive external
  lookup results rather than importing provider clients. ESLint rejects framework
  and route imports from `lib/`.
- **Small abstractions:** introduce a function parameter or narrow interface at an
  actual side effect when needed. Avoid generic base classes, repository scaffolds,
  one-use wrappers and arbitrary file/function size limits.
- **Readable TypeScript:** strict checking, indexed-access checks and exact optional
  properties expose missing cases. Lint rejects explicit `any`, non-null assertions
  and unhandled promises. Formatter output is mechanical, not a review debate.
- **Supported lint tooling:** use ESLint 10 and typed typescript-eslint rules. The
  current Next.js shared preset pulls React plugins with ESLint 9 peer constraints
  and a glob dependency with a security advisory. This backend uses neither those
  React rules nor an unsupported/forced peer install. Reassess framework/UI lint
  plugins if product UI is introduced or the preset's dependencies are updated.
- **Useful tests:** the first primitive is request authorization, whose missing
  config and malformed-token cases matter to future secured cron routes. No dummy
  tests or empty-suite success flags. Later safety features require their own
  failure and real-database concurrency tests.
- **Reproducibility:** Node 24, npm, exact direct dependency versions and the lockfile.
  CI uses SHA-pinned official actions and read-only repository permissions. It runs
  the same checks as a contributor and receives no production credentials.
- **Independent foundation:** build/type checks and health do not require remote
  services. Integration credentials are validated at their own runtime boundaries
  when those features exist, not by connecting to providers at module import time.

## Review standard

A PR explains the behavior it changes, tests actually run, shared interfaces and
remaining limits. Review correctness, isolation, external effects, races, recovery
and failure evidence. Distinguish defects from preferences. A passing unit suite
does not prove provider behavior, database locking or production readiness.

Treat future code as absent until implemented. Do not return fabricated success
data to make unfinished features look complete. Remove obsolete branches and
debug output; document non-obvious constraints instead of narrating obvious code.

## Skills and documentation consulted

Reviewed on 19 October 2026. The rules above are adapted for this project, not a
wholesale adoption of the examples or installation workflows in these sources.

- [Architecture Patterns — wshobson/agents](https://github.com/wshobson/agents/blob/main/plugins/backend-development/skills/architecture-patterns/SKILL.md):
  separation of business rules and infrastructure, test seams and dependency direction.
  Its class-heavy layering is unnecessary for this spec's plain-function design.
- [Code Review Excellence — wshobson/agents](https://github.com/wshobson/agents/blob/main/plugins/developer-essentials/skills/code-review-excellence/SKILL.md):
  actionable, prioritized reviews; automate formatting and review behavior.
- [Verification Before Completion — obra/superpowers](https://github.com/obra/superpowers/blob/main/skills/verification-before-completion/SKILL.md):
  inspect fresh command results and independently verify delegated work before claiming success.
- [OpenAI: repository instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md):
  keep persistent instructions concise and make review rules explicit.
- [Vercel backend guidance](https://vercel.com/docs/frameworks/backend) and the installed
  `create-a-backend`, `bootstrap` and `deployments-cicd` skills: choose the workload's
  existing framework; separate local checks from resource provisioning/deployment.
- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation),
  [ESLint configuration](https://nextjs.org/docs/app/api-reference/config/eslint) and
  [Vitest](https://vitest.dev/guide/): current framework and tool configuration.

Use applicable skills deliberately. Their examples do not authorize replacing the
agreed stack, provisioning services, adding dependencies without a present need,
or introducing a more elaborate architecture.
