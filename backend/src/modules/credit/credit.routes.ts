import { FastifyInstance } from "fastify";
import { CreditService } from "./credit.service.js";
import {
  prepareSpendSchema,
  prepareSpendResponseSchema,
} from "./credit.schemas.js";
import { authenticate, requireApproved } from "../../middleware/auth.js";

export async function creditRoutes(fastify: FastifyInstance) {
  // POST /credit/prepare-spend (PRD §4.3 C-01 to C-08; U-11)
  fastify.post(
    "/prepare-spend",
    {
      preHandler: [authenticate, requireApproved],
      schema: {
        description:
          "Prepare transaction calldata and gas shortfall analysis for spending credit with an approved merchant (C-01 to C-08, U-11)",
        tags: ["Credit"],
        body: prepareSpendSchema,
        response: {
          200: prepareSpendResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const result = await CreditService.prepareSpendCalldata(userId, request.body as any);
      return reply.send(result);
    }
  );
}
