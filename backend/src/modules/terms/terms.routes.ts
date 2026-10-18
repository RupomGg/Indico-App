import { FastifyInstance } from "fastify";
import { TermsService } from "./terms.service.js";
import {
  CurrentTermsResponseSchema,
  TermsStatusResponseSchema,
  PrepareSignTermsResponseSchema,
} from "./terms.schemas.js";
import { authenticate, requireApproved } from "../../middleware/auth.js";

export async function termsRoutes(fastify: FastifyInstance) {
  // Public terms text and active termsHash viewing (PRD §4.1 U-06)
  fastify.get(
    "/current",
    {
      schema: {
        description: "View current platform terms and conditions with on-chain termsHash (U-06)",
        tags: ["Terms"],
        response: {
          200: CurrentTermsResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const terms = await TermsService.getCurrentTerms();
      return reply.send(terms);
    }
  );

  // Protected: Check on-chain terms signed status for authenticated user's wallet
  fastify.get(
    "/status",
    {
      preHandler: [authenticate],
      schema: {
        description: "Check if authenticated user's bound wallet has signed current terms (U-08)",
        tags: ["Terms"],
        response: {
          200: TermsStatusResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const status = await TermsService.getTermsStatus(userId);
      return reply.send(status);
    }
  );

  // Protected: Prepare calldata for on-chain terms signing (PRD §4.1 U-07, U-11, U-12)
  fastify.post(
    "/prepare-sign",
    {
      preHandler: [authenticate, requireApproved],
      schema: {
        description: "Prepare transaction calldata and gas shortfall analysis for signTerms (U-07, U-11, U-12)",
        tags: ["Terms"],
        response: {
          200: PrepareSignTermsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const prepared = await TermsService.prepareSignTermsCalldata(userId);
      return reply.send(prepared);
    }
  );
}
