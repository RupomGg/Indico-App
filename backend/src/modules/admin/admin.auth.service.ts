import { prisma } from "../../lib/prisma.js";
import { verifyPassword } from "../../lib/crypto.js";
import { UnauthorizedError, ForbiddenError } from "../../lib/errors.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

export class AdminAuthService {
  /**
   * Authenticates admin credentials and returns a signed admin JWT (PRD §4.7 AD-01).
   * Separate session domain from standard users.
   */
  static async login(email: string, password: string) {
    const admin = await prisma.adminUser.findUnique({
      where: { email },
    });

    if (!admin) {
      throw new UnauthorizedError("Invalid admin credentials");
    }

    const isValid = await verifyPassword(password, admin.passwordHash);
    if (!isValid) {
      throw new UnauthorizedError("Invalid admin credentials");
    }

    const token = jwt.sign(
      {
        id: admin.id,
        email: admin.email,
        role: admin.role,
        domain: "admin",
      },
      env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    // Record immutable audit entry
    try {
      await prisma.auditLog.create({
        data: {
          actorType: "ADMIN",
          actorId: admin.id,
          action: "ADMIN_LOGIN",
          resource: "AdminUser",
          resourceId: admin.id,
          payload: { email: admin.email },
        },
      });
    } catch {
      // Audit log failures should not block login if non-fatal
    }

    return {
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        role: admin.role,
      },
    };
  }

  /**
   * Verifies and decodes admin JWT, ensuring caller holds the ADMIN role.
   */
  static async verifyAdminToken(token: string) {
    let decoded: any;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET);
    } catch {
      throw new UnauthorizedError("Invalid or expired admin token");
    }

    if (decoded.role !== "ADMIN" || decoded.domain !== "admin") {
      throw new ForbiddenError("Access forbidden: Requires administrator role");
    }

    const admin = await prisma.adminUser.findUnique({
      where: { id: decoded.id },
    });

    if (!admin) {
      throw new UnauthorizedError("Admin user no longer exists");
    }

    return admin;
  }
}
