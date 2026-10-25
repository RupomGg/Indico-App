import { FastifyInstance } from "fastify";
import { HistoryService } from "./history.service.js";
import {
  userBalanceResponseSchema,
  loanListQuerySchema,
  loanListResponseSchema,
  loanItemSchema,
} from "./history.schemas.js";
import { authenticate } from "../../middleware/auth.js";
import { z } from "zod";

export async function historyRoutes(fastify: FastifyInstance) {
  // GET /history/balance (PRD §4.3 C-01)
  fastify.get(
    "/balance",
    {
      preHandler: [authenticate],
      schema: {
        description: "Read available, locked, and total credit balances from read_credit_balances (C-01)",
        tags: ["History"],
        response: {
          200: userBalanceResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const result = await HistoryService.getUserBalance(userId);
      return reply.send(result);
    }
  );

  // GET /history/loans (PRD §4.4 L-09)
  fastify.get(
    "/loans",
    {
      preHandler: [authenticate],
      schema: {
        description: "List user loans with status filtering and pagination from read_loans (L-09)",
        tags: ["History"],
        querystring: loanListQuerySchema,
        response: {
          200: loanListResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const result = await HistoryService.getUserLoans(userId, request.query as any);
      return reply.send(result);
    }
  );

  // GET /history/loans/:loanId
  fastify.get(
    "/loans/:loanId",
    {
      preHandler: [authenticate],
      schema: {
        description: "Get detailed loan status from read_loans",
        tags: ["History"],
        params: z.object({
          loanId: z.string(),
        }),
        response: {
          200: loanItemSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { loanId } = request.params as { loanId: string };
      const result = await HistoryService.getLoanById(userId, loanId);
      return reply.send(result);
    }
  );

  // GET /history/transactions (PRD §4.3 C-01, §4.4 L-09; User on-chain transaction history)
  fastify.get(
    "/transactions",
    {
      preHandler: [authenticate],
      schema: {
        description: "List chronological on-chain transaction events with txHash for the user",
        tags: ["History"],
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const result = await HistoryService.getUserTransactions(userId);
      return reply.send(result);
    }
  );
}
