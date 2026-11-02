import { NextRequest, NextResponse } from 'next/server';
import { authorizeCronRequest, unauthorizedResponse } from '@/lib/auth';
import { runSendPass } from '@/lib/send';
import { dispatchLinkApplications } from '@/lib/links';

export const dynamic = 'force-dynamic';
// Every outbound call here is a side effect or must be fresh; never serve one from Next's fetch cache.
export const fetchCache = 'force-no-store';
export const maxDuration = 60; // Up to 60 seconds

export async function GET(req: NextRequest) {
  if (!authorizeCronRequest(req)) {
    return unauthorizedResponse();
  }

  try {
    // Link applications are not sent from Gmail; their cards go out on the same schedule.
    const links = await dispatchLinkApplications();
    const pass = await runSendPass();

    return NextResponse.json({
      ok: true,
      links,
      reconciliation: pass.reconciliation,
      claimed: pass.claimed,
      dryRuns: pass.dryRuns,
      skipped: pass.skipped,
      errors: pass.errors,
      ...pass.outcomes,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('Error in send cron:', err);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
