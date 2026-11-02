import { google, gmail_v1, Auth } from 'googleapis';
import { decryptToken, encryptToken } from './crypto';
import { sql, withTransaction, logEvent } from './db';
import { getUserById } from './users';

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || '';
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_BASE_URL || 'http://localhost:3000'}/api/oauth/gmail/callback`;
// E2E only: point Google calls at a fake server. Unset in every real environment.
const GOOGLE_API_ROOT_URL = process.env.GOOGLE_API_ROOT_URL;
const GOOGLE_OAUTH_ROOT_URL = process.env.GOOGLE_OAUTH_ROOT_URL;

/** Every scope the agent needs; a connection missing any of them is refused. */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

export function getOAuth2Client() {
  return new google.auth.OAuth2({
    clientId: GMAIL_CLIENT_ID,
    clientSecret: GMAIL_CLIENT_SECRET,
    redirectUri: GOOGLE_REDIRECT_URI,
    endpoints: GOOGLE_OAUTH_ROOT_URL
      ? { oauth2TokenUrl: `${GOOGLE_OAUTH_ROOT_URL}/token`, oauth2RevokeUrl: `${GOOGLE_OAUTH_ROOT_URL}/revoke` }
      : undefined,
  });
}

/** Gmail client for an OAuth client that already holds credentials (used by the OAuth callback). */
export function gmailClientFor(auth: Auth.OAuth2Client): gmail_v1.Gmail {
  return google.gmail({ version: 'v1', auth, rootUrl: GOOGLE_API_ROOT_URL });
}

/**
 * Returns the HTTP status Google answered with, or null when no response arrived
 * (timeout, dropped connection). Only a 4xx proves the request was rejected.
 */
export function httpStatusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('response' in err)) return null;
  const response = err.response;
  if (typeof response !== 'object' || response === null || !('status' in response)) return null;
  return typeof response.status === 'number' ? response.status : null;
}

/**
 * Instantiates an authenticated Gmail API client for a given user.
 */
export async function getGmailClientForUser(
  userId: string
): Promise<{ gmail: gmail_v1.Gmail; auth: Auth.OAuth2Client; userEmail: string }> {
  const user = await getUserById(userId);
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  if (!user.gmail_refresh_token_enc || user.gmail_status !== 'connected') {
    throw new Error(`User ${userId} does not have an active Gmail connection.`);
  }

  const refreshToken = decryptToken(user.gmail_refresh_token_enc);
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return { gmail: gmailClientFor(oauth2Client), auth: oauth2Client, userEmail: user.gmail_address || '' };
}

/**
 * Builds an RFC 2822 compliant MIME message string, optionally attaching a PDF file.
 */
export function buildMimeMessage(params: {
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  rfcMessageId: string;
  pdfAttachment?: {
    filename: string;
    contentBuffer: Buffer;
  };
}): string {
  const boundary = `====_JobAppAgent_${Date.now()}_====`;
  const cleanMessageId = params.rfcMessageId.replace(/^<|>$/g, '');

  const headers = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${cleanMessageId}>`,
    'MIME-Version: 1.0',
  ];

  if (!params.pdfAttachment) {
    // Simple plain text message
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: 7bit');
    return `${headers.join('\r\n')}\r\n\r\n${params.bodyText}`;
  }

  // Multipart mixed for email body + resume PDF attachment
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const mimeParts = [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    params.bodyText,
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${params.pdfAttachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${params.pdfAttachment.filename}"`,
    '',
    params.pdfAttachment.contentBuffer.toString('base64'),
    '',
    `--${boundary}--`,
  ];

  return mimeParts.join('\r\n');
}

/**
 * Encodes an RFC 2822 string into URL-safe base64 format required by Gmail API.
 */
