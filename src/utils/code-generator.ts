import crypto from "node:crypto";

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // base36 uppercase
const CODE_LENGTH = 8;

/**
 * Generate a unique 8-character base36 referral code.
 * Uses crypto.randomBytes for cryptographic security.
 */
export function generatePromoCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CHARSET[bytes[i] % CHARSET.length];
  }
  return code;
}

/**
 * Validate code format. Used by middleware to filter out garbage ?ref= values.
 */
export function isValidCodeFormat(code: string): boolean {
  return /^[A-Za-z0-9-]{4,32}$/.test(code);
}