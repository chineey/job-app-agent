import { NextRequest, NextResponse } from 'next/server';
import { authorizeCronRequest, unauthorizedResponse } from '@/lib/auth';
import { sql } from '@/lib/db';
import { evaluateRampProgression, getUserSettings } from '@/lib/users';
import { sendTelegramMessage } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID, 10) : null;

export async function GET(req: NextRequest) {
  if (!authorizeCronRequest(req)) {
    return unauthorizedResponse();
  }

  try {
    const activeUsers = (await sql`
      select u.id, u.telegram_chat_id, u.display_name, u.telegram_username, u.last_summary_on, s.timezone, s.current_cap
      from users u
      join user_settings s on u.id = s.user_id
      where u.status = 'active';
    `) as Array<{
      id: string;
      telegram_chat_id: number;
      display_name: string | null;
      telegram_username: string | null;
      last_summary_on: string | null;
      timezone: string;
      current_cap: number;
    }>;

    let userSummariesSent = 0;
    let rampPromotions = 0;

    for (const user of activeUsers) {
      try {
        const userTz = user.timezone || 'UTC';

        // Get local date and hour
        const hourFormatter = new Intl.DateTimeFormat('en-US', { timeZone: userTz, hour: 'numeric', hour12: false });
        const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: userTz }); // YYYY-MM-DD
        const localHour = parseInt(hourFormatter.format(new Date()), 10);
        const todayStr = dateFormatter.format(new Date());

        // Send summary when local hour passes 20:00 (8 PM) and not yet sent today
        if (localHour >= 20 && user.last_summary_on !== todayStr) {
          // Gather stats for today in user's timezone
          const sendsToday = (await sql`
            select count(*)::int as count
            from send_attempts
            where user_id = ${user.id} and state = 'sent'
              and (reserved_at at time zone ${userTz})::date = ${todayStr}::date;
          `) as { count: number }[];

          const repliesToday = (await sql`
            select count(*)::int as count
            from applications
            where user_id = ${user.id} and reply_type is not null
              and (last_reply_at at time zone ${userTz})::date = ${todayStr}::date;
          `) as { count: number }[];

          const bouncesToday = (await sql`
            select count(*)::int as count
            from applications
            where user_id = ${user.id} and status = 'bounced'
              and (updated_at at time zone ${userTz})::date = ${todayStr}::date;
          `) as { count: number }[];

          // Evaluate ramp advancement
          const rampRes = await evaluateRampProgression(user.id);
          if (rampRes.changed) {
            rampPromotions++;
          }

          if (user.telegram_chat_id) {
            const summaryMsg = [
              `🌙 *Daily Application Summary (${todayStr})*`,
              '',
              `• *Delivered Today:* ${sendsToday[0].count} / ${user.current_cap}`,
              `• *Recruiter Replies:* ${repliesToday[0].count}`,
              `• *Bounces:* ${bouncesToday[0].count}`,
              rampRes.message ? `\n${rampRes.message}` : '',
              '',
              `_Rest well! Pipeline resumes tomorrow morning during your scheduled window._`,
            ]
              .filter(Boolean)
              .join('\n');

            await sendTelegramMessage(user.telegram_chat_id, summaryMsg);
          }

          await sql`
            update users set last_summary_on = ${todayStr}::date where id = ${user.id};
          `;
          userSummariesSent++;
        }
      } catch (userErr) {
        console.error(`Error generating daily summary for user ${user.id}:`, userErr);
      }
    }

    // Daily Admin Summary: sent at 21:00 UTC once daily
    const utcHour = new Date().getUTCHours();
    if (utcHour === 21 && ADMIN_CHAT_ID) {
      const totalSentToday = (await sql`
        select count(*)::int as count
        from send_attempts
        where state = 'sent' and (reserved_at at time zone 'UTC')::date = current_date;
      `) as { count: number }[];

      const pausedUsers = (await sql`
        select count(*)::int as count
        from user_settings
        where paused = true;
      `) as { count: number }[];

      await sendTelegramMessage(
        ADMIN_CHAT_ID,
        `👑 *Admin Daily Briefing*\n\n` +
          `• *Active Users:* ${activeUsers.length}\n` +
          `• *Total Sent Across Users Today:* ${totalSentToday[0].count}\n` +
          `• *Currently Paused Users:* ${pausedUsers[0].count}\n` +
          `• *Ramp Promotions Today:* ${rampPromotions}`
      );
    }

    return NextResponse.json({
      ok: true,
      activeUsers: activeUsers.length,
      summariesSent: userSummariesSent,
      rampPromotions,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('Summary cron error:', err);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
