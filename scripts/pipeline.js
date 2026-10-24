#!/usr/bin/env node

/**
 * End-to-End Pipeline Runner
 * Runs: Ingest (X API) -> Process (Gemini Extraction & Matching) -> Send (Gmail / Dry-Run Telegram)
 */

require('dotenv').config();

const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const CRON_SECRET = process.env.CRON_SECRET || 'd7c9e00d19b3f3376fce8ae9a3904858';

async function callEndpoint(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${CRON_SECRET}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} from ${path}: ${text}`);
  }

  return res.json();
}

async function main() {
  console.log('====================================================');
  console.log(' 🚀 Starting End-to-End Job Application Pipeline');
  console.log(` Target Server: ${BASE_URL}`);
  console.log('====================================================\n');

  // 1. INGEST
  console.log('▶ [1/3] Ingesting jobs from X (Twitter) API v2...');
  try {
    const ingestRes = await callEndpoint('/api/cron/ingest');
    console.log(`   ✓ Ingest Complete:`);
    console.log(`     • Tweets Searched: ${ingestRes.tweetsFetched || 0}`);
    console.log(`     • New Jobs Stored: ${ingestRes.jobsInserted || 0}\n`);
  } catch (err) {
    console.error(`   ✗ Ingest error: ${err.message}\n`);
  }

  // 2. PROCESS
  console.log('▶ [2/3] Processing jobs (Gemini Extraction & Fit Matching)...');
  try {
    const processRes = await callEndpoint('/api/cron/process');
    console.log(`   ✓ Processing Complete:`);
    console.log(`     • Jobs Extracted:   ${processRes.summary?.jobsExtracted ?? 0}`);
    console.log(`     • Jobs Fanned Out:  ${processRes.summary?.jobsFannedOut ?? 0}`);
    console.log(`     • Apps Matched:     ${processRes.summary?.applicationsMatched ?? 0}`);
    console.log(`     • Apps Tailored:    ${processRes.summary?.applicationsTailored ?? 0}`);
    console.log(`     • Apps Verified:    ${processRes.summary?.applicationsVerified ?? 0}\n`);
  } catch (err) {
    console.error(`   ✗ Process error: ${err.message}\n`);
  }

  // 3. SEND
  console.log('▶ [3/3] Running Send Dispatcher (Dry-Run / Live Send)...');
  try {
    const sendRes = await callEndpoint('/api/cron/send');
    console.log(`   ✓ Send Dispatcher Complete:`);
    console.log(`     • Applications Claimed:  ${sendRes.claimed ?? 0}`);
    console.log(`     • Dry-Run Notifications: ${sendRes.dryRuns ?? 0}`);
    console.log(`     • Live Emails Sent:      ${sendRes.sent ?? 0}`);
    console.log(`     • Skipped / Cap Limit:   ${sendRes.skipped ?? 0}\n`);
  } catch (err) {
    console.error(`   ✗ Send error: ${err.message}\n`);
  }

  console.log('====================================================');
  console.log(' ✅ Pipeline Run Finished!');
  console.log('====================================================\n');
}

main().catch((err) => {
  console.error('Fatal pipeline error:', err);
  process.exit(1);
});
