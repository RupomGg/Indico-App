import { FastifyInstance } from "fastify";
import { MerchantsService } from "./merchants.service.js";
import {
  merchantListQuerySchema,
  merchantListResponseSchema,
  merchantItemSchema,
} from "./merchants.schemas.js";
import { authenticate } from "../../middleware/auth.js";
import { z } from "zod";

export async function merchantsRoutes(fastify: FastifyInstance) {
  // GET /merchants (PRD §4.3 C-03)
  fastify.get(
    "/",
    {
      preHandler: [authenticate],
      schema: {
        description: "List admin-approved merchants with their service offerings and pricing (C-03)",
        tags: ["Merchants"],
        querystring: merchantListQuerySchema,
        response: {
          200: merchantListResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await MerchantsService.listMerchants(request.query as any);
      return reply.send(result);
    }
  );

  // GET /merchants/:id (PRD §4.3 C-04)
  fastify.get(
    "/:id",
    {
      preHandler: [authenticate],
      schema: {
        description: "Get detailed service offering and pricing for an approved merchant (C-04)",
        tags: ["Merchants"],
        params: z.object({
          id: z.string(),
        }),
        response: {
          200: merchantItemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await MerchantsService.getMerchantById(id);
      return reply.send(result);
    }
  );
}
