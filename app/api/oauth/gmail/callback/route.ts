import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { connectGmail, type ConnectResult } from '@/lib/gmail';
import { sendTelegramMessage } from '@/lib/telegram';

export const dynamic = 'force-dynamic';

const RETRY = 'Run /connect in Telegram to try again.';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(status: number, title: string, message: string): NextResponse {
  return new NextResponse(
    `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
  <body style="font-family: sans-serif; text-align: center; padding: 50px;">
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(message)}</p>
  </body>
</html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

/** What the user is told in Telegram and in the browser for each outcome. */
function describe(result: ConnectResult): { status: number; title: string; page: string; telegram: string } {
  switch (result.outcome) {
    case 'connected':
      return {
        status: 200,
        title: 'Gmail connected',
        page: `Connected as ${result.gmailAddress}. You can close this window and return to Telegram.`,
        telegram:
          `🎉 *Gmail Connected Successfully!*\n\n` +
          `Connected account: \`${result.gmailAddress}\`\n\n` +
          `Applications will now be delivered directly from your personal inbox.`,
      };
    case 'missing_scopes':
      return {
        status: 400,
        title: 'Permissions missing',
        page: `Google did not grant every permission the agent needs, so nothing was saved. ${RETRY}`,
        telegram:
          `⚠️ *Gmail was not connected.* Google did not grant every permission the agent needs ` +
          `(send, read and compose). Run \`/connect\` again and leave every box ticked.`,
      };
    case 'no_refresh_token':
      return {
        status: 400,
        title: 'Connection incomplete',
        page: 'Google did not return a long-lived token. Remove this app from your Google Account permissions, then run /connect again.',
        telegram:
          `⚠️ *Google skipped returning a refresh token.*\n\n` +
          `Please visit your Google Account Permissions page, remove this app, and type \`/connect\` again.`,
      };
    case 'address_in_use':
      return {
        status: 409,
        title: 'Address already connected',
        page: 'That Gmail address is already connected to another user of this agent.',
        telegram: '⚠️ *Gmail was not connected.* That address is already connected to another user. Each Gmail address can belong to one user.',
      };
    case 'live_attempts':
      return {
        status: 409,
        title: 'Send still open',
        page: 'A send from your current Gmail address is still in progress or unconfirmed. Settle it in Telegram first.',
        telegram:
          `⚠️ *Gmail address not changed.* A send from \`${result.currentAddress}\` is still in progress or unconfirmed. ` +
          `Settle it first (see \`/status\`), then reconnect with the new address.`,
      };
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  if (!state) {
    return page(400, 'Connection failed', `This link is incomplete. ${RETRY}`);
  }

  // Consume the state before anything else, so each /connect link works at most once.
  const [owner] = (await sql`
    update oauth_states o
    set used = true
    from users u
    where o.state = ${state} and o.used = false and o.expires_at > now()
      and u.id = o.user_id and u.status = 'active'
    returning o.user_id, u.telegram_chat_id
  `) as Array<{ user_id: string; telegram_chat_id: number }>;
  if (!owner) {
    return page(400, 'Link expired', `This link has expired or was already used. ${RETRY}`);
  }

  if (searchParams.get('error') || !code) {
    return page(400, 'Connection cancelled', `Google did not grant access. ${RETRY}`);
  }

  let result: ConnectResult;
  try {
    result = await connectGmail(owner.user_id, code);
  } catch (err) {
    console.error('Gmail OAuth callback failed:', err);
    return page(500, 'Connection failed', `Something went wrong while connecting Gmail. ${RETRY}`);
  }

  const view = describe(result);
  await sendTelegramMessage(owner.telegram_chat_id, view.telegram);
  return page(view.status, view.title, view.page);
}
