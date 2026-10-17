import { describe, it, expect } from "vitest";
import {
  BindWalletRequestSchema,
  UpdateProfileRequestSchema,
} from "../../src/modules/profile/profile.schemas.js";

describe("Profile DTO Field Boundary Partition Tests (PRD §Input Testing §6.3)", () => {
  const validWallet = "0x7b4c1e792d0ef3942f479e74de6043a6238a8fd1";
  const validAccountRef = "0x0408fa7451b13cb6c98a988fa2a2a839241912dcc685d3dfd53edb27fad2d45d";
  const validSignature = "0x" + "a".repeat(130);
  const validMessage = "Bind wallet 0x7b4c... to Indico Asset Ledger";

  describe("BindWalletRequestSchema", () => {
    describe("field: walletAddress", () => {
      const walletPartitions: [string, any, boolean][] = [
        ["empty string", "", false],
        ["whitespace only", "   ", false],
        ["missing 0x prefix", "7b4c1e792d0ef3942f479e74de6043a6238a8fd1", false],
        ["short (39 hex characters)", "0x7b4c1e792d0ef3942f479e74de6043a6238a8fd", false],
        ["exact (40 hex characters lowercase)", "0x7b4c1e792d0ef3942f479e74de6043a6238a8fd1", true],
        ["exact (40 hex characters mixed case)", "0x7B4C1e792D0ef3942f479E74de6043A6238a8fD1", true],
        ["long (41 hex characters)", "0x7b4c1e792d0ef3942f479e74de6043a6238a8fd1a", false],
        ["invalid hex characters (contains 'g')", "0x7b4c1e792d0ef3942f479e74de6043a6238a8fdg", false],
        ["wrong type: number", 123456789, false],
        ["wrong type: null", null, false],
        ["absent", undefined, false],
      ];

      it.each(walletPartitions)("%s -> valid: %s", (_desc, walletAddress, expectedValid) => {
        const result = BindWalletRequestSchema.safeParse({
          walletAddress,
          accountRef: validAccountRef,
          signature: validSignature,
          message: validMessage,
        });
        expect(result.success).toBe(expectedValid);
        if (expectedValid && typeof walletAddress === "string") {
          expect(result.data?.walletAddress).toBe(walletAddress.toLowerCase());
        }
      });
    });

    describe("field: accountRef", () => {
      const accountRefPartitions: [string, any, boolean][] = [
        ["empty string", "", false],
        ["missing 0x prefix", validAccountRef.slice(2), false],
        ["short (63 hex characters)", validAccountRef.slice(0, 65), false],
        ["exact (64 hex characters)", validAccountRef, true],
        ["long (65 hex characters)", validAccountRef + "a", false],
        ["invalid hex characters (contains 'z')", "0x" + "z".repeat(64), false],
        ["wrong type: null", null, false],
        ["absent", undefined, false],
      ];

      it.each(accountRefPartitions)("%s -> valid: %s", (_desc, accountRef, expectedValid) => {
        const result = BindWalletRequestSchema.safeParse({
          walletAddress: validWallet,
          accountRef,
          signature: validSignature,
          message: validMessage,
        });
        expect(result.success).toBe(expectedValid);
        if (expectedValid && typeof accountRef === "string") {
          expect(result.data?.accountRef).toBe(accountRef.toLowerCase());
        }
      });
    });

    describe("field: signature", () => {
      const signaturePartitions: [string, any, boolean][] = [
        ["empty string", "", false],
        ["missing 0x prefix", "a".repeat(130), false],
        ["short (128 hex chars)", "0x" + "a".repeat(128), false],
        ["exact (130 hex chars / 65 bytes)", "0x" + "a".repeat(130), true],
        ["long (132 hex chars)", "0x" + "a".repeat(132), false],
        ["invalid hex char", "0x" + "a".repeat(129) + "x", false],
        ["wrong type: null", null, false],
        ["absent", undefined, false],
      ];

      it.each(signaturePartitions)("%s -> valid: %s", (_desc, signature, expectedValid) => {
        const result = BindWalletRequestSchema.safeParse({
          walletAddress: validWallet,
          accountRef: validAccountRef,
          signature,
          message: validMessage,
        });
        expect(result.success).toBe(expectedValid);
      });
    });

    describe("field: message", () => {
      const messagePartitions: [string, any, boolean][] = [
        ["empty string", "", false],
        ["typical string", validMessage, true],
        ["multiline text", "Header\nBody\nFooter", true],
        ["wrong type: null", null, false],
        ["absent", undefined, false],
      ];

      it.each(messagePartitions)("%s -> valid: %s", (_desc, message, expectedValid) => {
        const result = BindWalletRequestSchema.safeParse({
          walletAddress: validWallet,
          accountRef: validAccountRef,
          signature: validSignature,
          message,
        });
        expect(result.success).toBe(expectedValid);
      });
    });
  });

  describe("UpdateProfileRequestSchema", () => {
    describe("field: currentPassword", () => {
      const currentPasswordPartitions: [string, any, boolean][] = [
        ["empty string", "", false],
        ["typical string", "currentSecretPass123", true],
        ["wrong type: null", null, false],
        ["absent", undefined, false],
      ];

      it.each(currentPasswordPartitions)("%s -> valid: %s", (_desc, currentPassword, expectedValid) => {
        const result = UpdateProfileRequestSchema.safeParse({
          currentPassword,
          newPassword: "BrandNewPassword123!",
        });
        expect(result.success).toBe(expectedValid);
      });
    });

    describe("field: newPassword", () => {
      const newPasswordPartitions: [string, any, boolean][] = [
        ["empty string", "", false],
        ["min - 1 (7 chars)", "1234567", false],
        ["min exactly (8 chars)", "12345678", true],
        ["typical (16 chars)", "MyBrandNewPass1!", true],
        ["max exactly (128 chars)", "a".repeat(128), true],
        ["max + 1 (129 chars)", "a".repeat(129), false],
        ["wrong type: number", 12345678, false],
        ["wrong type: null", null, false],
        ["absent", undefined, false],
      ];

      it.each(newPasswordPartitions)("%s -> valid: %s", (_desc, newPassword, expectedValid) => {
        const result = UpdateProfileRequestSchema.safeParse({
          currentPassword: "existingValidPassword123",
          newPassword,
        });
        expect(result.success).toBe(expectedValid);
      });
    });
  });
});