export function encodeBase64Url(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Sends a message via Gmail API.
 */
export async function sendGmailRawMessage(
  gmail: gmail_v1.Gmail,
  rawMime: string
): Promise<{ id: string; threadId: string }> {
  const rawBase64Url = encodeBase64Url(rawMime);
  // A retried POST could deliver the same email twice, so the HTTP client must never retry it.
  const res = await gmail.users.messages.send(
    {
      userId: 'me',
      requestBody: {
        raw: rawBase64Url,
      },
    },
    { retry: false }
  );

  if (!res.data.id || !res.data.threadId) {
    throw new Error('Gmail API send returned no message ID or thread ID.');
  }

  return {
    id: res.data.id,
    threadId: res.data.threadId,
  };
}

/**
 * Searches the user's Sent mail for an exact Message-ID header to reconcile uncertain sends.
 */
export async function searchSentMailByMessageId(
  gmail: gmail_v1.Gmail,
  rfcMessageId: string
): Promise<{ id: string; threadId: string; internalDate: string } | null> {
  const cleanId = rfcMessageId.replace(/^<|>$/g, '');
  const query = `in:sent rfc822msgid:${cleanId}`;

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 1,
  });

  const messages = listRes.data.messages;
  if (!messages || messages.length === 0 || !messages[0].id) {
    return null;
  }

  const msgRes = await gmail.users.messages.get({
    userId: 'me',
    id: messages[0].id,
    format: 'metadata',
  });

  return {
    id: msgRes.data.id || messages[0].id,
    threadId: msgRes.data.threadId || messages[0].threadId || '',
    internalDate: msgRes.data.internalDate || new Date().toISOString(),
  };
}

/**
 * Searches user's mailbox for bounce notifications from mailer-daemon or postmaster.
 */
export async function searchBounces(
  gmail: gmail_v1.Gmail
): Promise<Array<{ id: string; threadId: string; snippet: string; body: string }>> {
  const query = 'from:mailer-daemon OR from:postmaster newer_than:2d';
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 10,
  });

  const messages = listRes.data.messages || [];
  const results: Array<{ id: string; threadId: string; snippet: string; body: string }> = [];

  for (const m of messages) {
    if (!m.id) continue;
    try {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'full',
      });
      results.push({
        id: m.id,
        threadId: detail.data.threadId || '',
        snippet: detail.data.snippet || '',
        body: detail.data.snippet || '',
      });
    } catch {
      // Skip message if read error occurs
    }
  }

  return results;
}

/**
 * Reads messages in a specific thread to detect new inbound recruiter responses.
 */
export async function getThreadInboundMessages(
  gmail: gmail_v1.Gmail,
  threadId: string,
  userEmail: string
): Promise<Array<{ id: string; from: string; snippet: string; text: string; date: string }>> {
  const threadRes = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full',
  });

  const messages = threadRes.data.messages || [];
  const inbound: Array<{ id: string; from: string; snippet: string; text: string; date: string }> = [];

  for (const m of messages) {
    const headers = m.payload?.headers || [];
    const fromHeader = headers.find((h) => h.name?.toLowerCase() === 'from')?.value || '';
    const dateHeader = headers.find((h) => h.name?.toLowerCase() === 'date')?.value || '';

    // Ignore messages sent by candidate themselves
    if (userEmail && fromHeader.toLowerCase().includes(userEmail.toLowerCase())) {
      continue;
    }

    inbound.push({
      id: m.id || '',
      from: fromHeader,
      snippet: m.snippet || '',
      text: m.snippet || '',
      date: dateHeader,
    });
  }

  return inbound;
}

/**
 * Creates a Gmail draft in an existing application thread.
 */
