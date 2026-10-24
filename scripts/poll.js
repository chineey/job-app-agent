/**
 * Local Polling Runner for Development
 * 
 * Instead of needing complex tunnels (ngrok/localtunnel), this script
 * uses Telegram's getUpdates API to receive your messages directly
 * and forwards them to your local app running at http://localhost:3000.
 */

require('dotenv').config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET_TOKEN = process.env.TELEGRAM_WEBHOOK_SECRET;
const LOCAL_API_URL = 'http://localhost:3000/api/telegram';

if (!BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN is missing in .env');
  process.exit(1);
}

let lastUpdateId = 0;

async function deleteWebhook() {
  console.log('Clearing old webhook to enable local polling...');
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=false`);
}

async function pollUpdates() {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        console.log(`\n[Telegram Message Received] from: ${update.message?.from?.first_name || 'User'} (${update.message?.chat?.id})`);
        console.log(`Text: "${update.message?.text || update.message?.caption || '(Document/Media)'}"`);

        // Forward to local Next.js route
        try {
          const forwardRes = await fetch(LOCAL_API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-telegram-bot-api-secret-token': SECRET_TOKEN || '',
            },
            body: JSON.stringify(update),
          });
          const result = await forwardRes.json();
          console.log(`[Handled by App]: status ${forwardRes.status}`, result);
        } catch (postErr) {
          console.error(`Failed to forward update to ${LOCAL_API_URL}:`, postErr.message);
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Polling error:', err.message);
    }
  }

  // Continue polling loop
  setImmediate(pollUpdates);
}

async function start() {
  await deleteWebhook();
  console.log('🤖 Telegram Bot Local Runner is LIVE!');
  console.log('Listening for your Telegram messages and forwarding to http://localhost:3000/api/telegram...');
  console.log('You can now message @jobappagentv1bot on Telegram!\n');
  pollUpdates();
}

start();
