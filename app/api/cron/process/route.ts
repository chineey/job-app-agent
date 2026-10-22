import { NextRequest, NextResponse } from 'next/server';
import { authorizeCronRequest, unauthorizedResponse } from '@/lib/auth';
import { sql } from '@/lib/db';
import {
  claimJobs,
  claimApplications,
  renewJobLease,
  renewApplicationLease,
  JobRecord,
  ApplicationRecord,
} from '@/lib/claims';
import { expandAuthorThread } from '@/lib/x';
import { extractJobDetails, matchCandidate, tailorApplication, verifyApplication } from '@/lib/gemini';
import { evaluateSharedGates } from '@/lib/gates';
import { fanoutJobToEligibleUsers } from '@/lib/fanout';
import { MasterFacts } from '@/lib/schemas';
import { generateResumePdfBuffer } from '@/lib/pdf/Resume';
import { put } from '@vercel/blob';

export const dynamic = 'force-dynamic';

/**
 * Main batch processing worker (Section 4 & Section 7)
 * Runs every 10 minutes:
 * 1. Jobs: Extract -> Gates -> Fan-out
 * 2. Applications: Match (fit score)
 * 3. Applications: Tailor (PDF render + email slots)
 * 4. Applications: Verify (Truthfulness audit)
 */
export async function GET(req: NextRequest) {
  if (!authorizeCronRequest(req)) {
    return unauthorizedResponse();
  }

  const workerId = `worker-${Date.now()}`;
  const summary = {
    jobsExtracted: 0,
    jobsFannedOut: 0,
    applicationsMatched: 0,
    applicationsTailored: 0,
    applicationsVerified: 0,
  };

  try {
    // ========================================================
    // STAGE 1: JOBS PROCESSING (Found -> Extracted / Rejected)
    // ========================================================
    const claimedJobs = await claimJobs('found', 5, workerId);

    for (const job of claimedJobs) {
      const token = job.claim_token!;
      const mediaUrls = (job.media_urls as string[]) || [];

      // Renew lease before LLM call
      const renewed = await renewJobLease(job.id, token);
      if (!renewed) continue;

      // Check if thread expansion is needed (Section 7.1a)
      let threadText = job.thread_text || '';
      let combinedMedia = [...mediaUrls];

      const rawHasThreadSignal =
        job.raw_text.includes('🧵') ||
        job.raw_text.toLowerCase().includes('1/') ||
        job.raw_text.toLowerCase().includes('in thread') ||
        job.raw_text.toLowerCase().includes('see below');

      if (!job.thread_fetched && job.conversation_id && job.author_handle && rawHasThreadSignal) {
        const thread = await expandAuthorThread(job.conversation_id, job.author_handle, 10);
        threadText = thread.threadText;
        combinedMedia = Array.from(new Set([...combinedMedia, ...thread.mediaUrls]));

        await sql`
          update jobs
          set thread_fetched = true,
              thread_text = ${threadText},
              media_urls = ${JSON.stringify(combinedMedia)}
          where id = ${job.id} and claim_token = ${token}
        `;
      }

      // Gemini Multimodal Extraction
      const extract = await extractJobDetails(job.raw_text, combinedMedia);

      // Evaluate Round 1 Shared Gates
      const gateResult = await evaluateSharedGates({
        extract,
        rawText: job.raw_text,
        threadText,
        transcribedText: extract.transcribed_text,
        applyLink: job.apply_link,
      });

      if (!gateResult.pass) {
        await sql`
          update jobs
          set status = ${gateResult.status},
              status_reason = ${gateResult.reason},
              transcribed_text = ${extract.transcribed_text},
              is_job = ${extract.is_job},
              is_software_role = ${extract.is_software_role},
              claim_token = null,
              locked_at = null,
              updated_at = now()
          where id = ${job.id} and claim_token = ${token}
        `;
        continue;
      }

      // Job passed gates -> set status = 'extracted'
      await sql`
        update jobs
        set status = 'extracted',
            transcribed_text = ${extract.transcribed_text},
            is_job = ${extract.is_job},
            is_software_role = ${extract.is_software_role},
            company = ${extract.company},
            role = ${extract.role},
            location = ${extract.location},
            remote = ${extract.remote},
            relocation_required = ${extract.relocation_required},
            visa_sponsorship = ${extract.visa_sponsorship},
            min_years = ${extract.min_years},
            salary = ${extract.salary},
            deadline = ${extract.deadline ? new Date(extract.deadline) : null},
            requirements = ${JSON.stringify(extract.requirements)},
            apply_method = ${extract.apply_method},
            contact_email = ${gateResult.contactEmail},
            address_source = ${gateResult.addressSource},
            address_mx_ok = true,
            scam_risk = ${extract.scam_risk},
            scam_reasons = ${JSON.stringify(extract.scam_reasons)},
            dedupe_hash = ${gateResult.dedupeHash},
            claim_token = null,
            locked_at = null,
            updated_at = now()
        where id = ${job.id} and claim_token = ${token}
      `;
      summary.jobsExtracted++;

      // Fan-out to eligible users
      const fanoutRes = await fanoutJobToEligibleUsers({
        ...job,
        contact_email: gateResult.contactEmail,
        apply_method: extract.apply_method,
      } as JobRecord);

      if (fanoutRes.fannedOutCount > 0) {
        summary.jobsFannedOut += fanoutRes.fannedOutCount;
      }
    }

    // ========================================================
    // STAGE 2: APPLICATIONS MATCHING (Queued -> Matched / Low Fit)
    // ========================================================
    const queuedApps = await claimApplications('queued', 10, 2, workerId);

    for (const app of queuedApps) {
      const token = app.claim_token!;
      const factsRow = (await sql`
        select facts from facts_versions where id = ${app.facts_version_id} limit 1
      `) as { facts: MasterFacts }[];

      const jobRow = (await sql`
        select * from jobs where id = ${app.job_id} limit 1
      `) as JobRecord[];

      if (factsRow.length === 0 || jobRow.length === 0) {
        await sql`
          update applications
          set status = 'failed', status_reason = 'missing_facts_or_job', claim_token = null, locked_at = null
          where id = ${app.id} and claim_token = ${token}
        `;
        continue;
      }

      const facts = factsRow[0].facts;
      const job = jobRow[0];

      // Fetch user's fit_threshold
      const settingsRow = (await sql`
        select fit_threshold from user_settings where user_id = ${app.user_id} limit 1
      `) as { fit_threshold: number }[];
      const fitThreshold = settingsRow.length > 0 ? settingsRow[0].fit_threshold : 40;

      // Run Gemini Matching
      await renewApplicationLease(app.id, token);
      const matchResult = await matchCandidate(
        {
          role: job.role,
          company: job.company,
          requirements: (job.requirements as string[]) || [],
          min_years: job.min_years,
        },
        facts
      );

      if (matchResult.fit_score < fitThreshold) {
        // Below threshold -> rejected with reason 'low_fit'
        await sql`
          update applications
          set status = 'rejected',
              status_reason = 'low_fit',
              fit_score = ${matchResult.fit_score},
              gaps = ${JSON.stringify(matchResult.gaps)},
              years_gap = ${matchResult.years_gap},
              claim_token = null,
              locked_at = null,
              updated_at = now()
          where id = ${app.id} and claim_token = ${token}
        `;
      } else {
        // Pass -> matched
        await sql`
          update applications
          set status = 'matched',
              fit_score = ${matchResult.fit_score},
              gaps = ${JSON.stringify(matchResult.gaps)},
              years_gap = ${matchResult.years_gap},
              claim_token = null,
              locked_at = null,
              updated_at = now()
          where id = ${app.id} and claim_token = ${token}
        `;
        summary.applicationsMatched++;
      }
    }

    // ========================================================
    // STAGE 3: APPLICATIONS TAILORING (Matched -> Drafted)
    // ========================================================
    const matchedApps = await claimApplications('matched', 10, 2, workerId);

    for (const app of matchedApps) {
      const token = app.claim_token!;
      const factsRow = (await sql`
        select facts, source_file_url from facts_versions where id = ${app.facts_version_id} limit 1
      `) as { facts: MasterFacts; source_file_url: string | null }[];

      const jobRow = (await sql`
        select * from jobs where id = ${app.job_id} limit 1
      `) as JobRecord[];

      const settingsRow = (await sql`
        select resume_mode from user_settings where user_id = ${app.user_id} limit 1
      `) as { resume_mode: 'generated' | 'uploaded' }[];

      if (factsRow.length === 0 || jobRow.length === 0) continue;

      const facts = factsRow[0].facts;
      const job = jobRow[0];
      const resumeMode = settingsRow.length > 0 ? settingsRow[0].resume_mode : 'generated';
      const route = (app.route as 'email' | 'link') || 'email';

      await renewApplicationLease(app.id, token);
      const tailored = await tailorApplication(
        {
          role: job.role,
          company: job.company,
          requirements: (job.requirements as string[]) || [],
        },
        facts,
        resumeMode,
        route
      );

      let resumeBlobUrl: string | null = null;

      if (resumeMode === 'generated' && tailored.resume_json) {
        // Render ATS PDF Buffer
        const pdfBuffer = await generateResumePdfBuffer(facts, tailored.resume_json);
        const blobPath = `resumes/${app.user_id}/${app.id}/${token}.pdf`;

        if (process.env.BLOB_READ_WRITE_TOKEN) {
          const blob = await put(blobPath, pdfBuffer, { access: 'public' });
          resumeBlobUrl = blob.url;
        } else {
          // Fallback / mock storage path for local development
          resumeBlobUrl = `https://blob.local/${blobPath}`;
        }
      } else if (resumeMode === 'uploaded') {
        // Attach user's uploaded original file directly
        resumeBlobUrl = factsRow[0].source_file_url;
      }

      await sql`
        update applications
        set status = 'drafted',
            email_subject = ${tailored.email_slots.subject},
            email_body = ${[
              tailored.email_slots.opening_line,
              tailored.email_slots.project_fit_sentences,
              tailored.email_slots.gap_sentence,
            ].filter(Boolean).join('\n\n')},
            cover_note = ${tailored.cover_note},
            resume_blob_url = ${resumeBlobUrl},
            resume_source = ${resumeMode},
            claim_token = null,
            locked_at = null,
            updated_at = now()
        where id = ${app.id} and claim_token = ${token}
      `;
      summary.applicationsTailored++;
    }

    // ========================================================
    // STAGE 4: APPLICATIONS VERIFICATION (Drafted -> Verified / Needs Manual)
    // ========================================================
    const draftedApps = await claimApplications('drafted', 10, 2, workerId);

    for (const app of draftedApps) {
      const token = app.claim_token!;
      const factsRow = (await sql`
        select facts from facts_versions where id = ${app.facts_version_id} limit 1
      `) as { facts: MasterFacts }[];

      if (factsRow.length === 0) continue;
      const facts = factsRow[0].facts;

      await renewApplicationLease(app.id, token);

      const audit = await verifyApplication(facts, {
        resume_json: null,
        email_slots: {
          subject: app.email_subject || '',
          opening_line: app.email_body?.split('\n\n')[0] || '',
          project_fit_sentences: app.email_body?.split('\n\n')[1] || '',
          gap_sentence: app.email_body?.split('\n\n')[2] || '',
        },
        cover_note: app.cover_note,
      });

      if (!audit.supported || audit.unsupported_claims.length > 0) {
        await sql`
          update applications
          set status = 'needs_manual',
              status_reason = 'unsupported_claims',
              verify_result = ${JSON.stringify(audit)},
              claim_token = null,
              locked_at = null,
              updated_at = now()
          where id = ${app.id} and claim_token = ${token}
        `;
      } else {
        const nextStatus = app.route === 'link' ? 'link_ready' : 'ready';
        await sql`
          update applications
          set status = ${nextStatus},
              verify_result = ${JSON.stringify(audit)},
              claim_token = null,
              locked_at = null,
              updated_at = now()
          where id = ${app.id} and claim_token = ${token}
        `;
        summary.applicationsVerified++;
      }
    }

    return NextResponse.json({
      success: true,
      summary,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Process cron error:', err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
