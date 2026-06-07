import crypto from 'crypto'

// Symmetric encryption for secrets at rest (Gmail OAuth refresh tokens).
// AES-256-GCM gives us confidentiality + integrity. The key comes from
// EMAIL_TOKEN_ENCRYPTION_KEY (base64-encoded 32 bytes).

const ALGO = 'aes-256-gcm'

function getKey(): Buffer {
  const raw = process.env.EMAIL_TOKEN_ENCRYPTION_KEY
  if (!raw) throw new Error('EMAIL_TOKEN_ENCRYPTION_KEY is not set')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('EMAIL_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
  }
  return key
}

/** Encrypt a UTF-8 string → "iv.tag.ciphertext" (each base64). */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.')
}

/** Reverse of encryptSecret. Throws if the payload is malformed or tampered. */
export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.')
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted payload')
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
