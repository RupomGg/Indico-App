import { FastifyInstance } from "fastify";
import { LoansService } from "./loans.service.js";
import {
  prepareBorrowSchema,
  prepareBorrowResponseSchema,
  prepareRepaySchema,
  prepareRepayResponseSchema,
  prepareExtendSchema,
  prepareExtendResponseSchema,
} from "./loans.schemas.js";
import { authenticate, requireApproved } from "../../middleware/auth.js";
import { z } from "zod";

export async function loansRoutes(fastify: FastifyInstance) {
  // GET /loans/pool-available (PRD §4.4 L-04): read on demand, one ledger call
  fastify.get(
    "/pool-available",
    {
      preHandler: [authenticate],
      schema: {
        description: "USDC the pool can lend right now; a loan above it is refused (L-04)",
        tags: ["Loans"],
        response: {
          200: z.object({ poolAvailable: z.string(), poolAvailableUnits: z.string() }),
        },
      },
    },
    async (_request, reply) => reply.send(await LoansService.getPoolAvailable())
  );

  // POST /loans/prepare-borrow (PRD §4.1 U-11; §4.4 L-01 to L-10)
  fastify.post(
    "/prepare-borrow",
    {
      preHandler: [authenticate, requireApproved],
      schema: {
        description:
          "Prepare transaction calldata and gas shortfall analysis for borrowing USDC against locked credit collateral (L-01 to L-10, U-11)",
        tags: ["Loans"],
        body: prepareBorrowSchema,
        response: {
          200: prepareBorrowResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const result = await LoansService.prepareBorrowCalldata(userId, request.body as any);
      return reply.send(result);
    }
  );

  // POST /loans/prepare-repay (PRD §4.5 R-01 to R-03)
  // Allowed for revoked borrowers so they can repay (D-09)
  fastify.post(
    "/prepare-repay",
    {
      preHandler: [authenticate],
      schema: {
        description:
          "Prepare transaction calldata for repaying loan principal in USDC, including 2-step approval if allowance < principal (R-01 to R-03, U-11)",
        tags: ["Loans"],
        body: prepareRepaySchema,
        response: {
          200: prepareRepayResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const result = await LoansService.prepareRepayCalldata(userId, request.body as any);
      return reply.send(result);
    }
  );

  // POST /loans/prepare-extend (PRD §4.5 R-05, R-06)
  fastify.post(
    "/prepare-extend",
    {
      preHandler: [authenticate, requireApproved],
      schema: {
        description:
          "Prepare transaction calldata for extending loan due date by 90 days inside the 30-day window (R-05, R-06, U-11)",
        tags: ["Loans"],
        body: prepareExtendSchema,
        response: {
          200: prepareExtendResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const result = await LoansService.prepareExtendCalldata(userId, request.body as any);
      return reply.send(result);
    }
  );
}
