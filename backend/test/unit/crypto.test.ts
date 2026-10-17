import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  hashPassword,
  verifyPassword,
  generateSecureToken,
  hashToken,
  computeFileSha256,
  verifyWalletSignature,
} from "../../src/lib/crypto.js";

describe("Cryptographic Utilities & Corner Cases", () => {
  describe("Password Hashing & Verification (bcrypt)", () => {
    it("hashes password and verifies successfully with correct password", async () => {
      const password = "SuperSecretPassword123!";
      const hash = await hashPassword(password);
      expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
      const isMatch = await verifyPassword(password, hash);
      expect(isMatch).toBe(true);
    });

    it("rejects incorrect password", async () => {
      const password = "CorrectPassword123!";
      const hash = await hashPassword(password);
      const isMatch = await verifyPassword("WrongPassword456!", hash);
      expect(isMatch).toBe(false);
    });

    it("rejects empty password against valid hash", async () => {
      const hash = await hashPassword("NotEmpty123!");
      const isMatch = await verifyPassword("", hash);
      expect(isMatch).toBe(false);
    });

    it("handles passwords with Unicode, emojis, and special symbols", async () => {
      const unicodePassword = "🔐Pässwörd!€123_日本語";
      const hash = await hashPassword(unicodePassword);
      expect(await verifyPassword(unicodePassword, hash)).toBe(true);
      expect(await verifyPassword("🔐Pässwörd!€123", hash)).toBe(false);
    });

    it("produces distinct salts/hashes for the same password", async () => {
      const password = "IdenticalPassword123!";
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);
      expect(hash1).not.toBe(hash2);
      expect(await verifyPassword(password, hash1)).toBe(true);
      expect(await verifyPassword(password, hash2)).toBe(true);
    });
  });

  describe("Token Generation & Hashing", () => {
    it("generates random hex tokens of default 32 bytes (64 hex characters)", () => {
      const token1 = generateSecureToken();
      const token2 = generateSecureToken();
      expect(token1).toHaveLength(64);
      expect(token2).toHaveLength(64);
      expect(token1).toMatch(/^[0-9a-f]{64}$/);
      expect(token1).not.toBe(token2);
    });

    it("generates tokens of arbitrary specified byte lengths", () => {
      const token = generateSecureToken(16);
      expect(token).toHaveLength(32);
    });

    it("hashes tokens deterministically with SHA-256", () => {
      const token = "abcdef1234567890abcdef1234567890";
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("File SHA-256 Byte Computation", () => {
    it("computes 0x-prefixed 32-byte hash correctly", () => {
      const content = Buffer.from("Indico Asset Ledger Test Document");
      const hash = computeFileSha256(content);
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
      // Deterministic check
      expect(hash).toBe(computeFileSha256(content));
    });

    it("computes different hash for altered byte stream", () => {
      const buf1 = Buffer.from("File version 1");
      const buf2 = Buffer.from("File version 2");
      expect(computeFileSha256(buf1)).not.toBe(computeFileSha256(buf2));
    });
  });

  describe("EIP-191 Personal Signature Verification (Corner Cases)", () => {
    it("verifies genuine wallet signature successfully", async () => {
      const privateKey = generatePrivateKey();
      const account = privateKeyToAccount(privateKey);
      const message = "Sign in to Indico Asset Ledger";

      const signature = await account.signMessage({ message });
      const isValid = await verifyWalletSignature(
        account.address,
        message,
        signature
      );
      expect(isValid).toBe(true);
    });

    it("rejects signature signed by a different wallet address", async () => {
      const account1 = privateKeyToAccount(generatePrivateKey());
      const account2 = privateKeyToAccount(generatePrivateKey());
      const message = "Bind wallet 0x123";

      const signature1 = await account1.signMessage({ message });
      const isValid = await verifyWalletSignature(
        account2.address, // wrong address
        message,
        signature1
      );
      expect(isValid).toBe(false);
    });

    it("rejects signature if message content was tampered", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const originalMessage = "Bind wallet to user A";
      const tamperedMessage = "Bind wallet to user B";

      const signature = await account.signMessage({ message: originalMessage });
      const isValid = await verifyWalletSignature(
        account.address,
        tamperedMessage,
        signature
      );
      expect(isValid).toBe(false);
    });

    it("gracefully returns false without throwing on truncated signature", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const message = "Test message";
      const signature = await account.signMessage({ message });
      const truncated = signature.slice(0, 50) as `0x${string}`;

      const isValid = await verifyWalletSignature(
        account.address,
        message,
        truncated
      );
      expect(isValid).toBe(false);
    });

    it("gracefully returns false without throwing on completely invalid hex signature", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const isValid = await verifyWalletSignature(
        account.address,
        "message",
        "0xinvalidhexstring" as `0x${string}`
      );
      expect(isValid).toBe(false);
    });

    it("gracefully returns false on malformed Ethereum address", async () => {
      const isValid = await verifyWalletSignature(
        "0xinvalidAddress" as any,
        "message",
        ("0x" + "00".repeat(65)) as `0x${string}`
      );
      expect(isValid).toBe(false);
    });
  });
});
