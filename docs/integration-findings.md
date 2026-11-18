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

## Fixed by Dev A on 13 November (`ce58473`)

All three bugs reported here are fixed, and their scenarios in `e2e/pipeline.e2e.mts` are ordinary tests again:

1. Link and form jobs keep their apply link (from the post's URL entities), so users get link cards.
2. Ingest keeps its cursor in `global_settings` (`x_last_since_id`) and no longer re-reads posts.
3. Ingest stores `author_handle`, so thread expansion can run.

The same commit added manual post ingest (pasting a post URL in Telegram) and stores the generated resume as a `data:` URL in the database when no Blob token is set.

## Open after `ce58473`

- **Pasting a post URL has no limit.** `user_settings.manual_daily_cap` (5 a day) is never checked, and `fetchSinglePost` records an X read without checking the daily X budget. Any user can spend the shared X and Gemini budget by pasting links.
- **Pasting a URL of a post already in the system resets the shared job to `found`** for everyone, and deletes the user's own unfinished applications for it, including skipped ones. If one of them has a send attempt, the delete fails on the foreign key and the user gets a generic error.

## Found by reading, not yet tested

- **Generated resumes are uploaded with `access: 'public'`.** They carry each candidate's name, email and phone, and the spec requires private storage. With no `BLOB_READ_WRITE_TOKEN`, the stored URL is `https://blob.local/...`, which can never be downloaded. Dev B's send then refuses to send without the resume (by design), so every send fails.
- **The resume parser asks Gemini to estimate years of experience.** Dev B no longer counts the estimate as confirmed (`resume-onboarding.md`), but the prompt still invites a guess.

## Running

```bash
npm run build
npm run test:e2e
```

Dev A's MX gate does a real DNS lookup, so the suite needs network access. The contact address uses a domain with mail servers, and nothing is ever sent to it.
