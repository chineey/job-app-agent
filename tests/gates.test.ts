import { describe, it, expect, vi } from 'vitest';
import {
  extractContactEmails,
  isDeadlineExpired,
  computeDedupeHash,
  evaluateSharedGates,
} from '../lib/gates';
import { JobExtract } from '../lib/schemas';

describe('Round 1 Shared Gates & Extraction Helpers', () => {
  describe('extractContactEmails', () => {
    it('extracts a single clean email from raw text', () => {
      const text = 'We are hiring! Send your portfolio and resume to jobs@example.com right away.';
      const res = extractContactEmails(text);
      expect(res.count).toBe(1);
      expect(res.primaryEmail).toBe('jobs@example.com');
    });

    it('extracts unique emails across raw, thread, and transcribed texts', () => {
      const raw = 'Looking for fullstack devs. Email below:';
      const thread = 'Send CV to CAREERS@TechCorp.io or visit site.';
      const transcribed = 'contact: careers@techcorp.io';
      const res = extractContactEmails(raw, thread, transcribed);
      expect(res.count).toBe(1);
      expect(res.primaryEmail).toBe('careers@techcorp.io');
    });

    it('flags multiple distinct emails', () => {
      const raw = 'Send CV to hr@company.com or founders@company.com';
      const res = extractContactEmails(raw);
      expect(res.count).toBe(2);
      expect(res.primaryEmail).toBeNull();
      expect(res.emails).toContain('hr@company.com');
      expect(res.emails).toContain('founders@company.com');
    });

    it('filters out image file extensions mistakenly parsed as emails', () => {
      const text = 'Check out diagram@test.png and send cv to dev@startup.org';
      const res = extractContactEmails(text);
      expect(res.count).toBe(1);
      expect(res.primaryEmail).toBe('dev@startup.org');
    });
  });

  describe('isDeadlineExpired', () => {
    it('returns false if deadline is null', () => {
      expect(isDeadlineExpired(null)).toBe(false);
    });

    it('returns true if deadline is in the past', () => {
      const refDate = new Date('2026-10-19T12:00:00Z');
      expect(isDeadlineExpired('2026-10-01', refDate)).toBe(true);
    });

    it('returns false if deadline is in the future', () => {
      const refDate = new Date('2026-10-19T12:00:00Z');
      expect(isDeadlineExpired('2026-11-01', refDate)).toBe(false);
    });
  });

  describe('computeDedupeHash', () => {
    it('generates deterministic hash regardless of whitespace and casing', () => {
      const hash1 = computeDedupeHash('Acme Corp', 'Frontend Dev', 'jobs@acme.com', null);
      const hash2 = computeDedupeHash('  acme corp  ', 'frontend dev', 'jobs@acme.com', null);
      expect(hash1).toBe(hash2);
    });
  });

  describe('evaluateSharedGates', () => {
    const validExtract: JobExtract = {
      transcribed_text: '',
      is_job: true,
      is_software_role: true,
      role: 'Full Stack Engineer',
      company: 'Acme AI',
      location: 'Remote',
      remote: true,
      relocation_required: false,
      visa_sponsorship: 'unknown',
      min_years: 3,
      salary: '$120k',
      deadline: '2026-12-31',
      requirements: ['TypeScript', 'React', 'Node.js'],
      apply_method: 'email',
      scam_risk: 'low',
      scam_reasons: [],
    };

    it('rejects if post is not a job or not software role', async () => {
      const res = await evaluateSharedGates({
        extract: { ...validExtract, is_job: false },
        rawText: 'Just chatting about tech',
      });
      expect(res.pass).toBe(false);
      if (!res.pass) {
        expect(res.status).toBe('rejected');
        expect(res.reason).toBe('not_a_job');
      }
    });

    it('rejects high scam risk posts', async () => {
      const res = await evaluateSharedGates({
        extract: { ...validExtract, scam_risk: 'high', scam_reasons: ['payment required', 'whatsapp only'] },
        rawText: 'Pay $50 processing fee on WhatsApp',
      });
      expect(res.pass).toBe(false);
      if (!res.pass) {
        expect(res.status).toBe('rejected');
        expect(res.reason).toContain('high_scam_risk');
      }
    });

    it('sets status to expired if deadline passed', async () => {
      const refDate = new Date('2026-10-19T12:00:00Z');
      const res = await evaluateSharedGates({
        extract: { ...validExtract, deadline: '2026-10-01' },
        rawText: 'Send email to team@google.com',
        referenceDate: refDate,
      });
      expect(res.pass).toBe(false);
      if (!res.pass) {
        expect(res.status).toBe('expired');
      }
    });

    it('flags email method without email as needs_manual', async () => {
      const res = await evaluateSharedGates({
        extract: { ...validExtract, apply_method: 'email' },
        rawText: 'Apply via email (no email written)',
      });
      expect(res.pass).toBe(false);
      if (!res.pass) {
        expect(res.status).toBe('needs_manual');
        expect(res.reason).toBe('email_method_but_no_email_found');
      }
    });

    it('detects duplicate job if hash already seen', async () => {
      const hash = computeDedupeHash('Acme AI', 'Full Stack Engineer', 'dev@acme.com', null);
      const existingHashes = new Set([hash]);

      const res = await evaluateSharedGates({
        extract: { ...validExtract, apply_method: 'email' },
        rawText: 'Send resume to dev@acme.com',
        existingDedupeHashes: existingHashes,
        mxValidator: async () => true,
      });
      expect(res.pass).toBe(false);
      if (!res.pass) {
        expect(res.status).toBe('duplicate');
      }
    });

    it('passes valid software role email job with valid MX record', async () => {
      const res = await evaluateSharedGates({
        extract: { ...validExtract, apply_method: 'email' },
        rawText: 'Join our team as Full Stack Engineer! Send CV to careers@acme.com',
        mxValidator: async () => true,
      });
      expect(res.pass).toBe(true);
      if (res.pass) {
        expect(res.route).toBe('email');
        expect(res.contactEmail).toBe('careers@acme.com');
        expect(res.addressSource).toBe('text');
        expect(res.dedupeHash).toBeTruthy();
      }
    });
  });
});
