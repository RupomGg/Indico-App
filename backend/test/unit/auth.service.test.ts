import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthService } from "../../src/modules/auth/auth.service.js";
import { prisma } from "../../src/lib/prisma.js";
import {
  BadRequestError,
  ConflictError,
  UnauthorizedError,
} from "../../src/lib/errors.js";
import * as cryptoLib from "../../src/lib/crypto.js";

describe("AuthService Business Logic & Corner Cases (PRD §4.1 U-01, U-02, U-03)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("register", () => {
    it("throws ConflictError when user with email already exists", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "existing-id",
        email: "taken@example.com",
      } as any);

      await expect(
        AuthService.register("taken@example.com", "Password123!")
      ).rejects.toThrow(ConflictError);
    });

    it("creates an unapproved, unverified user with verification token", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null);
      vi.spyOn(prisma.user, "create").mockResolvedValue({
        id: "new-user-1",
        email: "new@example.com",
        isEmailVerified: false,
        isApproved: false,
      } as any);

      const result = await AuthService.register("new@example.com", "Password123!");
      expect(result.userId).toBe("new-user-1");
      expect(result.email).toBe("new@example.com");
      expect(result.verificationToken).toBeDefined();
    });
  });

  describe("verifyEmail", () => {
    it("throws BadRequestError if token does not match any user", async () => {
      vi.spyOn(prisma.user, "findFirst").mockResolvedValue(null);

      await expect(AuthService.verifyEmail("invalid-token-123")).rejects.toThrow(
        BadRequestError
      );
    });

    it("successfully verifies user email and clears token", async () => {
      vi.spyOn(prisma.user, "findFirst").mockResolvedValue({
        id: "user-to-verify",
        emailVerifyExpiresAt: new Date(Date.now() + 100000),
      } as any);
      const updateSpy = vi.spyOn(prisma.user, "update").mockResolvedValue({} as any);

      const result = await AuthService.verifyEmail("valid-token-123");
      expect(result.message).toContain("successfully");
      expect(updateSpy).toHaveBeenCalledWith({
        where: { id: "user-to-verify" },
        data: {
          isEmailVerified: true,
          emailVerifyToken: null,
          emailVerifyExpiresAt: null,
        },
      });
    });
  });

  describe("login", () => {
    it("throws UnauthorizedError when user does not exist", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null);

      await expect(
        AuthService.login("nonexistent@example.com", "password123")
      ).rejects.toThrow(UnauthorizedError);
    });

    it("throws UnauthorizedError when password does not match hash", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "user-1",
        email: "user@example.com",
        passwordHash: "$2a$12$somehash",
      } as any);
      vi.spyOn(cryptoLib, "verifyPassword").mockResolvedValue(false);

      await expect(
        AuthService.login("user@example.com", "wrongPassword")
      ).rejects.toThrow(UnauthorizedError);
    });

    it("creates and returns session token with user approval and verification flags", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "user-1",
        email: "user@example.com",
        passwordHash: "$2a$12$somehash",
        isEmailVerified: true,
        isApproved: false,
      } as any);
      vi.spyOn(cryptoLib, "verifyPassword").mockResolvedValue(true);
      vi.spyOn(prisma.session, "create").mockResolvedValue({} as any);

      const result = await AuthService.login("user@example.com", "correctPassword");
      expect(result.token).toBeDefined();
      expect(result.user.isApproved).toBe(false);
      expect(result.user.isEmailVerified).toBe(true);
    });
  });

  describe("logout", () => {
    it("marks session revoked without throwing", async () => {
      const updateManySpy = vi
        .spyOn(prisma.session, "updateMany")
        .mockResolvedValue({ count: 1 } as any);

      const result = await AuthService.logout("raw-token-123");
      expect(result.message).toBe("Successfully logged out");
      expect(updateManySpy).toHaveBeenCalled();
    });
  });

  describe("refresh", () => {
    it("throws UnauthorizedError when session is not found or already revoked", async () => {
      vi.spyOn(prisma.session, "findUnique").mockResolvedValue(null);

      await expect(AuthService.refresh("expired-token")).rejects.toThrow(
        UnauthorizedError
      );
    });

    it("revokes old session and creates a new one on valid refresh", async () => {
      vi.spyOn(prisma.session, "findUnique").mockResolvedValue({
        id: "old-session-id",
        userId: "user-1",
        expiresAt: new Date(Date.now() + 100000),
        revokedAt: null,
      } as any);

      const updateSpy = vi.spyOn(prisma.session, "update").mockResolvedValue({} as any);
      const createSpy = vi.spyOn(prisma.session, "create").mockResolvedValue({} as any);

      const result = await AuthService.refresh("active-token");
      expect(result.token).toBeDefined();
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "old-session-id" } })
      );
      expect(createSpy).toHaveBeenCalled();
    });
  });

  describe("requestPasswordReset and confirmPasswordReset", () => {
    it("requestPasswordReset does not throw error if email does not exist", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null);
      const res = await AuthService.requestPasswordReset("nobody@example.com");
      expect(res.message).toBeDefined();
    });

    it("confirmPasswordReset throws BadRequestError on invalid token", async () => {
      vi.spyOn(prisma.user, "findFirst").mockResolvedValue(null);
      await expect(
        AuthService.confirmPasswordReset("bad-token", "NewPassword123!")
      ).rejects.toThrow(BadRequestError);
    });

    it("confirmPasswordReset updates password and revokes existing sessions", async () => {
      vi.spyOn(prisma.user, "findFirst").mockResolvedValue({
        id: "user-reset",
        passwordResetExpiresAt: new Date(Date.now() + 100000),
      } as any);
      vi.spyOn(prisma.user, "update").mockResolvedValue({} as any);
      vi.spyOn(prisma.session, "updateMany").mockResolvedValue({ count: 2 } as any);
      vi.spyOn(prisma, "$transaction").mockResolvedValue([{}, { count: 2 }] as any);

      const result = await AuthService.confirmPasswordReset("valid-token", "NewPassword123!");
      expect(result.message).toContain("successful");
    });
  });
});

