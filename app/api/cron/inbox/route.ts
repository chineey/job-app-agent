import { NextRequest, NextResponse } from 'next/server';
import { authorizeCronRequest, unauthorizedResponse } from '@/lib/auth';
import { sql } from '@/lib/db';
import { getGmailClientForUser, httpStatusOf } from '@/lib/gmail';
import { scanUserInbox, type InboxUser } from '@/lib/inbox';
import { pauseForLostGmailAccess } from '@/lib/ramp';

export const dynamic = 'force-dynamic';
// Outbound calls are reads of fresh mail and Telegram alerts; never serve one from Next's fetch cache.
export const fetchCache = 'force-no-store';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!authorizeCronRequest(req)) {
    return unauthorizedResponse();
  }

  try {
    // Up to 5 active connected users per run, least recently scanned first.
    const users = (await sql`
      select u.id, u.telegram_chat_id, u.gmail_address, s.availability_note
      from users u
      join user_settings s on s.user_id = u.id
      where u.status = 'active' and u.gmail_status = 'connected'
      order by u.last_inbox_scan_at asc nulls first
      limit 5
    `) as InboxUser[];

    const totals = { bouncesFound: 0, repliesFound: 0, draftsCreated: 0, accessLost: 0 };

    for (const user of users) {
      try {
        const { gmail, auth } = await getGmailClientForUser(user.id);
        try {
          await auth.getAccessToken();
        } catch (err) {
          const status = httpStatusOf(err);
          if (status !== null && status >= 400 && status < 500) {
            await pauseForLostGmailAccess(user.id);
            totals.accessLost++;
            continue;
          }
          throw err;
        }

        const counts = await scanUserInbox(gmail, user);
        totals.bouncesFound += counts.bounces;
        totals.repliesFound += counts.replies;
        totals.draftsCreated += counts.drafts;
      } catch (userErr) {
        console.error(`Inbox scan error for user ${user.id}:`, userErr);
      } finally {
        // Even a failing user moves to the back of the rotation, so they cannot starve the others.
        await sql`update users set last_inbox_scan_at = now() where id = ${user.id}`;
      }
    }

    return NextResponse.json({ ok: true, scannedUsers: users.length, ...totals });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('Inbox cron error:', err);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
