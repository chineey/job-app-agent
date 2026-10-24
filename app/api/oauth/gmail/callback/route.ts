import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { sql, logEvent } from '@/lib/db';
import { getOAuth2Client } from '@/lib/gmail';
import { encryptToken } from '@/lib/crypto';
import { sendTelegramMessage } from '@/lib/telegram';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    return new NextResponse(`Google authorization error: ${error}`, { status: 400 });
  }

  if (!code || !state) {
    return new NextResponse('Missing code or state parameter.', { status: 400 });
  }

  // 1. Validate state
  const stateRows = (await sql`
    select o.*, u.telegram_chat_id
    from oauth_states o
    join users u on o.user_id = u.id
    where o.state = ${state} and o.used = false and o.expires_at > now()
    limit 1;
  `) as Array<{ state: string; user_id: string; telegram_chat_id: number }>;

  if (stateRows.length === 0) {
    return new NextResponse('Invalid or expired state token. Please run /connect again.', { status: 400 });
  }

  const { user_id: userId, telegram_chat_id: chatId } = stateRows[0];

  try {
    // 2. Exchange code for tokens
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    if (!tokens.refresh_token) {
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `⚠️ *Google skipped returning a refresh token.*\n\n` +
            `Please visit your Google Account Permissions page, remove this app, and type \`/connect\` again.`
        );
      }
      return new NextResponse('No refresh token received. Please revoke existing access and try again.', { status: 400 });
    }

    // 3. Get profile email
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const gmailAddress = profile.data.emailAddress || '';

    // 4. Encrypt refresh token with AES-256-GCM
    const encryptedToken = encryptToken(tokens.refresh_token);

    // 5. Update user and mark state used
    await sql`
      update users
      set gmail_address = ${gmailAddress},
          gmail_refresh_token_enc = ${encryptedToken},
          gmail_status = 'connected',
          gmail_connected_at = now()
      where id = ${userId};
    `;

    await sql`
      update oauth_states set used = true where state = ${state};
    `;

    await logEvent(userId, 'gmail_connected', { gmailAddress });

    // 6. Notify candidate in Telegram
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `🎉 *Gmail Connected Successfully!*\n\n` +
          `Connected account: \`${gmailAddress}\`\n\n` +
          `Applications will now be delivered directly from your personal inbox.`
      );
    }

    return new NextResponse(
      `<!DOCTYPE html>
      <html>
        <head><title>Gmail Connected</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h2 style="color: #10b981;">Gmail Connected Successfully!</h2>
          <p>Connected as <strong>${gmailAddress}</strong>.</p>
          <p>You can now close this window and return to Telegram.</p>
        </body>
      </html>`,
      { headers: { 'Content-Type': 'text/html' } }
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('OAuth callback error:', err);
    return new NextResponse(`OAuth authorization failed: ${errorMsg}`, { status: 500 });
  }
}
