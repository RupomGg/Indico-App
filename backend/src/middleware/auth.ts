import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../lib/prisma.js";
import { hashToken } from "../lib/crypto.js";
import { UnauthorizedError, ForbiddenError } from "../lib/errors.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  isEmailVerified: boolean;
  isApproved: boolean;
}

export interface AuthenticatedAdmin {
  id: string;
  email: string;
  role: string;
}

export interface AuthenticatedSession {
  id: string;
  userId: string;
  tokenHash: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    session?: AuthenticatedSession;
    admin?: AuthenticatedAdmin;
  }
}

/**
 * Middleware requiring a valid bearer token.
 * Populates request.user and request.session.
 */
export async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid Authorization header");
  }

  const rawToken = authHeader.substring(7).trim();
  if (!rawToken) {
    throw new UnauthorizedError("Bearer token cannot be empty");
  }

  const tokenHash = hashToken(rawToken);

  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          isEmailVerified: true,
          isApproved: true,
        },
      },
    },
  });

  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    throw new UnauthorizedError("Session is invalid or has expired");
  }

  request.user = session.user;
  request.session = {
    id: session.id,
    userId: session.userId,
    tokenHash: session.tokenHash,
  };
}

/**
 * Middleware ensuring user is approved by an administrator (PRD §4.1 U-02).
 * An unapproved user gets 403 and nothing else.
 */
export async function requireApproved(request: FastifyRequest, _reply: FastifyReply) {
  if (!request.user) {
    throw new UnauthorizedError();
  }

  if (!request.user.isApproved) {
    throw new ForbiddenError(
      "Your account is pending administrator approval. Please wait for an invitation."
    );
  }
}

/**
 * Middleware ensuring caller is an authenticated administrator (PRD §4.7 AD-01; Gate G10).
 * Rejects non-admin or unauthenticated sessions with 401/403.
 */
export async function authenticateAdmin(request: FastifyRequest, _reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid Authorization header");
  }

  const rawToken = authHeader.substring(7).trim();
  if (!rawToken) {
    throw new UnauthorizedError("Bearer token cannot be empty");
  }

  const { AdminAuthService } = await import("../modules/admin/admin.auth.service.js");
  const admin = await AdminAuthService.verifyAdminToken(rawToken);

  request.admin = {
    id: admin.id,
    email: admin.email,
    role: admin.role,
  };
}
