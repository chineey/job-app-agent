require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function inspect() {
  try {
    const jobs = await sql`
      select id, post_id, role, company, contact_email, status, apply_method, source, created_at 
      from jobs 
      order by created_at desc 
      limit 3
    `;
    const settings = await sql`
      select * from user_settings 
      where user_id = '9c8a2409-8085-4772-8818-84c16b5dfa43'
    `;
    console.log('User settings:', settings);

    const user = await sql`
      select id, status, gmail_status, telegram_chat_id 
      from users 
      where id = '9c8a2409-8085-4772-8818-84c16b5dfa43'
    `;
    console.log('User:', user);

    // Unlock the application so send_worker can claim it
    await sql`
      update applications
      set locked_at = null, lock_owner = null, claim_token = null
      where id = '5089ce95-b5d7-4d23-976a-6d3cd81fc08f';
    `;
    console.log('Unlocked application 5089ce95-b5d7-4d23-976a-6d3cd81fc08f');

    // Call /api/cron/send
    const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
    const CRON_SECRET = process.env.CRON_SECRET || 'd7c9e00d19b3f3376fce8ae9a3904858';
    
    console.log('Calling /api/cron/send...');
    const sendRes = await fetch(`${BASE_URL}/api/cron/send`, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` }
    });
    const sendJson = await sendRes.json();
    console.log('Send response:', sendJson);

    const appStateAfter = await sql`
      select id, status, locked_at, lock_owner, claim_token, applied_at, status_reason
      from applications 
      where id = '5089ce95-b5d7-4d23-976a-6d3cd81fc08f'
    `;
    console.log('App state after send:', appStateAfter);
  } catch (err) {
    console.error('Inspect error:', err);
  } finally {
    process.exit(0);
  }
}

inspect();
