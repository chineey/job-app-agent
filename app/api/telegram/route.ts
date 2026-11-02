import { NextRequest, NextResponse } from 'next/server';
import { secretsMatch } from '@/lib/auth';
import { claimTelegramUpdate, handleTelegramMessage, handleTelegramDocument } from '@/lib/telegram';

const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

export async function POST(req: NextRequest) {
  if (!secretsMatch(req.headers.get('x-telegram-bot-api-secret-token'), TELEGRAM_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized webhook secret' }, { status: 401 });
  }

  try {
    const update = await req.json();
    const message = update.message;

    // In a group, chat.id is the group, so anyone in it would act as one user. Only private chats count.
    if (typeof update.update_id !== 'number' || message?.chat?.type !== 'private') {
      return NextResponse.json({ ok: true });
    }
    const chatId: number = message.chat.id;
    const claim = await claimTelegramUpdate(update.update_id, chatId);
    if (claim !== 'new') {
      return NextResponse.json({ ok: true, ignored: claim });
    }

    const username = message.from?.username;
    const displayName = `${message.from?.first_name || ''} ${message.from?.last_name || ''}`.trim();

    if (message.document) {
      await handleTelegramDocument(chatId, message.document, username, displayName);
    } else if (message.text) {
      await handleTelegramMessage(chatId, message.text, username, displayName);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Error handling Telegram webhook:', err);
    return NextResponse.json({ ok: true }); // Always return 200 to Telegram so it doesn't storm retries
  }
}
