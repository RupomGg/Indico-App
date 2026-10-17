import { describe, it, expect } from "vitest";
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  VerifyEmailRequestSchema,
  ResetPasswordConfirmSchema,
} from "../../src/modules/auth/auth.schemas.js";

describe("Auth DTO Field Boundary Partition Tests (PRD §Input Testing §6.3)", () => {
  describe("RegisterRequestSchema", () => {
    describe("field: email", () => {
      const emailPartitionTable: [string, any, boolean][] = [
        ["empty string", "", false],
        ["whitespace only", "   ", false],
        ["missing @ sign", "invalidemail.com", false],
        ["missing domain", "user@", false],
        ["missing user", "@example.com", false],
        ["typical valid email", "test.user@example.com", true],
        ["uppercase (normalizes to lowercase)", "USER@EXAMPLE.COM", true],
        ["wrong type: number", 12345, false],
        ["wrong type: null", null, false],
        ["absent", undefined, false],
      ];

      it.each(emailPartitionTable)("%s (%s) -> valid: %s", (_desc, email, expectedValid) => {
        const result = RegisterRequestSchema.safeParse({
          email,
          password: "validPassword123",
        });
        expect(result.success).toBe(expectedValid);
        if (expectedValid && typeof email === "string") {
          expect(result.data?.email).toBe(email.toLowerCase().trim());
        }
      });
    });

    describe("field: password", () => {
      const passwordPartitionTable: [string, any, boolean][] = [
        ["empty string", "", false],
        ["min - 1 (7 characters)", "1234567", false],
        ["min exactly (8 characters)", "12345678", true],
        ["typical (16 characters)", "MySecurePass123!", true],
        ["max exactly (128 characters)", "a".repeat(128), true],
        ["max + 1 (129 characters)", "a".repeat(129), false],
        ["wrong type: number", 12345678, false],
        ["wrong type: boolean", true, false],
        ["wrong type: null", null, false],
        ["absent", undefined, false],
      ];

      it.each(passwordPartitionTable)("%s -> valid: %s", (_desc, password, expectedValid) => {
        const result = RegisterRequestSchema.safeParse({
          email: "valid@example.com",
          password,
        });
        expect(result.success).toBe(expectedValid);
      });
    });
  });

  describe("LoginRequestSchema", () => {
    it("accepts valid typical credentials", () => {
      const result = LoginRequestSchema.safeParse({
        email: "user@example.com",
        password: "secretPassword",
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty password", () => {
      const result = LoginRequestSchema.safeParse({
        email: "user@example.com",
        password: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("VerifyEmailRequestSchema", () => {
    it("accepts typical verification token", () => {
      const result = VerifyEmailRequestSchema.safeParse({
        token: "abcdef123456",
      });
      expect(result.success).toBe(true);
      expect(result.data?.token).toBe("abcdef123456");
    });

    it("rejects empty token", () => {
      const result = VerifyEmailRequestSchema.safeParse({
        token: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ResetPasswordConfirmSchema", () => {
    it("accepts valid token and new password within bounds", () => {
      const result = ResetPasswordConfirmSchema.safeParse({
        token: "token123",
        newPassword: "BrandNewPassword123",
      });
      expect(result.success).toBe(true);
    });

    it("rejects short password (< 8 chars)", () => {
      const result = ResetPasswordConfirmSchema.safeParse({
        token: "token123",
        newPassword: "short",
      });
      expect(result.success).toBe(false);
    });
  });
});
