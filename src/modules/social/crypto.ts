import crypto from "node:crypto";
import { env } from "../../config.js";

/**
 * AES-256-GCM helpers for storing third-party OAuth tokens at rest.
 *
 * Key derivation: we hash the SUPABASE_SERVICE_ROLE_KEY with SHA-256 to
 * get a stable 32-byte key. The service-role key is already an
 * environment secret (not committed), and hashing gives us a clean
 * 32-byte AES-256 key regardless of the original key length.
 *
 * Wire format: base64(iv (12B) || authTag (16B) || ciphertext).
 * The IV is random per encryption; the tag is produced by GCM and is
 * required for decryption integrity.
 *
 * If the env is missing or hash fails, we throw — startup must not
 * silently skip encryption (a "no-op" encrypt that stored plaintext
 * would be a data-protection incident).
 */

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "[social/crypto] SUPABASE_SERVICE_ROLE_KEY is required to encrypt OAuth tokens",
    );
  }
  cachedKey = crypto.createHash("sha256").update(env.SUPABASE_SERVICE_ROLE_KEY).digest();
  return cachedKey;
}

/**
 * Encrypts a UTF-8 string into base64(iv || tag || ciphertext).
 * Returns "" for an empty input (some platforms do not issue a refresh
 * token — we store "" rather than re-encrypting the empty string).
 */
export function encryptToken(plaintext: string): string {
  if (!plaintext) return "";
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * Decrypts a token produced by encryptToken(). Returns "" if the input
 * is empty. Throws on tampering (GCM tag mismatch) — the caller
 * surfaces this as a 401 / "re-authorise" UI for the KOL.
 */
export function decryptToken(payload: string): string {
  if (!payload) return "";
  const key = getKey();
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("[social/crypto] ciphertext too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
