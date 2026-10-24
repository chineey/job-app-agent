import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { getOAuth2Client } from '@/lib/gmail';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const state = searchParams.get('state');

  if (!state) {
    return NextResponse.json({ error: 'Missing state parameter' }, { status: 400 });
  }

  // Validate state from oauth_states table
  const rows = (await sql`
    select * from oauth_states
    where state = ${state} and used = false and expires_at > now()
    limit 1;
  `) as Array<{ state: string; user_id: string }>;

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Invalid or expired state token. Please run /connect again in Telegram.' }, { status: 400 });
  }

  const oauth2Client = getOAuth2Client();
  const scopes = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state,
  });

  return NextResponse.redirect(authUrl);
}
