// secret-at-rest util. one master key, AES-256-GCM. format:
//   base64( iv[12] || ciphertext || authTag[16] )
//
// key lives in DONNA_ENCRYPTION_KEY as 32 bytes of hex (64 chars).
// generate with: openssl rand -hex 32
//
// every integration that stores third-party tokens (oauth refresh tokens,
// imap app passwords, etc.) goes through encrypt()/decrypt() before the db.
// the db never sees plaintext secrets — only this module does.
//
// rotation: when the key changes, run a one-off migration that decrypts with
// the old key and re-encrypts with the new. for the early product we hold one
// key; structure the env as DONNA_ENCRYPTION_KEY and (later) DONNA_ENCRYPTION_KEY_PREV
// so the migration script can read both. not implemented yet — single key only.
//
// swap to AWS KMS / supabase vault by replacing the body of encrypt/decrypt;
// every caller already speaks (string) → (string). nothing else changes.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12;   // GCM standard
const TAG_LEN = 16;  // GCM standard

// lazy. importing this module shouldn't crash when the env isn't set yet
// (some scripts and tests don't need crypto). the first encrypt/decrypt call
// is the one that has to fail loudly.
let _key: Buffer | null = null;
function key(): Buffer {
  if (_key) return _key;
  const hex = process.env.DONNA_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "DONNA_ENCRYPTION_KEY not set. generate with: openssl rand -hex 32",
    );
  }
  if (hex.length !== 64) {
    throw new Error(
      `DONNA_ENCRYPTION_KEY must be 32 bytes hex (64 chars), got ${hex.length}`,
    );
  }
  _key = Buffer.from(hex, "hex");
  return _key;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

export function decrypt(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("ciphertext blob is shorter than the IV+tag header");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
}
