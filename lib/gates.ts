import * as dns from 'dns/promises';
import * as crypto from 'crypto';
import { JobExtract } from './schemas';

export interface EmailExtractResult {
  emails: string[];
  primaryEmail: string | null;
  count: number;
}

/**
 * Extracts distinct valid email addresses using strict RFC-compliant regex from
 * raw text, thread text, and transcribed image text.
 */
export function extractContactEmails(
  rawText: string = '',
  threadText: string = '',
  transcribedText: string = ''
): EmailExtractResult {
  const combined = `${rawText}\n${threadText}\n${transcribedText}`;
  // Case-insensitive email regex
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  const matches = combined.match(emailRegex) || [];

  // Normalize to lowercase and deduplicate
  const uniqueEmails = Array.from(new Set(matches.map((e) => e.toLowerCase())));

  // Filter out typical false positives (e.g. image extensions, domain names mistaken as emails)
  const filtered = uniqueEmails.filter((email) => {
    const domain = email.split('@')[1];
    if (!domain || !domain.includes('.')) return false;
    const tld = domain.split('.').pop();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(tld || '')) return false;
    return true;
  });

  return {
    emails: filtered,
    primaryEmail: filtered.length === 1 ? filtered[0] : null,
    count: filtered.length,
  };
}

/**
 * Validates domain has valid MX records via Node's DNS resolver.
 * Catches transcription OCR errors (e.g. l vs 1, 0 vs O).
 */
export async function checkMxRecords(domain: string): Promise<boolean> {
  if (!domain || domain.trim() === '') return false;
  try {
    const records = await dns.resolveMx(domain.trim());
    return records && records.length > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Checks whether an extracted deadline date string (YYYY-MM-DD) is in the past.
 */
export function isDeadlineExpired(deadline: string | null, referenceDate: Date = new Date()): boolean {
  if (!deadline) return false;
  const deadlineDate = new Date(`${deadline}T23:59:59Z`);
  if (isNaN(deadlineDate.getTime())) return false;
  return deadlineDate.getTime() < referenceDate.getTime();
}

/**
 * Computes deterministic dedupe hash for a job post to detect reposts across accounts.
 */
export function computeDedupeHash(
  company: string | null,
  role: string | null,
  contactEmail: string | null,
  applyLink: string | null
): string {
  const normalized = [
    (company || '').toLowerCase().trim().replace(/[^a-z0-9]/g, ''),
    (role || '').toLowerCase().trim().replace(/[^a-z0-9]/g, ''),
    (contactEmail || '').toLowerCase().trim(),
    (applyLink || '').toLowerCase().trim(),
  ].join('|');

  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export interface SharedGateInput {
  extract: JobExtract;
  rawText: string;
  threadText?: string;
  transcribedText?: string;
  applyLink?: string | null;
  existingDedupeHashes?: Set<string>;
  existingApplyLinks?: Set<string>;
  referenceDate?: Date;
  mxValidator?: (domain: string) => Promise<boolean>;
}

export type SharedGateDecision =
  | { pass: true; route: 'email' | 'link'; contactEmail: string | null; addressSource: 'text' | 'image' | null; dedupeHash: string }
  | { pass: false; status: 'rejected' | 'needs_manual' | 'duplicate' | 'expired'; reason: string; dedupeHash?: string };

/**
 * Round 1 Shared Gates (Section 7.3)
 * Code-only rules executed once per post before fan-out.
 */
export async function evaluateSharedGates(input: SharedGateInput): Promise<SharedGateDecision> {
  const { extract, rawText, threadText = '', transcribedText = '', applyLink = null, existingDedupeHashes, existingApplyLinks, referenceDate = new Date(), mxValidator } = input;

  // 1. Must be a software role job
  if (!extract.is_job || !extract.is_software_role) {
    return {
      pass: false,
      status: 'rejected',
      reason: !extract.is_job ? 'not_a_job' : 'not_software',
    };
  }

  // 2. Scam risk must be low
  if (extract.scam_risk !== 'low') {
    return {
      pass: false,
      status: 'rejected',
      reason: `high_scam_risk: ${extract.scam_reasons.join(', ')}`,
    };
  }

  // 3. Deadline check
  if (isDeadlineExpired(extract.deadline, referenceDate)) {
    return {
      pass: false,
      status: 'expired',
      reason: `deadline_passed: ${extract.deadline}`,
    };
  }

  // Determine route and apply method
  const applyMethod = extract.apply_method;

  if (applyMethod !== 'email' && applyMethod !== 'form' && applyMethod !== 'link') {
    return {
      pass: false,
      status: 'needs_manual',
      reason: `unsupported_apply_method: ${applyMethod}`,
    };
  }

  // Extract contact emails
  const emailResult = extractContactEmails(rawText, threadText, transcribedText);
  let contactEmail: string | null = null;
  let addressSource: 'text' | 'image' | null = null;

  if (applyMethod === 'email') {
    // Exactly one distinct email address required
    if (emailResult.count === 0) {
      return {
        pass: false,
        status: 'needs_manual',
        reason: 'email_method_but_no_email_found',
      };
    }
    if (emailResult.count > 1) {
      return {
        pass: false,
        status: 'needs_manual',
        reason: `multiple_emails_found: ${emailResult.emails.join(', ')}`,
      };
    }

    contactEmail = emailResult.primaryEmail!;

    // Check address source
    const inText = `${rawText}\n${threadText}`.toLowerCase().includes(contactEmail);
    addressSource = inText ? 'text' : 'image';

    // 4. DNS MX record validation
    const domain = contactEmail.split('@')[1];
    const hasMx = await (mxValidator ? mxValidator(domain) : checkMxRecords(domain));
    if (!hasMx) {
      return {
        pass: false,
        status: 'needs_manual',
        reason: `invalid_mx_record_for_domain: ${domain}`,
      };
    }
  } else {
    // Form or link route: must have an apply link or post URL
    if (!applyLink && !extract.requirements.some((r) => r.includes('http'))) {
      return {
        pass: false,
        status: 'needs_manual',
        reason: 'link_missing',
      };
    }
  }

  // Compute dedupe hash
  const dedupeHash = computeDedupeHash(extract.company, extract.role, contactEmail, applyLink);

  // 6. Dedupe check
  if (existingDedupeHashes && existingDedupeHashes.has(dedupeHash)) {
    return {
      pass: false,
      status: 'duplicate',
      reason: 'duplicate_dedupe_hash',
      dedupeHash,
    };
  }

  if (applyLink && existingApplyLinks && existingApplyLinks.has(applyLink.toLowerCase().trim())) {
    return {
      pass: false,
      status: 'duplicate',
      reason: 'duplicate_apply_link',
      dedupeHash,
    };
  }

  return {
    pass: true,
    route: applyMethod === 'email' ? 'email' : 'link',
    contactEmail,
    addressSource,
    dedupeHash,
  };
}
