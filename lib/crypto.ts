import crypto from 'crypto';

/**
 * Reads the 32-byte AES key from TOKEN_ENCRYPTION_KEY (base64). There is deliberately no fallback:
 * a default key would be public, and hashing a passphrase would accept weak keys.
 */
function getEncryptionKey(): Buffer {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32).');
  }
  return key;
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
