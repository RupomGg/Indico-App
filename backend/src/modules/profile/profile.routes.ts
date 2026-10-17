import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ProfileService } from "./profile.service.js";
import {
  ProfileResponseSchema,
  BindWalletRequestSchema,
  WalletStatusResponseSchema,
  UpdateProfileRequestSchema,
} from "./profile.schemas.js";
import { authenticate } from "../../middleware/auth.js";

export async function profileRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // GET /profile
  typedApp.get(
    "/",
    {
      preHandler: [authenticate],
      schema: {
        tags: ["Profile"],
        summary: "Get current user profile and account status (U-09)",
        security: [{ bearerAuth: [] }],
        response: {
          200: ProfileResponseSchema,
        },
      },
    },
    async (request) => {
      const result = await ProfileService.getProfile(request.user!.id);
      return { success: true as const, data: result };
    }
  );

  // PATCH /profile
  typedApp.patch(
    "/",
    {
      preHandler: [authenticate],
      schema: {
        tags: ["Profile"],
        summary: "Update profile credentials/password (U-09)",
        security: [{ bearerAuth: [] }],
        body: UpdateProfileRequestSchema,
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.object({
              message: z.string(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const result = await ProfileService.updateProfile(
        request.user!.id,
        request.body.currentPassword,
        request.body.newPassword
      );
      return { success: true as const, data: result };
    }
  );

  // GET /profile/wallet
  typedApp.get(
    "/wallet",
    {
      preHandler: [authenticate],
      schema: {
        tags: ["Profile"],
        summary: "Get connected wallet status, ETH balance and contract state (U-09, U-10)",
        security: [{ bearerAuth: [] }],
        response: {
          200: WalletStatusResponseSchema,
        },
      },
    },
    async (request) => {
      const result = await ProfileService.getWalletStatus(request.user!.id);
      return { success: true as const, data: result };
    }
  );

  // POST /profile/wallet/bind
  typedApp.post(
    "/wallet/bind",
    {
      preHandler: [authenticate],
      schema: {
        tags: ["Profile"],
        summary: "Cryptographically bind an external wallet with signature (U-04, U-05)",
        security: [{ bearerAuth: [] }],
        body: BindWalletRequestSchema,
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.object({
              message: z.string(),
              walletAddress: z.string(),
              accountRef: z.string(),
              boundAt: z.string(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const result = await ProfileService.bindWallet(
        request.user!.id,
        request.body.walletAddress,
        request.body.accountRef,
        request.body.signature as `0x${string}`,
        request.body.message
      );
      return { success: true as const, data: result };
    }
  );
}
