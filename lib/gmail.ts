import { google, gmail_v1 } from 'googleapis';
import { decryptToken } from './crypto';
import { getUserById } from './users';

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || '';
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_BASE_URL || 'http://localhost:3000'}/api/oauth/gmail/callback`;

export function getOAuth2Client() {
  return new google.auth.OAuth2(
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

/**
 * Instantiates an authenticated Gmail API client for a given user.
 */
export async function getGmailClientForUser(userId: string): Promise<{ gmail: gmail_v1.Gmail; userEmail: string }> {
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

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  return { gmail, userEmail: user.gmail_address || '' };
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
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: rawBase64Url,
    },
  });

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
 * Revokes Google OAuth token.
 */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return res.ok;
  } catch {
    return false;
  }
}
