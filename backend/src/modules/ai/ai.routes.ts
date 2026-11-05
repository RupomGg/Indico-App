import { FastifyInstance } from "fastify";
import { AiService } from "./ai.service.js";
import { userAiPromptSchema, adminAiPromptSchema, aiResponseSchema } from "./ai.schemas.js";
import { authenticate, requireApproved, authenticateAdmin } from "../../middleware/auth.js";

export async function aiRoutes(fastify: FastifyInstance) {
  // POST /ai/user/prompt (PRD §4.6 AI-01 to AI-07)
  fastify.post(
    "/user/prompt",
    {
      preHandler: [authenticate, requireApproved],
      schema: {
        description:
          "User AI Assistant: Natural-language financial commands for balance inquiries, loan requests, spending, and repayment previews (PRD §4.6 AI-01 to AI-07)",
        tags: ["AI"],
        body: userAiPromptSchema,
        response: {
          200: aiResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { prompt } = request.body as { prompt: string };
      const userId = request.user!.id;
      const result = await AiService.handleUserPrompt(userId, prompt);
      return reply.send(result);
    }
  );

  // POST /ai/admin/prompt (PRD §4.7 AD-19)
  fastify.post(
    "/admin/prompt",
    {
      preHandler: [authenticateAdmin],
      schema: {
        description:
          "Admin AI Console: Natural-language operations console for pool liquidity, loan supervision, user lookup, and administrative credit issuance/debit previews (PRD §4.7 AD-19)",
        tags: ["AI"],
        body: adminAiPromptSchema,
        response: {
          200: aiResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { prompt } = request.body as { prompt: string };
      const adminId = request.admin!.id;
      const result = await AiService.handleAdminCommand(adminId, prompt);
      return reply.send(result);
    }
  );
}

