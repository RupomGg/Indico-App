import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProfileService } from "../../src/modules/profile/profile.service.js";
import { prisma } from "../../src/lib/prisma.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from "../../src/lib/errors.js";
import * as cryptoLib from "../../src/lib/crypto.js";

describe("ProfileService Business Logic & Corner Cases (PRD §4.1 U-04, U-05, U-09, U-10)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("getProfile", () => {
    it("throws NotFoundError when user does not exist", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null);

      await expect(ProfileService.getProfile("non-existent-user")).rejects.toThrow(
        NotFoundError
      );
    });

    it("returns profile with null wallet fields for unbound user", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "user-1",
        email: "user1@example.com",
        isEmailVerified: true,
        isApproved: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        walletBinding: null,
      } as any);

      const profile = await ProfileService.getProfile("user-1");
      expect(profile.walletAddress).toBeNull();
      expect(profile.accountRef).toBeNull();
      expect(profile.isApproved).toBe(false);
    });

    it("returns profile with wallet details when bound", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "user-2",
        email: "user2@example.com",
        isEmailVerified: true,
        isApproved: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        walletBinding: {
          walletAddress: "0x7b4c1e792d0ef3942f479e74de6043a6238a8fd1",
          accountRef: "0x0408fa7451b13cb6c98a988fa2a2a839241912dcc685d3dfd53edb27fad2d45d",
        },
      } as any);

      const profile = await ProfileService.getProfile("user-2");
      expect(profile.walletAddress).toBe("0x7b4c1e792d0ef3942f479e74de6043a6238a8fd1");
      expect(profile.accountRef).toBe("0x0408fa7451b13cb6c98a988fa2a2a839241912dcc685d3dfd53edb27fad2d45d");
    });
  });

  describe("getWalletStatus", () => {
    it("returns isBound: false if user has no wallet binding", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue(null);

      const status = await ProfileService.getWalletStatus("user-unbound");
      expect(status.isBound).toBe(false);
      expect(status.walletAddress).toBeNull();
      expect(status.isTermsSignedOnChain).toBe(false);
    });
  });

  describe("bindWallet (U-04, U-05 Constraints)", () => {
    const validWallet = "0x7b4c1e792d0ef3942f479e74de6043a6238a8fd1";
    const validAccountRef = "0x0408fa7451b13cb6c98a988fa2a2a839241912dcc685d3dfd53edb27fad2d45d";
    const validSig = ("0x" + "a".repeat(130)) as `0x${string}`;
    const validMsg = "Bind wallet message";

    it("throws BadRequestError when cryptographic signature fails verification", async () => {
      vi.spyOn(cryptoLib, "verifyWalletSignature").mockResolvedValue(false);

      await expect(
        ProfileService.bindWallet("user-1", validWallet, validAccountRef, validSig, validMsg)
      ).rejects.toThrow(BadRequestError);
    });

    it("throws ConflictError when user already has a bound wallet (PRD §4.1 U-05)", async () => {
      vi.spyOn(cryptoLib, "verifyWalletSignature").mockResolvedValue(true);
      vi.spyOn(prisma.walletBinding, "findUnique")
        .mockResolvedValueOnce({ id: "binding-1", userId: "user-1" } as any); // user check

      await expect(
        ProfileService.bindWallet("user-1", validWallet, validAccountRef, validSig, validMsg)
      ).rejects.toThrow(ConflictError);
    });

    it("throws ConflictError when wallet address is already bound to another user", async () => {
      vi.spyOn(cryptoLib, "verifyWalletSignature").mockResolvedValue(true);
      vi.spyOn(prisma.walletBinding, "findUnique")
        .mockResolvedValueOnce(null) // user check passes
        .mockResolvedValueOnce({ id: "binding-other", walletAddress: validWallet } as any); // wallet check fails

      await expect(
        ProfileService.bindWallet("user-1", validWallet, validAccountRef, validSig, validMsg)
      ).rejects.toThrow(ConflictError);
    });

    it("throws ConflictError when accountRef is already registered", async () => {
      vi.spyOn(cryptoLib, "verifyWalletSignature").mockResolvedValue(true);
      vi.spyOn(prisma.walletBinding, "findUnique")
        .mockResolvedValueOnce(null) // user check
        .mockResolvedValueOnce(null) // wallet check
        .mockResolvedValueOnce({ id: "binding-ref", accountRef: validAccountRef } as any); // ref check fails

      await expect(
        ProfileService.bindWallet("user-1", validWallet, validAccountRef, validSig, validMsg)
      ).rejects.toThrow(ConflictError);
    });

    it("successfully binds wallet when all constraints and cryptographic proofs pass", async () => {
      vi.spyOn(cryptoLib, "verifyWalletSignature").mockResolvedValue(true);
      vi.spyOn(prisma.walletBinding, "findUnique")
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      vi.spyOn(prisma.walletBinding, "create").mockResolvedValue({
        id: "new-binding",
        userId: "user-1",
        walletAddress: validWallet,
        accountRef: validAccountRef,
        boundAt: new Date("2026-02-01T00:00:00Z"),
      } as any);

      const result = await ProfileService.bindWallet(
        "user-1",
        validWallet,
        validAccountRef,
        validSig,
        validMsg
      );
      expect(result.walletAddress).toBe(validWallet);
      expect(result.accountRef).toBe(validAccountRef);
      expect(result.message).toContain("successfully");
    });
  });

  describe("updateProfile (U-09 Password Credentials)", () => {
    it("throws NotFoundError when user does not exist", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null);

      await expect(
        ProfileService.updateProfile("missing-user", "oldPass", "newPass1234")
      ).rejects.toThrow(NotFoundError);
    });

    it("throws UnauthorizedError when current password is wrong", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "user-1",
        passwordHash: "hash",
      } as any);
      vi.spyOn(cryptoLib, "verifyPassword").mockResolvedValue(false);

      await expect(
        ProfileService.updateProfile("user-1", "wrongCurrentPass", "newPass1234")
      ).rejects.toThrow(UnauthorizedError);
    });

    it("updates password hash when current password is verified", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "user-1",
        passwordHash: "oldhash",
      } as any);
      vi.spyOn(cryptoLib, "verifyPassword").mockResolvedValue(true);
      const updateSpy = vi.spyOn(prisma.user, "update").mockResolvedValue({} as any);

      const result = await ProfileService.updateProfile("user-1", "oldPass", "newPass1234");
      expect(result.message).toContain("successfully");
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "user-1" } })
      );
    });
  });
});
