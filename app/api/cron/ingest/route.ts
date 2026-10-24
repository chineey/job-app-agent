import { NextRequest, NextResponse } from 'next/server';
import { authorizeCronRequest, unauthorizedResponse } from '@/lib/auth';
import { searchRecentJobPosts } from '@/lib/x';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Cheap pre-filter (Section 7.1):
 * Drop posts with no apply signal in text, but keep posts with images even if text is thin.
 */
function passesPreFilter(text: string, mediaCount: number): boolean {
  if (mediaCount > 0) return true;
  const lower = text.toLowerCase();
  const applySignals = [
    'apply', 'hiring', 'email', 'dm', 'cv', 'resume', 'reach out', 'send', 'role', 'jobs', 'careers'
  ];
  return applySignals.some((signal) => lower.includes(signal));
}

export async function GET(req: NextRequest) {
  if (!authorizeCronRequest(req)) {
    return unauthorizedResponse();
  }

  try {
    // 1. Get highest post_id seen so far to pass as sinceId
    const highestRow = (await sql`
      select post_id from jobs order by created_at desc limit 1
    `) as { post_id: string }[];
    const sinceId = highestRow.length > 0 ? highestRow[0].post_id : undefined;

    // 2. Query X API v2
    const searchResult = await searchRecentJobPosts(sinceId, 10);
    let insertedCount = 0;

    for (const tweet of searchResult.tweets) {
      const mediaUrls = searchResult.mediaUrls[tweet.id] || [];

      // Pre-filter check
      if (!passesPreFilter(tweet.text, mediaUrls.length)) {
        continue;
      }

      const postUrl = `https://x.com/i/web/status/${tweet.id}`;

      // Insert into jobs with conflict prevention
      const res = await sql`
        insert into jobs (
          post_id,
          post_url,
          raw_text,
          media_urls,
          conversation_id,
          author_id,
          status
        )
        values (
          ${tweet.id},
          ${postUrl},
          ${tweet.text},
          ${JSON.stringify(mediaUrls)},
          ${tweet.conversation_id || null},
          ${tweet.author_id || null},
          'found'
        )
        on conflict (post_id) do nothing
        returning id;
      `;

      if (res.length > 0) {
        insertedCount++;
      }
    }

    return NextResponse.json({
      success: true,
      tweetsFetched: searchResult.readCount,
      jobsInserted: insertedCount,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Ingest cron error:', err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
