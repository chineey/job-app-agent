import { describe, it, expect } from 'vitest';
import { extractDomain, generateRfcMessageId, isWithinSendWindow, sha256 } from '../lib/send';
import { buildMimeMessage, encodeBase64Url } from '../lib/gmail';

describe('Send Engine Utilities', () => {
  it('correctly extracts recipient domain in lowercase', () => {
    expect(extractDomain('recruiter@Stripe.com')).toBe('stripe.com');
    expect(extractDomain('TALENT@OpenAI.Com')).toBe('openai.com');
    expect(extractDomain('invalid-email')).toBe('');
  });

  it('generates a valid, unique RFC 2822 Message-ID header', () => {
    const id1 = generateRfcMessageId('google.com');
    const id2 = generateRfcMessageId('google.com');

    expect(id1).toMatch(/^<[0-9]+\.[0-9a-f-]+@google\.com>$/);
    expect(id2).toMatch(/^<[0-9]+\.[0-9a-f-]+@google\.com>$/);
    expect(id1).not.toBe(id2);
  });

  it('computes consistent SHA-256 hashes', () => {
    const hash1 = sha256('Test email body text');
    const hash2 = sha256('Test email body text');
    const hashDiff = sha256('Different text');

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hashDiff);
    expect(hash1).toHaveLength(64);
  });

  it('correctly evaluates send window within candidate timezone', () => {
    // Current UTC hour
    const nowUtc = new Date().getUTCHours();

    // UTC window spanning the current hour must be true
    const isOpen = isWithinSendWindow('UTC', (nowUtc - 1 + 24) % 24, (nowUtc + 2) % 24);
    // If window start < window end in normal range
    if ((nowUtc - 1 + 24) % 24 < (nowUtc + 2) % 24) {
      expect(isOpen).toBe(true);
    }

    // Window in the past must be false
    const pastWindow = isWithinSendWindow('UTC', (nowUtc - 4 + 24) % 24, (nowUtc - 2 + 24) % 24);
    if ((nowUtc - 4 + 24) % 24 < (nowUtc - 2 + 24) % 24) {
      expect(pastWindow).toBe(false);
    }
  });

  it('builds compliant plain-text MIME message without attachment', () => {
    const mime = buildMimeMessage({
      from: 'candidate@gmail.com',
      to: 'recruiter@company.com',
      subject: 'Senior Full Stack Engineer Application',
      bodyText: 'I am excited to submit my tailored application.',
      rfcMessageId: '<12345.abcdef@company.com>',
    });

    expect(mime).toContain('From: candidate@gmail.com');
    expect(mime).toContain('To: recruiter@company.com');
    expect(mime).toContain('Subject: Senior Full Stack Engineer Application');
    expect(mime).toContain('Message-ID: <12345.abcdef@company.com>');
    expect(mime).toContain('I am excited to submit my tailored application.');
    expect(mime).not.toContain('multipart/mixed');
  });

  it('builds multipart MIME message when resume PDF is attached', () => {
    const dummyPdfBuffer = Buffer.from('%PDF-1.4 mock content');
    const mime = buildMimeMessage({
      from: 'candidate@gmail.com',
      to: 'recruiter@company.com',
      subject: 'Senior Engineer Application',
      bodyText: 'Please find attached my resume.',
      rfcMessageId: '<12345.abcdef@company.com>',
      pdfAttachment: {
        filename: 'Jane_Doe_Resume.pdf',
        contentBuffer: dummyPdfBuffer,
      },
    });

    expect(mime).toContain('multipart/mixed');
    expect(mime).toContain('Content-Disposition: attachment; filename="Jane_Doe_Resume.pdf"');
    expect(mime).toContain(dummyPdfBuffer.toString('base64'));

    const base64Url = encodeBase64Url(mime);
    expect(base64Url).not.toContain('+');
    expect(base64Url).not.toContain('/');
    expect(base64Url).not.toContain('=');
  });
});
