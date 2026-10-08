import { createHmac } from 'node:crypto';

/**
 * Batch 34: makes Authenticator-app codes inside the tests (RFC 6238 TOTP:
 * SHA-1, 6 digits, 30-second steps — what Supabase uses), from the test
 * account's own set-up key. Only ever used with the test Super Admin.
 */
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error('Not a base32 key');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secret: string, timeMs: number = Date.now()): string {
  const counter = Math.floor(timeMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/** A code that is certainly wrong right now (never equal to the real one). */
export function wrongCode(secret: string): string {
  const right = totpCode(secret);
  return right === '000000' ? '111111' : '000000';
}
