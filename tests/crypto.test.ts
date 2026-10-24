import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken } from '../lib/crypto';

describe('AES-256-GCM Token Encryption', () => {
  it('encrypts and decrypts a refresh token accurately', () => {
    const originalToken = '1//04sampleRefreshTokenGoogleOAuth2026_xyz123!';
    const encrypted = encryptToken(originalToken);

    expect(encrypted).not.toBe(originalToken);
    expect(encrypted.split(':')).toHaveLength(3);

    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(originalToken);
  });

  it('produces different ciphertexts for the same plaintext due to random IV', () => {
    const token = 'same_refresh_token_value';
    const enc1 = encryptToken(token);
    const enc2 = encryptToken(token);

    expect(enc1).not.toBe(enc2);
    expect(decryptToken(enc1)).toBe(token);
    expect(decryptToken(enc2)).toBe(token);
  });

  it('fails safely when decrypting tampered data', () => {
    const encrypted = encryptToken('secret_token');
    const parts = encrypted.split(':');
    // Tamper with ciphertext
    const tampered = `${parts[0]}:${parts[1]}:dGFtcGVyZWQ=`;

    expect(() => decryptToken(tampered)).toThrow();
  });
});
