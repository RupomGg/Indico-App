import crypto from "crypto";
import bcrypt from "bcryptjs";
import { verifyMessage } from "viem";

const BCRYPT_ROUNDS = 12;

/**
 * Hashes a plaintext password using bcrypt.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Verifies a plaintext password against a bcrypt hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generates a cryptographically random secure token (e.g. for sessions, email verification).
 */
export function generateSecureToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Hashes a token using SHA-256 for secure storage in database.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Computes the SHA-256 hash of raw file bytes.
 * PRD §4.2 A-06: Verified server-side against client-submitted hash.
 *
 * @param buffer - raw binary file buffer
 * @returns 0x-prefixed hex string of 32 bytes (64 hex characters)
 */
export function computeFileSha256(buffer: Buffer): `0x${string}` {
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return `0x${hash}`;
}

/**
 * Verifies an Ethereum EIP-191 personal_sign signature.
 * Used for wallet binding proof (U-04).
 */
export async function verifyWalletSignature(
  address: `0x${string}`,
  message: string,
  signature: `0x${string}`
): Promise<boolean> {
  try {
    return await verifyMessage({
      address,
      message,
      signature,
    });
  } catch {
    return false;
  }
}
