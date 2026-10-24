import { describe, it, expect } from 'vitest';
import { validateUploadedPdf } from '../lib/parse-resume';

describe('Resume PDF Validator', () => {
  it('rejects files without %PDF- magic header', async () => {
    const invalidHeaderBuffer = Buffer.from('NOT A PDF FILE');
    const result = await validateUploadedPdf(invalidHeaderBuffer);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing %PDF- header');
  });

  it('rejects files exceeding 5MB max size', async () => {
    // 5MB + 1 byte
    const oversizedBuffer = Buffer.alloc(5 * 1024 * 1024 + 1);
    oversizedBuffer.write('%PDF-');

    const result = await validateUploadedPdf(oversizedBuffer);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('exceeds maximum limit of 5MB');
  });

  it('rejects PDFs with forbidden active content or embedded JS scripts', async () => {
    const maliciousPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Action /S /JavaScript /JS (app.alert("pwned")) >>\nendobj');
    const result = await validateUploadedPdf(maliciousPdf);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('forbidden active content');
  });

  it('rejects PDFs with /Launch action', async () => {
    const maliciousPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Action /S /Launch /F (cmd.exe) >>\nendobj');
    const result = await validateUploadedPdf(maliciousPdf);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('forbidden active content');
  });
});
