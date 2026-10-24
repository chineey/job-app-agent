import crypto from 'crypto';

/**
 * Derives the 32-byte AES key from the TOKEN_ENCRYPTION_KEY environment variable.
 */
function getEncryptionKey(): Buffer {
  const keyStr = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyStr) {
    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV !== 'production') {
      // 32-byte fallback for dev / testing
      return Buffer.from('12345678901234567890123456789012', 'utf-8');
    }
    throw new Error('TOKEN_ENCRYPTION_KEY environment variable is required');
  }

  // Attempt base64 decode; if length is 32 bytes use it, otherwise hash to 32 bytes
  const buf = Buffer.from(keyStr, 'base64');
  if (buf.length === 32) {
    return buf;
  }

  // Fallback: SHA-256 hash ensures exactly 32 bytes
  return crypto.createHash('sha256').update(keyStr).digest();
}

/**
 * Encrypts a plaintext refresh token using AES-256-GCM.
 * Output format: "iv:authTag:ciphertext" (all base64)
 */
export function encryptToken(token: string): string {
  if (!token) return '';
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // Standard 12-byte IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(token, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');

  return `${iv.toString('base64')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted token.
 * Input format: "iv:authTag:ciphertext"
 */
export function decryptToken(encryptedData: string): string {
  if (!encryptedData) return '';
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format. Expected "iv:authTag:ciphertext".');
  }

  const [ivBase64, authTagBase64, ciphertextBase64] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertextBase64, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
