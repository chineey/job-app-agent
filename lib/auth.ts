import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

const CRON_SECRET = process.env.CRON_SECRET || '';

/**
 * Compares a provided secret with the configured one in constant time.
 * Fails closed: with no configured secret, nothing matches.
 */
export function secretsMatch(provided: string | null, expected: string): boolean {
  if (!expected || provided === null) return false;
  // Hashing gives equal-length buffers, which timingSafeEqual requires.
  const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

/**
 * Validates that an incoming cron request carries the expected Bearer token.
 */
export function authorizeCronRequest(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  return secretsMatch(token, CRON_SECRET);
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized: Invalid or missing CRON_SECRET' }, { status: 401 });
}
