import { describe, it, expect, vi, beforeEach } from "vitest";
import { AdminAuthService } from "../../src/modules/admin/admin.auth.service.js";
import { prisma } from "../../src/lib/prisma.js";
import { UnauthorizedError, ForbiddenError } from "../../src/lib/errors.js";
import { hashPassword } from "../../src/lib/crypto.js";
import jwt from "jsonwebtoken";
import { env } from "../../src/config/env.js";

/**
 * =======================================================================================
 * INPUT PARTITION TABLE: Admin Authentication & RBAC (PRD §4.7 AD-01; docs/input-testing.md)
 * =======================================================================================
 * 
 * Parameter: Credentials (email, password)
 * | Class               | Value                      | Expected Result                               |
 * |---------------------|----------------------------|-----------------------------------------------|
 * | Non-existent admin  | "ghost@admin.com", "pass"  | Reject 401 Unauthorized                       |
 * | Wrong password      | "admin@indico.com", "bad"  | Reject 401 Unauthorized                       |
 * | Correct credentials | "admin@indico.com", "good" | Return 200 OK + JWT (role: ADMIN)             |
 * 
 * Parameter: Authorization Header (Admin Endpoints)
 * | Class               | Value                      | Expected Result                               |
 * |---------------------|----------------------------|-----------------------------------------------|
 * | No header           | null                       | Reject 401 Unauthorized                       |
 * | Invalid bearer      | "Bearer bad-token"         | Reject 401 Unauthorized                       |
 * | User token (RBAC)   | userSessionToken           | Reject 403 Forbidden (Non-admin access)       |
 * | Valid admin JWT     | adminJwtToken              | Success 200 OK                                |
 * =======================================================================================
 */

describe("Admin Authentication & RBAC (PRD §4.7 AD-01; Gate G10)", () => {
  const mockAdminId = "admin-1";
  const mockEmail = "admin@indico.com";
  const mockPassword = "SecureAdminPass123!";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("login", () => {
    it("throws UnauthorizedError if admin email does not exist", async () => {
      vi.spyOn(prisma.adminUser, "findUnique").mockResolvedValue(null);

      await expect(
        AdminAuthService.login("unknown@admin.com", "any-password")
      ).rejects.toThrow(UnauthorizedError);
    });

    it("throws UnauthorizedError if password does not match", async () => {
      const realHash = await hashPassword(mockPassword);
      vi.spyOn(prisma.adminUser, "findUnique").mockResolvedValue({
        id: mockAdminId,
        email: mockEmail,
        passwordHash: realHash,
        role: "ADMIN",
        createdAt: new Date(),
      });

      await expect(
        AdminAuthService.login(mockEmail, "WrongPassword999!")
      ).rejects.toThrow(UnauthorizedError);
    });

    it("returns signed JWT token and admin details on valid credentials", async () => {
      const realHash = await hashPassword(mockPassword);
      vi.spyOn(prisma.adminUser, "findUnique").mockResolvedValue({
        id: mockAdminId,
        email: mockEmail,
        passwordHash: realHash,
        role: "ADMIN",
        createdAt: new Date(),
      });

      vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const result = await AdminAuthService.login(mockEmail, mockPassword);
      expect(result.token).toBeDefined();
      expect(result.admin.id).toBe(mockAdminId);
      expect(result.admin.email).toBe(mockEmail);
      expect(result.admin.role).toBe("ADMIN");

      // Verify JWT payload
      const decoded = jwt.verify(result.token, env.JWT_SECRET) as any;
      expect(decoded.id).toBe(mockAdminId);
      expect(decoded.role).toBe("ADMIN");
      expect(decoded.domain).toBe("admin");

      // Verify audit log call
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorType: "ADMIN",
            actorId: mockAdminId,
            action: "ADMIN_LOGIN",
            resource: "AdminUser",
          }),
        })
      );
    });
  });

  describe("verifyAdminToken", () => {
    it("throws UnauthorizedError for malformed or expired JWT", async () => {
      await expect(AdminAuthService.verifyAdminToken("bad-jwt-string")).rejects.toThrow(
        UnauthorizedError
      );
    });

    it("throws ForbiddenError if token belongs to a non-admin role", async () => {
      const userToken = jwt.sign(
        { id: "user-123", email: "user@test.com", role: "USER", domain: "user" },
        env.JWT_SECRET
      );

      await expect(AdminAuthService.verifyAdminToken(userToken)).rejects.toThrow(
        ForbiddenError
      );
    });

    it("returns admin user when valid admin token is verified", async () => {
      const adminToken = jwt.sign(
        { id: mockAdminId, email: mockEmail, role: "ADMIN", domain: "admin" },
        env.JWT_SECRET
      );

      vi.spyOn(prisma.adminUser, "findUnique").mockResolvedValue({
        id: mockAdminId,
        email: mockEmail,
        passwordHash: "hash",
        role: "ADMIN",
        createdAt: new Date(),
      });

      const admin = await AdminAuthService.verifyAdminToken(adminToken);
      expect(admin.id).toBe(mockAdminId);
      expect(admin.role).toBe("ADMIN");
    });
  });
});
