import { NextRequest, NextResponse } from 'next/server';
import { authorizeCronRequest, unauthorizedResponse } from '@/lib/auth';
import { claimApplications } from '@/lib/claims';
import { reconcileUncertainSends, authorizeSend, executeSend, type SendOutcome } from '@/lib/send';

export const dynamic = 'force-dynamic';
// Every outbound call here is a side effect or must be fresh; never serve one from Next's fetch cache.
export const fetchCache = 'force-no-store';
export const maxDuration = 60; // Up to 60 seconds

export async function GET(req: NextRequest) {
  if (!authorizeCronRequest(req)) {
    return unauthorizedResponse();
  }

  try {
    // 1. Reconcile any uncertain sends across all users
    const reconcileResults = await reconcileUncertainSends();

    // 2. Claim verified or ready applications across users fairly
    const verifiedApps = await claimApplications('verified', 15, 3, 'send_worker');
    const readyApps = await claimApplications('ready', 15, 3, 'send_worker');
    const allApps = [...verifiedApps, ...readyApps];

    let dryRunCount = 0;
    let skippedCount = 0;
    const outcomes: Record<SendOutcome, number> = { sent: 0, failed: 0, released: 0, send_unknown: 0, aborted: 0 };

    for (const app of allApps) {
      if (!app.claim_token) continue;

      const authorization = await authorizeSend(app.user_id, app.id, app.claim_token);
      if (authorization.outcome === 'dry_run') {
        dryRunCount++;
        continue;
      }
      if (authorization.outcome === 'skipped') {
        skippedCount++;
        continue;
      }

      outcomes[await executeSend(app.user_id, authorization.attemptId)]++;
    }

    return NextResponse.json({
      ok: true,
      reconciliation: reconcileResults,
      claimed: allApps.length,
      dryRuns: dryRunCount,
      skipped: skippedCount,
      ...outcomes,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('Error in send cron:', err);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
