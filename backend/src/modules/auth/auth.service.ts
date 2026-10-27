import { prisma } from "../../lib/prisma.js";
import {
  hashPassword,
  verifyPassword,
  generateSecureToken,
  hashToken,
} from "../../lib/crypto.js";
import {
  BadRequestError,
  ConflictError,
  UnauthorizedError,
} from "../../lib/errors.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export class AuthService {
  /**
   * Registers a new user account (PRD §4.1 U-01).
   */
  static async register(email: string, password: string) {
    const existing = await prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      throw new ConflictError("An account with this email address already exists");
    }

    const passwordHash = await hashPassword(password);
    const rawVerificationToken = generateSecureToken();
    const verificationTokenHash = hashToken(rawVerificationToken);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        isEmailVerified: false,
        emailVerifyToken: verificationTokenHash,
        emailVerifyExpiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
        isApproved: false,
      },
    });

    return {
      userId: user.id,
      email: user.email,
      message: "Registration successful. Please verify your email.",
      verificationToken:
        process.env["NODE_ENV"] !== "production" ? rawVerificationToken : undefined,
    };
  }

  /**
   * Verifies an email using the token received (PRD §4.1 U-01).
   */
  static async verifyEmail(rawToken: string) {
    const tokenHash = hashToken(rawToken);

    const user = await prisma.user.findFirst({
      where: {
        emailVerifyToken: tokenHash,
        emailVerifyExpiresAt: {
          gt: new Date(),
        },
      },
    });

    if (!user) {
      throw new BadRequestError("Invalid or expired verification token");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        isEmailVerified: true,
        emailVerifyToken: null,
        emailVerifyExpiresAt: null,
      },
    });

    return { message: "Email successfully verified. You may now log in." };
  }

  /**
   * Authenticates user credentials and establishes a session (PRD §4.1 U-03).
   */
  static async login(email: string, password: string) {
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new UnauthorizedError("Invalid email or password");
    }

    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedError("Invalid email or password");
    }

    // Generate session token
    const rawSessionToken = generateSecureToken(32);
    const tokenHash = hashToken(rawSessionToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    return {
      token: rawSessionToken,
      expiresAt: expiresAt.toISOString(),
      user: {
        id: user.id,
        email: user.email,
        isEmailVerified: user.isEmailVerified,
        isApproved: user.isApproved,
      },
    };
  }

  /**
   * Revokes the active session token (PRD §4.1 U-03).
   */
  static async logout(tokenHash: string) {
    await prisma.session.updateMany({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });

    return { message: "Successfully logged out" };
  }

  /**
   * Rotates a session token before expiration.
   */
  static async refresh(currentTokenHash: string) {
    const session = await prisma.session.findUnique({
      where: { tokenHash: currentTokenHash },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw new UnauthorizedError("Invalid session");
    }

    // Revoke old session
    await prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    // Create new session
    const newRawToken = generateSecureToken(32);
    const newTokenHash = hashToken(newRawToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await prisma.session.create({
      data: {
        userId: session.userId,
        tokenHash: newTokenHash,
        expiresAt,
      },
    });

    return {
      token: newRawToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Requests a password reset token (PRD §4.1 U-03).
   */
  static async requestPasswordReset(email: string) {
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      // Do not disclose whether email exists (security practice)
      return { message: "If that email exists, a password reset token has been issued." };
    }

    const rawResetToken = generateSecureToken();
    const resetTokenHash = hashToken(rawResetToken);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: resetTokenHash,
        passwordResetExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });

    return {
      message: "If that email exists, a password reset token has been issued.",
      resetToken: process.env["NODE_ENV"] !== "production" ? rawResetToken : undefined,
    };
  }

  /**
   * Confirms password reset and revokes all active sessions (PRD §4.1 U-03).
   */
  static async confirmPasswordReset(rawToken: string, newPassword: string) {
    const tokenHash = hashToken(rawToken);

    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: tokenHash,
        passwordResetExpiresAt: {
          gt: new Date(),
        },
      },
    });

    if (!user) {
      throw new BadRequestError("Invalid or expired password reset token");
    }

    const newPasswordHash = await hashPassword(newPassword);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: newPasswordHash,
          passwordResetToken: null,
          passwordResetExpiresAt: null,
        },
      }),
      // Revoke all existing sessions for this user
      prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    return { message: "Password reset successful. Please log in with your new password." };
  }
}