export async function createGmailDraft(
  gmail: gmail_v1.Gmail,
  params: {
    to: string;
    from: string;
    subject: string;
    bodyText: string;
    threadId: string;
  }
): Promise<{ id: string; messageId: string }> {
  const rawMime = [
    `To: ${params.to}`,
    `From: ${params.from}`,
    `Subject: ${params.subject}`,
    `In-Reply-To: ${params.threadId}`,
    `References: ${params.threadId}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    params.bodyText,
  ].join('\r\n');

  const draftRes = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw: encodeBase64Url(rawMime),
        threadId: params.threadId,
      },
    },
  });

  return {
    id: draftRes.data.id || '',
    messageId: draftRes.data.message?.id || '',
  };
}

/**
 * Revokes a plaintext refresh token with Google. Returns whether Google confirmed it.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  try {
    await getOAuth2Client().revokeToken(refreshToken);
    return true;
  } catch (err) {
    console.error('Google did not confirm the token revoke:', httpStatusOf(err) ?? err);
    return false;
  }
}

export type DisconnectResult = 'revoked' | 'not_confirmed' | 'not_connected';

/**
 * Revokes the user's Gmail access with Google, then deletes our copy of the token either way:
 * a token we can no longer revoke is still safer gone. The result says what Google confirmed.
 */
export async function disconnectGmail(userId: string): Promise<DisconnectResult> {
  const user = await getUserById(userId);
  if (!user?.gmail_refresh_token_enc) {
    return 'not_connected';
  }

  let revoked = false;
  try {
    revoked = await revokeRefreshToken(decryptToken(user.gmail_refresh_token_enc));
  } catch (err) {
    console.error(`Could not decrypt the Gmail token of user ${userId} for revoking:`, err);
  }

  await sql`
    update users
    set gmail_refresh_token_enc = null, gmail_address = null, gmail_status = 'disconnected'
    where id = ${userId}
  `;
  await logEvent(userId, 'gmail_disconnected', { revoked });
  return revoked ? 'revoked' : 'not_confirmed';
}

export type ConnectResult =
  | { outcome: 'connected'; gmailAddress: string }
  | { outcome: 'missing_scopes'; missing: string[] }
  | { outcome: 'no_refresh_token' }
  | { outcome: 'address_in_use' }
  | { outcome: 'live_attempts'; currentAddress: string };

/**
 * Exchanges an OAuth code and stores the encrypted refresh token, unless the grant is incomplete,
 * the address belongs to another user, or switching address would strand an unsettled send.
 * Rejected grants are not revoked: revoking would also end any other connection to that Google account.
 */
export async function connectGmail(userId: string, code: string): Promise<ConnectResult> {
  const auth = getOAuth2Client();
  const { tokens } = await auth.getToken(code);

  const granted = new Set((tokens.scope ?? '').split(' '));
  const missing = GMAIL_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    return { outcome: 'missing_scopes', missing };
  }
  if (!tokens.refresh_token) {
    return { outcome: 'no_refresh_token' };
  }

  auth.setCredentials(tokens);
  const profile = await gmailClientFor(auth).users.getProfile({ userId: 'me' });
  const gmailAddress = profile.data.emailAddress;
  if (!gmailAddress) {
    throw new Error('Google returned no email address for the connected account.');
  }
  // Encrypt before any write, so a missing or bad key stores nothing.
  const encryptedToken = encryptToken(tokens.refresh_token);

  const result = await withTransaction(async (tx): Promise<ConnectResult> => {
    const [current] = (await tx`
      select gmail_address from users where id = ${userId} for update
    `) as Array<{ gmail_address: string | null }>;

    const [taken] = await tx`
      select 1 from users where lower(gmail_address) = lower(${gmailAddress}) and id <> ${userId}
    `;
    if (taken) {
      return { outcome: 'address_in_use' };
    }

    // Reconciliation searches the mailbox that sent a message, so it must not change under an open send.
    const switching = current.gmail_address !== null && current.gmail_address.toLowerCase() !== gmailAddress.toLowerCase();
    if (switching) {
      const [live] = await tx`
        select 1 from send_attempts
        where user_id = ${userId} and state in ('reserved', 'sending', 'send_unknown')
        limit 1
      `;
      if (live) {
        return { outcome: 'live_attempts', currentAddress: current.gmail_address ?? '' };
      }
    }

    await tx`
      update users
      set gmail_address = ${gmailAddress},
          gmail_refresh_token_enc = ${encryptedToken},
          gmail_status = 'connected',
          gmail_connected_at = now()
      where id = ${userId}
    `;
    return { outcome: 'connected', gmailAddress };
  });

  await logEvent(userId, 'gmail_connect', { outcome: result.outcome, gmailAddress });
  return result;
}
