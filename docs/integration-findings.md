# Integration findings: the whole pipeline

On 2 November 2026 the whole pipeline was run end to end for the first time (`e2e/pipeline.e2e.mts`). It drives Dev A's ingest and process crons into Dev B's send cron on the production build, with fake X, Gemini, Blob, Gmail and Telegram.

**What was tested.** Everything on GitHub at that time. GitHub showed no push from Dev A after 24 October (`master` f54ec5d, `input-op-x` 719e5fc), so any newer local work of his is not covered here.

## Works end to end

- A hiring post is ingested, extracted, gated (including the live MX lookup) and fanned out. It is then matched, tailored (with a rendered PDF stored in Blob) and verified, and reaches the user as a dry-run preview. For a live user it is sent once from Gmail with the resume attached.
- The verifier rejecting a claim stops the application (`needs_manual`, nothing sent).
- A poor fit is neither tailored nor sent.

## Fixed in Dev A's files during this run

| File | Problem | Fix |
| --- | --- | --- |
| `lib/fanout.ts` | The eligible-user query nested a `sql` template inside another. The `pg` driver runs every template immediately, so fan-out failed for every job and no user ever received one. | A plain bind parameter: `(manualSubmitter::uuid is null or u.id = manualSubmitter)` |
| `app/api/cron/ingest/route.ts`, `app/api/cron/process/route.ts` | Next 14 caches `fetch` inside GET routes, including X searches and Gemini calls. A repeated search URL returned old posts without calling X, and scenarios received each other's Gemini answers. | `export const fetchCache = 'force-no-store'`, as Dev B's crons have |
| `lib/parse-resume.ts` | `pdf-parse` misread uploaded PDFs depending on Node's buffer pool: 17 of 30 valid uploads were rejected. | Pass a plain `Uint8Array` (see `resume-onboarding.md`) |
| `lib/x.ts`, `lib/gemini.ts`, `lib/parse-resume.ts` | Not testable: provider URLs hard-coded | Test-only base URL variables, unset in every real environment |

## Broken, left for Dev A

These are `todo` scenarios in `e2e/pipeline.e2e.mts`. They run and report, but don't fail CI until fixed.

1. **Every link or form job is dropped.** Ingest never requests or stores the post's URL entities, so `apply_link` is always null. The gate marks every link job `needs_manual` (`link_missing`), and no user ever gets a link card. The spec takes the apply link from the post's entities, never from the model.
2. **Ingest re-reads posts it has already paid for.** It resumes from the newest *stored* job, but stores a batch oldest-last and skips posts that fail the pre-filter. So the cursor lands on old posts, and each run fetches them again. `searchRecentJobPosts` already returns `highestId`, which is never used.
3. **Thread expansion never runs.** It requires `author_handle`, and ingest never stores it (the search requests usernames but drops them).

## Found by reading, not yet tested

- **Generated resumes are uploaded with `access: 'public'`.** They carry each candidate's name, email and phone, and the spec requires private storage. With no `BLOB_READ_WRITE_TOKEN`, the stored URL is `https://blob.local/...`, which can never be downloaded. Dev B's send then refuses to send without the resume (by design), so every send fails.
- **The resume parser asks Gemini to estimate years of experience.** Dev B no longer counts the estimate as confirmed (`resume-onboarding.md`), but the prompt still invites a guess.

## Running

```bash
npm run build
npm run test:e2e
```

Dev A's MX gate does a real DNS lookup, so the suite needs network access. The contact address uses a domain with mail servers, and nothing is ever sent to it.
