import { NextRequest, NextResponse } from 'next/server';
import { authorizeCronRequest, unauthorizedResponse } from '@/lib/auth';
import { claimApplications } from '@/lib/claims';
import { reconcileUncertainSends, authorizeSend, executeSend } from '@/lib/send';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Up to 60 seconds

export async function GET(req: NextRequest) {
  if (!authorizeCronRequest(req)) {
    return unauthorizedResponse();
  }

  try {
    // 1. Reconcile any uncertain sends across all users
    const reconcileResults = await reconcileUncertainSends();

    // 2. Claim verified or ready applications across users fairly
    // Pick up to 5 applications per user, up to 15 total
    const verifiedApps = await claimApplications('verified', 15, 3, 'send_worker');
    const readyApps = await claimApplications('ready', 15, 3, 'send_worker');
    const allApps = [...verifiedApps, ...readyApps];

    let authorizedCount = 0;
    let sentCount = 0;
    let dryRunCount = 0;
    let skippedCount = 0;

    for (const app of allApps) {
      if (!app.claim_token) continue;

      const authRes = await authorizeSend(app.user_id, app.id, app.claim_token);

      if (authRes.isDryRun) {
        dryRunCount++;
        continue;
      }

      if (!authRes.authorized || !authRes.attemptId) {
        skippedCount++;
        continue;
      }

      authorizedCount++;
      const sendRes = await executeSend(app.user_id, authRes.attemptId);
      if (sendRes.success) {
        sentCount++;
      }
    }

    return NextResponse.json({
      ok: true,
      reconciliation: reconcileResults,
      claimed: allApps.length,
      authorized: authorizedCount,
      sent: sentCount,
      dryRuns: dryRunCount,
      skipped: skippedCount,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('Error in send cron:', err);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
