import { sql } from './db';

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || '';
const READ_COST_PER_POST = 0.005; // ~$0.005 per read on X v2 API

export interface XMedia {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
}

export interface XTweet {
  id: string;
  text: string;
  author_id?: string;
  conversation_id?: string;
  created_at?: string;
  attachments?: {
    media_keys?: string[];
  };
}

export interface XSearchResult {
  tweets: XTweet[];
  mediaUrls: Record<string, string[]>; // tweet_id -> media urls
  readCount: number;
  highestId?: string;
}

/**
 * Searches X API v2 for recent software engineering job posts within budget constraints.
 */
export async function searchRecentJobPosts(
  sinceId?: string,
  maxResults: number = 10
): Promise<XSearchResult> {
  // Check daily spend limit first
  const canRead = await checkAndReserveXReads(maxResults);
  if (!canRead) {
    console.warn('X daily read cap reached or budget exceeded. Ingest skipped.');
    return { tweets: [], mediaUrls: {}, readCount: 0 };
  }

  const query = '("hiring" OR "we are hiring" OR "send your CV" OR "send your resume" OR "apply via email") (developer OR engineer OR "full stack" OR backend OR frontend OR "AI engineer" OR devops OR "software") -is:retweet -is:reply lang:en';

  const url = new URL('https://api.twitter.com/2/tweets/search/recent');
  url.searchParams.set('query', query);
  url.searchParams.set('max_results', Math.min(Math.max(maxResults, 10), 100).toString());
  url.searchParams.set('tweet.fields', 'conversation_id,author_id,in_reply_to_user_id,referenced_tweets,created_at,attachments');
  url.searchParams.set('expansions', 'attachments.media_keys,author_id');
  url.searchParams.set('media.fields', 'url,preview_image_url,type');
  url.searchParams.set('user.fields', 'username');

  if (sinceId) {
    url.searchParams.set('since_id', sinceId);
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${X_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`X API search error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const tweets: XTweet[] = data.data || [];
  const mediaList: XMedia[] = data.includes?.media || [];

  // Map media keys to URLs
  const mediaKeyMap: Record<string, string> = {};
  for (const m of mediaList) {
    if (m.url) {
      mediaKeyMap[m.media_key] = m.url;
    } else if (m.preview_image_url) {
      mediaKeyMap[m.media_key] = m.preview_image_url;
    }
  }

  // Map tweet ID to attached media URLs
  const mediaUrlsByTweet: Record<string, string[]> = {};
  for (const tweet of tweets) {
    const keys = tweet.attachments?.media_keys || [];
    mediaUrlsByTweet[tweet.id] = keys
      .map((k) => mediaKeyMap[k])
      .filter((u): u is string => Boolean(u));
  }

  // Log spend for the reads performed
  await recordXReads(tweets.length);

  return {
    tweets,
    mediaUrls: mediaUrlsByTweet,
    readCount: tweets.length,
    highestId: tweets.length > 0 ? tweets[0].id : undefined,
  };
}

/**
 * Expands author-only conversation threads (Section 7.1a).
 * Searches only posts authored by the original poster to avoid third-party scam replies.
 */
export async function expandAuthorThread(
  conversationId: string,
  authorUsername: string,
  maxPosts: number = 10
): Promise<{ threadText: string; mediaUrls: string[]; threadPostIds: string[] }> {
  const query = `conversation_id:${conversationId} from:${authorUsername} -is:retweet`;

  const url = new URL('https://api.twitter.com/2/tweets/search/recent');
  url.searchParams.set('query', query);
  url.searchParams.set('max_results', Math.min(Math.max(maxPosts, 10), 100).toString());
  url.searchParams.set('tweet.fields', 'conversation_id,author_id,created_at,attachments');
  url.searchParams.set('expansions', 'attachments.media_keys');
  url.searchParams.set('media.fields', 'url,type');

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${X_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    return { threadText: '', mediaUrls: [], threadPostIds: [] };
  }

  const data = await res.json();
  const tweets: XTweet[] = data.data || [];
  const mediaList: XMedia[] = data.includes?.media || [];

  // Map media keys
  const mediaKeyMap: Record<string, string> = {};
  for (const m of mediaList) {
    if (m.url) mediaKeyMap[m.media_key] = m.url;
  }

  // Sort chronologically
  const sorted = [...tweets].sort((a, b) => a.id.localeCompare(b.id));

  const threadText = sorted.map((t) => t.text).join('\n\n');
  const threadPostIds = sorted.map((t) => t.id);
  const mediaUrls: string[] = [];

  for (const t of sorted) {
    for (const key of t.attachments?.media_keys || []) {
      if (mediaKeyMap[key]) mediaUrls.push(mediaKeyMap[key]);
    }
  }

  // Record reads
  await recordXReads(tweets.length);

  return {
    threadText,
    mediaUrls,
    threadPostIds,
  };
}

/**
 * Fetches a single post for manual paste ingestion.
 */
export async function fetchSinglePost(postId: string): Promise<{ tweet: XTweet; mediaUrls: string[]; authorUsername?: string } | null> {
  const url = new URL(`https://api.twitter.com/2/tweets/${postId}`);
  url.searchParams.set('tweet.fields', 'conversation_id,author_id,created_at,attachments');
  url.searchParams.set('expansions', 'attachments.media_keys,author_id');
  url.searchParams.set('media.fields', 'url,preview_image_url,type');
  url.searchParams.set('user.fields', 'username');

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${X_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) return null;

  const data = await res.json();
  const tweet: XTweet = data.data;
  if (!tweet) return null;

  const author = data.includes?.users?.[0]?.username;
  const mediaList: XMedia[] = data.includes?.media || [];
  const mediaUrls = mediaList.map((m) => m.url || m.preview_image_url).filter((u): u is string => Boolean(u));

  await recordXReads(1);

  return { tweet, mediaUrls, authorUsername: author };
}

/**
 * Checks whether the daily budget cap allows further reads.
 */
async function checkAndReserveXReads(desiredReads: number): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);

  // Read cap setting
  const capRow = (await sql`
    select value from global_settings where key = 'x_daily_read_cap' limit 1
  `) as { value: string }[];
  const dailyCap = capRow.length > 0 ? parseInt(capRow[0].value, 10) : 130;

  const spendRow = (await sql`
    select coalesce(x_reads, 0) as reads from spend where day = ${today} limit 1
  `) as { reads: number }[];

  const currentReads = spendRow.length > 0 ? Number(spendRow[0].reads) : 0;
  return currentReads + desiredReads <= dailyCap;
}

/**
 * Records reads and estimated cost in the spend table.
 */
async function recordXReads(count: number): Promise<void> {
  if (count <= 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const cost = count * READ_COST_PER_POST;

  await sql`
    insert into spend (day, x_reads, x_cost_est)
    values (${today}, ${count}, ${cost})
    on conflict (day) do update
    set x_reads = spend.x_reads + ${count},
        x_cost_est = spend.x_cost_est + ${cost}
  `;
}
