import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { claimTelegramUpdate, handleTelegramMessage, handleTelegramDocument } from '@/lib/telegram';

const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

// Fails closed: with no secret configured, nothing is accepted.
function hasValidSecret(req: NextRequest): boolean {
  const provided = req.headers.get('x-telegram-bot-api-secret-token');
  if (!TELEGRAM_WEBHOOK_SECRET || provided === null) return false;
  // Hashing gives equal-length buffers, which timingSafeEqual requires.
  const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(provided), digest(TELEGRAM_WEBHOOK_SECRET));
}

export async function POST(req: NextRequest) {
  if (!hasValidSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized webhook secret' }, { status: 401 });
  }

  try {
    const update = await req.json();
    const message = update.message;

    // In a group, chat.id is the group, so anyone in it would act as one user. Only private chats count.
    if (typeof update.update_id !== 'number' || message?.chat?.type !== 'private') {
      return NextResponse.json({ ok: true });
    }
    if (!(await claimTelegramUpdate(update.update_id))) {
      return NextResponse.json({ ok: true, duplicate: true });
    }

    const chatId: number = message.chat.id;
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
