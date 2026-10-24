import { NextRequest, NextResponse } from 'next/server';
import { handleTelegramMessage } from '@/lib/telegram';

const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

export async function POST(req: NextRequest) {
  // Validate Telegram webhook secret token
  if (TELEGRAM_WEBHOOK_SECRET) {
    const headerToken = req.headers.get('x-telegram-bot-api-secret-token');
    if (headerToken !== TELEGRAM_WEBHOOK_SECRET) {
      return NextResponse.json({ error: 'Unauthorized webhook secret' }, { status: 401 });
    }
  }

  try {
    const update = await req.json();
    const message = update.message;

    if (message && message.chat && message.text) {
      const chatId = message.chat.id;
      const text = message.text;
      const username = message.from?.username;
      const displayName = `${message.from?.first_name || ''} ${message.from?.last_name || ''}`.trim();

      await handleTelegramMessage(chatId, text, username, displayName);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Error handling Telegram webhook:', err);
    return NextResponse.json({ ok: true }); // Always return 200 to Telegram so it doesn't storm retries
  }
}
