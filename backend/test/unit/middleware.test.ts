import { describe, it, expect, vi, beforeEach } from "vitest";
import { FastifyRequest, FastifyReply } from "fastify";
import { authenticate, requireApproved } from "../../src/middleware/auth.js";
import { prisma } from "../../src/lib/prisma.js";
import { UnauthorizedError, ForbiddenError } from "../../src/lib/errors.js";

describe("Auth Middleware Corner Cases (PRD §4.1 U-02, U-03)", () => {
  let mockRequest: Partial<FastifyRequest>;
  let mockReply: Partial<FastifyReply>;

  beforeEach(() => {
    mockRequest = {
      headers: {},
    };
    mockReply = {};
    vi.restoreAllMocks();
  });

  describe("authenticate middleware", () => {
    it("throws UnauthorizedError when Authorization header is absent", async () => {
      mockRequest.headers = {};
      await expect(
        authenticate(mockRequest as FastifyRequest, mockReply as FastifyReply)
      ).rejects.toThrow(UnauthorizedError);
    });

    it("throws UnauthorizedError when Authorization header lacks 'Bearer ' prefix", async () => {
      mockRequest.headers = { authorization: "Basic dXNlcjpwYXNz" };
      await expect(
        authenticate(mockRequest as FastifyRequest, mockReply as FastifyReply)
      ).rejects.toThrow(UnauthorizedError);
    });

    it("throws UnauthorizedError when Bearer token is empty", async () => {
      mockRequest.headers = { authorization: "Bearer " };
      await expect(
        authenticate(mockRequest as FastifyRequest, mockReply as FastifyReply)
      ).rejects.toThrow(UnauthorizedError);
    });

    it("throws UnauthorizedError when session does not exist in database", async () => {
      mockRequest.headers = { authorization: "Bearer validlookingtoken123" };
      vi.spyOn(prisma.session, "findUnique").mockResolvedValue(null);

      await expect(
        authenticate(mockRequest as FastifyRequest, mockReply as FastifyReply)
      ).rejects.toThrow(UnauthorizedError);
    });

    it("throws UnauthorizedError when session has been revoked", async () => {
      mockRequest.headers = { authorization: "Bearer somerevokedtoken" };
      vi.spyOn(prisma.session, "findUnique").mockResolvedValue({
        id: "session-1",
        userId: "user-1",
        tokenHash: "hash",
        expiresAt: new Date(Date.now() + 100000),
        revokedAt: new Date(Date.now() - 1000),
        createdAt: new Date(),
        user: {
          id: "user-1",
          email: "test@example.com",
          isApproved: true,
          isEmailVerified: true,
        },
      } as any);

      await expect(
        authenticate(mockRequest as FastifyRequest, mockReply as FastifyReply)
      ).rejects.toThrow(UnauthorizedError);
    });

    it("throws UnauthorizedError when session has expired", async () => {
      mockRequest.headers = { authorization: "Bearer someexpiredtoken" };
      vi.spyOn(prisma.session, "findUnique").mockResolvedValue({
        id: "session-2",
        userId: "user-1",
        tokenHash: "hash",
        expiresAt: new Date(Date.now() - 5000), // in the past
        revokedAt: null,
        createdAt: new Date(),
        user: {
          id: "user-1",
          email: "test@example.com",
          isApproved: true,
          isEmailVerified: true,
        },
      } as any);

      await expect(
        authenticate(mockRequest as FastifyRequest, mockReply as FastifyReply)
      ).rejects.toThrow(UnauthorizedError);
    });

    it("successfully attaches authenticated user to request when session is valid and active", async () => {
      mockRequest.headers = { authorization: "Bearer activevalidtoken" };
      vi.spyOn(prisma.session, "findUnique").mockResolvedValue({
        id: "session-3",
        userId: "user-42",
        tokenHash: "hash",
        expiresAt: new Date(Date.now() + 1000000),
        revokedAt: null,
        createdAt: new Date(),
        user: {
          id: "user-42",
          email: "active@example.com",
          isApproved: true,
          isEmailVerified: true,
        },
      } as any);

      await authenticate(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(mockRequest.user).toEqual({
        id: "user-42",
        email: "active@example.com",
        isApproved: true,
        isEmailVerified: true,
      });
    });
  });

  describe("requireApproved middleware (PRD §4.1 U-02)", () => {
    it("throws UnauthorizedError when user is not present on request", async () => {
      mockRequest.user = undefined;
      await expect(
        requireApproved(mockRequest as FastifyRequest, mockReply as FastifyReply)
      ).rejects.toThrow(UnauthorizedError);
    });

    it("throws ForbiddenError (403) with waiting state message when user is unapproved", async () => {
      mockRequest.user = {
        id: "user-waiting",
        email: "waiting@example.com",
        isApproved: false,
        isEmailVerified: true,
      };

      await expect(
        requireApproved(mockRequest as FastifyRequest, mockReply as FastifyReply)
      ).rejects.toThrow(ForbiddenError);

      try {
        await requireApproved(mockRequest as FastifyRequest, mockReply as FastifyReply);
      } catch (err: any) {
        expect(err.statusCode).toBe(403);
        expect(err.message).toBe("Your account is pending administrator approval. Please wait for an invitation.");
      }
    });

    it("allows execution to continue smoothly when user is approved", async () => {
      mockRequest.user = {
        id: "user-approved",
        email: "approved@example.com",
        isApproved: true,
        isEmailVerified: true,
      };

      await expect(
        requireApproved(mockRequest as FastifyRequest, mockReply as FastifyReply)
      ).resolves.toBeUndefined();
    });
  });
});
