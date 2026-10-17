import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AuthService } from "./auth.service.js";
import {
  RegisterRequestSchema,
  RegisterResponseSchema,
  VerifyEmailRequestSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  ResetPasswordRequestSchema,
  ResetPasswordConfirmSchema,
} from "./auth.schemas.js";
import { authenticate } from "../../middleware/auth.js";

const MessageResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    message: z.string(),
  }),
});

export async function authRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // POST /register
  typedApp.post(
    "/register",
    {
      schema: {
        tags: ["Auth"],
        summary: "Register new account (U-01)",
        body: RegisterRequestSchema,
        response: {
          201: RegisterResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await AuthService.register(
        request.body.email,
        request.body.password
      );
      return reply.status(201).send({
        success: true as const,
        data: result,
      });
    }
  );

  // POST /verify-email
  typedApp.post(
    "/verify-email",
    {
      schema: {
        tags: ["Auth"],
        summary: "Verify user email address (U-01)",
        body: VerifyEmailRequestSchema,
        response: {
          200: MessageResponseSchema,
        },
      },
    },
    async (request) => {
      const result = await AuthService.verifyEmail(request.body.token);
      return { success: true as const, data: result };
    }
  );

  // POST /login
  typedApp.post(
    "/login",
    {
      schema: {
        tags: ["Auth"],
        summary: "Login and obtain session token (U-03)",
        body: LoginRequestSchema,
        response: {
          200: LoginResponseSchema,
        },
      },
    },
    async (request) => {
      const result = await AuthService.login(
        request.body.email,
        request.body.password
      );
      return { success: true as const, data: result };
    }
  );

  // POST /logout
  typedApp.post(
    "/logout",
    {
      preHandler: [authenticate],
      schema: {
        tags: ["Auth"],
        summary: "Logout and revoke active session (U-03)",
        security: [{ bearerAuth: [] }],
        response: {
          200: MessageResponseSchema,
        },
      },
    },
    async (request) => {
      const result = await AuthService.logout(request.session!.tokenHash);
      return { success: true as const, data: result };
    }
  );

  // POST /refresh
  typedApp.post(
    "/refresh",
    {
      preHandler: [authenticate],
      schema: {
        tags: ["Auth"],
        summary: "Refresh active session token",
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.object({
              token: z.string(),
              expiresAt: z.string(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const result = await AuthService.refresh(request.session!.tokenHash);
      return { success: true as const, data: result };
    }
  );

  // POST /reset-password/request
  typedApp.post(
    "/reset-password/request",
    {
      schema: {
        tags: ["Auth"],
        summary: "Request a password reset link (U-03)",
        body: ResetPasswordRequestSchema,
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.object({
              message: z.string(),
              resetToken: z.string().optional(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const result = await AuthService.requestPasswordReset(request.body.email);
      return { success: true as const, data: result };
    }
  );

  // POST /reset-password/confirm
  typedApp.post(
    "/reset-password/confirm",
    {
      schema: {
        tags: ["Auth"],
        summary: "Confirm password reset with new password (U-03)",
        body: ResetPasswordConfirmSchema,
        response: {
          200: MessageResponseSchema,
        },
      },
    },
    async (request) => {
      const result = await AuthService.confirmPasswordReset(
        request.body.token,
        request.body.newPassword
      );
      return { success: true as const, data: result };
    }
  );
}
