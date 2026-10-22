import { NextRequest, NextResponse } from 'next/server';

const CRON_SECRET = process.env.CRON_SECRET || '';

/**
 * Validates that an incoming cron request carries the expected Bearer token.
 */
export function authorizeCronRequest(req: NextRequest): boolean {
  if (!CRON_SECRET) {
    // In dev mode without CRON_SECRET, allow local requests
    return process.env.NODE_ENV !== 'production';
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7).trim();
  return token === CRON_SECRET;
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized: Invalid or missing CRON_SECRET' }, { status: 401 });
}
