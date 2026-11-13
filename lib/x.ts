import { sql } from './db';

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || '';
// E2E only: point X API calls at a fake server. Unset in every real environment.
const X_API_BASE_URL = process.env.X_API_BASE_URL || 'https://api.twitter.com';
const READ_COST_PER_POST = 0.005; // ~$0.005 per read on X v2 API

export interface XMedia {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
}

export interface XTweetUrlEntity {
  url: string;
  expanded_url?: string;
  display_url?: string;
  unwound_url?: string;
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
  entities?: {
    urls?: XTweetUrlEntity[];
  };
}

export interface XSearchResult {
  tweets: XTweet[];
  mediaUrls: Record<string, string[]>; // tweet_id -> media urls
  authorUsernames: Record<string, string>; // tweet_id -> author username
  applyLinks: Record<string, { applyLink: string | null; applyLinkDomain: string | null }>;
  readCount: number;
  highestId?: string;
}

const INTERNAL_X_HOSTS = new Set([
  'x.com',
  'twitter.com',
  't.co',
  'pic.twitter.com',
  'pic.x.com',
]);

function isExternalApplyUrl(rawUrl: string): { url: string; domain: string } | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    for (const internal of INTERNAL_X_HOSTS) {
      if (host === internal || host.endsWith(`.${internal}`)) {
        return null;
      }
    }
    return { url: parsed.toString(), domain: host };
  } catch {
    return null;
  }
}

/**
 * Expands t.co URLs in tweet text using X entities and extracts the first external apply link.
 */
export function extractLinksAndExpandText(tweet: XTweet): {
  expandedText: string;
  applyLink: string | null;
  applyLinkDomain: string | null;
} {
  let expandedText = tweet.text || '';
  let applyLink: string | null = null;
  let applyLinkDomain: string | null = null;

  for (const entity of tweet.entities?.urls || []) {
    const target = entity.unwound_url || entity.expanded_url;
    if (target && entity.url) {
      expandedText = expandedText.split(entity.url).join(target);
    }
    if (!applyLink && target) {
      const ext = isExternalApplyUrl(target);
      if (ext) {
        applyLink = ext.url;
        applyLinkDomain = ext.domain;
      }
    }
  }

  if (!applyLink) {
    const urlMatches = expandedText.match(/https?:\/\/[^\s<>)"']+/gi) || [];
    for (const candidate of urlMatches) {
      const cleaned = candidate.replace(/[.,;:!?]+$/, '');
      const ext = isExternalApplyUrl(cleaned);
      if (ext) {
        applyLink = ext.url;
        applyLinkDomain = ext.domain;
        break;
      }
    }
  }

  return { expandedText, applyLink, applyLinkDomain };
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
    return { tweets: [], mediaUrls: {}, authorUsernames: {}, applyLinks: {}, readCount: 0 };
  }

  const query = '("hiring" OR "we are hiring" OR "send your CV" OR "send your resume" OR "apply via email") (developer OR engineer OR "full stack" OR backend OR frontend OR "AI engineer" OR devops OR "software") -is:retweet -is:reply lang:en';

  const url = new URL(`${X_API_BASE_URL}/2/tweets/search/recent`);
  url.searchParams.set('query', query);
  url.searchParams.set('max_results', Math.min(Math.max(maxResults, 10), 100).toString());
  url.searchParams.set('tweet.fields', 'conversation_id,author_id,in_reply_to_user_id,referenced_tweets,created_at,attachments,entities');
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

  const usersList: Array<{ id: string; username?: string }> = data.includes?.users || [];
  const userMap: Record<string, string> = {};
  for (const u of usersList) {
    if (u.id && u.username) {
      userMap[u.id] = u.username;
    }
  }

  // Map tweet ID to attached media URLs, author usernames, and apply links
  const mediaUrlsByTweet: Record<string, string[]> = {};
  const authorUsernamesByTweet: Record<string, string> = {};
  const applyLinksByTweet: Record<string, { applyLink: string | null; applyLinkDomain: string | null }> = {};
  for (const tweet of tweets) {
    const { expandedText, applyLink, applyLinkDomain } = extractLinksAndExpandText(tweet);
    tweet.text = expandedText;
    applyLinksByTweet[tweet.id] = { applyLink, applyLinkDomain };

    if (tweet.author_id && userMap[tweet.author_id]) {
      authorUsernamesByTweet[tweet.id] = userMap[tweet.author_id];
    }

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
    authorUsernames: authorUsernamesByTweet,
    applyLinks: applyLinksByTweet,
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
): Promise<{
  threadText: string;
  mediaUrls: string[];
  threadPostIds: string[];
  applyLink: string | null;
  applyLinkDomain: string | null;
}> {
  const query = `conversation_id:${conversationId} from:${authorUsername} -is:retweet`;

  const url = new URL(`${X_API_BASE_URL}/2/tweets/search/recent`);
  url.searchParams.set('query', query);
  url.searchParams.set('max_results', Math.min(Math.max(maxPosts, 10), 100).toString());
  url.searchParams.set('tweet.fields', 'conversation_id,author_id,created_at,attachments,entities');
  url.searchParams.set('expansions', 'attachments.media_keys');
  url.searchParams.set('media.fields', 'url,type');

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${X_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    return { threadText: '', mediaUrls: [], threadPostIds: [], applyLink: null, applyLinkDomain: null };
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

  let threadApplyLink: string | null = null;
  let threadApplyLinkDomain: string | null = null;
  const expandedTexts: string[] = [];

  for (const t of sorted) {
    const { expandedText, applyLink, applyLinkDomain } = extractLinksAndExpandText(t);
    expandedTexts.push(expandedText);
    if (!threadApplyLink && applyLink) {
      threadApplyLink = applyLink;
      threadApplyLinkDomain = applyLinkDomain;
    }
  }

  const threadText = expandedTexts.join('\n\n');
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
    applyLink: threadApplyLink,
    applyLinkDomain: threadApplyLinkDomain,
  };
}

/**
 * Fetches a single post for manual paste ingestion.
 */
export async function fetchSinglePost(
  postId: string
): Promise<{
  tweet: XTweet;
  mediaUrls: string[];
  authorUsername?: string;
  applyLink: string | null;
  applyLinkDomain: string | null;
} | null> {
  const url = new URL(`${X_API_BASE_URL}/2/tweets/${postId}`);
  url.searchParams.set('tweet.fields', 'conversation_id,author_id,created_at,attachments,entities');
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

  const { expandedText, applyLink, applyLinkDomain } = extractLinksAndExpandText(tweet);
  tweet.text = expandedText;

  const author = data.includes?.users?.[0]?.username;
  const mediaList: XMedia[] = data.includes?.media || [];
  const mediaUrls = mediaList.map((m) => m.url || m.preview_image_url).filter((u): u is string => Boolean(u));

  await recordXReads(1);

  return { tweet, mediaUrls, authorUsername: author, applyLink, applyLinkDomain };
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
