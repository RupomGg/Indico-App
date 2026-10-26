import { FastifyInstance } from "fastify";
import { AdminAuthService } from "./admin.auth.service.js";
import { AdminOperationsService } from "./admin.operations.service.js";
import {
  adminLoginSchema,
  adminLoginResponseSchema,
  adminUserListQuerySchema,
  adminCreateMerchantSchema,
  adminAddServiceSchema,
  adminUpdateServiceSchema,
  adminAuditLogQuerySchema,
} from "./admin.schemas.js";
import { authenticateAdmin } from "../../middleware/auth.js";
import { z } from "zod";

export async function adminRoutes(fastify: FastifyInstance) {
  // POST /admin/auth/login (PRD §4.7 AD-01)
  fastify.post(
    "/auth/login",
    {
      schema: {
        description: "Authenticate administrator and establish admin session (AD-01)",
        tags: ["Admin"],
        body: adminLoginSchema,
        response: {
          200: adminLoginResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body as any;
      const result = await AdminAuthService.login(email, password);
      return reply.send(result);
    }
  );

  // All subsequent routes require Admin authentication (PRD §4.7 AD-01; Gate G10)
  fastify.register(async (adminScope) => {
    adminScope.addHook("preHandler", authenticateAdmin);

    // GET /admin/auth/me
    adminScope.get(
      "/auth/me",
      {
        schema: {
          description: "Get current authenticated administrator details",
          tags: ["Admin"],
        },
      },
      async (request, reply) => {
        return reply.send({ admin: request.admin });
      }
    );

    // GET /admin/users (PRD §4.7 AD-02)
    adminScope.get(
      "/users",
      {
        schema: {
          description: "List registered users with status filtering and pagination (AD-02)",
          tags: ["Admin"],
          querystring: adminUserListQuerySchema,
        },
      },
      async (request, reply) => {
        const result = await AdminOperationsService.listUsers(request.query as any);
        return reply.send(result);
      }
    );

    // GET /admin/users/:id (PRD §4.7 AD-03)
    adminScope.get(
      "/users/:id",
      {
        schema: {
          description: "View user's balance, assets, loans, history and wallet address (AD-03)",
          tags: ["Admin"],
          params: z.object({ id: z.string() }),
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const result = await AdminOperationsService.getUserDetail(id);
        return reply.send(result);
      }
    );

    // POST /admin/users/:id/approve (PRD §4.7 AD-02, O-024)
    adminScope.post(
      "/users/:id/approve",
      {
        schema: {
          description: "Approve a user account; warns that on-chain role becomes permanent (AD-02, D-22)",
          tags: ["Admin"],
          params: z.object({ id: z.string() }),
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const result = await AdminOperationsService.approveUser(request.admin!.id, id);
        return reply.send(result);
      }
    );

    // POST /admin/users/:id/reject (PRD §4.7 AD-02)
    adminScope.post(
      "/users/:id/reject",
      {
        schema: {
          description: "Decline or revoke a user account (AD-02)",
          tags: ["Admin"],
          params: z.object({ id: z.string() }),
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const result = await AdminOperationsService.rejectUser(request.admin!.id, id);
        return reply.send(result);
      }
    );

    // GET /admin/merchants (PRD §4.7 AD-04, AD-05)
    adminScope.get(
      "/merchants",
      {
        schema: {
          description: "List all merchants with services and agreement metadata for admin (AD-04, AD-05)",
          tags: ["Admin"],
        },
      },
      async (_request, reply) => {
        const result = await AdminOperationsService.listMerchants();
        return reply.send(result);
      }
    );

    // GET /admin/merchants/:id/services (PRD §4.7 AD-05)
    adminScope.get(
      "/merchants/:id/services",
      {
        schema: {
          description: "Get all service offerings for a merchant (AD-05)",
          tags: ["Admin"],
          params: z.object({ id: z.string() }),
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const result = await AdminOperationsService.getMerchantServices(id);
        return reply.send(result);
      }
    );

    // POST /admin/merchants (PRD §4.7 AD-04)
    adminScope.post(
      "/merchants",
      {
        schema: {
          description: "Add a merchant with wallet address and contact details (AD-04)",
          tags: ["Admin"],
          body: adminCreateMerchantSchema,
        },
      },
      async (request, reply) => {
        const result = await AdminOperationsService.createMerchant(
          request.admin!.id,
          request.body as any
        );
        return reply.send(result);
      }
    );

    // POST /admin/merchants/:id/sync-chain (PRD §4.7 AD-04)
    adminScope.post(
      "/merchants/:id/sync-chain",
      {
        schema: {
          description: "Sync on-chain verification and terms status for a merchant (AD-04)",
          tags: ["Admin"],
          params: z.object({ id: z.string() }),
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const result = await AdminOperationsService.syncMerchantOnChainStatus(
          request.admin!.id,
          id
        );
        return reply.send(result);
      }
    );

    // POST /admin/merchants/:id/services (PRD §4.7 AD-05)
    adminScope.post(
      "/merchants/:id/services",
      {
        schema: {
          description: "Add a service and price offering to a merchant (AD-05)",
          tags: ["Admin"],
          params: z.object({ id: z.string() }),
          body: adminAddServiceSchema,
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const result = await AdminOperationsService.addMerchantService(
          request.admin!.id,
          id,
          request.body as any
        );
        return reply.send(result);
      }
    );

    // PATCH /admin/merchants/:id/services/:serviceId (PRD §4.7 AD-05)
    adminScope.patch(
      "/merchants/:id/services/:serviceId",
      {
        schema: {
          description: "Edit a merchant's service name, price, or description (AD-05)",
          tags: ["Admin"],
          params: z.object({ id: z.string(), serviceId: z.string() }),
          body: adminUpdateServiceSchema,
        },
      },
      async (request, reply) => {
        const { id, serviceId } = request.params as { id: string; serviceId: string };
        const result = await AdminOperationsService.updateMerchantService(
          request.admin!.id,
          id,
          serviceId,
          request.body as any
        );
        return reply.send(result);
      }
    );

    // DELETE /admin/merchants/:id/services/:serviceId (PRD §4.7 AD-05)
    adminScope.delete(
      "/merchants/:id/services/:serviceId",
      {
        schema: {
          description: "Delete a merchant's service offering (AD-05)",
          tags: ["Admin"],
          params: z.object({ id: z.string(), serviceId: z.string() }),
        },
      },
      async (request, reply) => {
        const { id, serviceId } = request.params as { id: string; serviceId: string };
        const result = await AdminOperationsService.deleteMerchantService(
          request.admin!.id,
          id,
          serviceId
        );
        return reply.send(result);
      }
    );

    // POST /admin/merchants/:id/agreement/send (PRD §4.7 AD-06)
    adminScope.post(
      "/merchants/:id/agreement/send",
      {
        schema: {
          description: "Send arbitration agreement email to merchant and record date (AD-06, AD-08)",
          tags: ["Admin"],
          params: z.object({ id: z.string() }),
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const result = await AdminOperationsService.sendMerchantAgreement(
          request.admin!.id,
          id
        );
        return reply.send(result);
      }
    );

    // POST /admin/merchants/:id/agreement/sign (PRD §4.7 AD-07)
    adminScope.post(
      "/merchants/:id/agreement/sign",
      {
        schema: {
          description: "Mark arbitration agreement as signed and store signed copy key (AD-07, AD-08)",
          tags: ["Admin"],
          params: z.object({ id: z.string() }),
          body: z.object({ storageKey: z.string() }),
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const { storageKey } = request.body as { storageKey: string };
        const result = await AdminOperationsService.signMerchantAgreement(
          request.admin!.id,
          id,
          storageKey
        );
        return reply.send(result);
      }
    );

    // GET /admin/pool (PRD §4.7 AD-13)
    adminScope.get(
      "/pool",
      {
        schema: {
          description: "Pool dashboard showing total deposits, lent out, and available cash (AD-13)",
          tags: ["Admin"],
        },
      },
      async (_request, reply) => {
        const result = await AdminOperationsService.getPoolDashboard();
        return reply.send(result);
      }
    );

    // GET /admin/loans (PRD §4.7 AD-15, AD-21)
    adminScope.get(
      "/loans",
      {
        schema: {
          description: "List active, repaid and defaulted loans with liquidation status (AD-15, AD-21)",
          tags: ["Admin"],
          querystring: z.object({
            page: z.coerce.number().int().positive().default(1),
            limit: z.coerce.number().int().positive().max(100).default(20),
          }),
        },
      },
      async (request, reply) => {
        const result = await AdminOperationsService.getLoansDashboard(request.query as any);
        return reply.send(result);
      }
    );

    // GET /admin/safe-status (PRD §4.7 AD-22)
    adminScope.get(
      "/safe-status",
      {
        schema: {
          description: "Inspect Safe multisig Base ETH balance and warn when low (AD-22)",
          tags: ["Admin"],
        },
      },
      async (_request, reply) => {
        const result = await AdminOperationsService.getSafeStatus();
        return reply.send(result);
      }
    );

    // GET /admin/audit-logs (PRD §4.7 AD-16)
    adminScope.get(
      "/audit-logs",
      {
        schema: {
          description: "Complete immutable audit log query (AD-16) with system/transaction categories, user audit, and date filtering",
          tags: ["Admin"],
          querystring: adminAuditLogQuerySchema,
        },
      },
      async (request, reply) => {
        const result = await AdminOperationsService.listAuditLogs(request.query as any);
        return reply.send(result);
      }
    );

    // GET /admin/audit-logs/user/:userId (AD-16 User-Specific Audit Trail)
    adminScope.get(
      "/audit-logs/user/:userId",
      {
        schema: {
          description: "User-specific immutable audit trail query (AD-16) across system actions and financial transactions",
          tags: ["Admin"],
          params: z.object({ userId: z.string() }),
          querystring: adminAuditLogQuerySchema.omit({ userId: true }),
        },
      },
      async (request, reply) => {
        const query = {
          ...(request.query as any),
          userId: (request.params as any).userId,
        };
        const result = await AdminOperationsService.listAuditLogs(query);
        return reply.send(result);
      }
    );
  });
}

