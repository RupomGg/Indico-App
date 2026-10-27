import { z } from "zod";
import { amountSchema } from "../../lib/amount.js";

export const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;

export const adminLoginResponseSchema = z.object({
  token: z.string(),
  admin: z.object({
    id: z.string(),
    email: z.string(),
    role: z.string(),
  }),
});

export const adminUserListQuerySchema = z.object({
  status: z.enum(["ALL", "APPROVED", "PENDING"]).default("ALL"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

export const adminCreateMerchantSchema = z.object({
  name: z.string().min(2),
  contactEmail: z.string().email(),
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid merchant Ethereum address"),
  isApproved: z.boolean().default(false),
  agreementStatus: z.enum(["NOT_SENT", "SENT", "SIGNED"]).default("NOT_SENT"),
  initialService: z
    .object({
      name: z.string().min(2),
      price: amountSchema,
      description: z.string().min(1).optional(),
    })
    .optional(),
});

export type AdminCreateMerchantInput = z.infer<typeof adminCreateMerchantSchema>;

export const adminUserOperationResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  isEmailVerified: z.boolean(),
  isApproved: z.boolean(),
  createdAt: z.date().or(z.string()),
  updatedAt: z.date().or(z.string()),
});

export const adminAddServiceSchema = z.object({
  name: z.string().min(2),
  price: amountSchema,
  description: z.string().min(1),
});

export type AdminAddServiceInput = z.infer<typeof adminAddServiceSchema>;

export const adminUpdateServiceSchema = z.object({
  name: z.string().min(2).optional(),
  price: amountSchema.optional(),
  description: z.string().min(1).optional(),
});

export type AdminUpdateServiceInput = z.infer<typeof adminUpdateServiceSchema>;

export const adminAuditLogQuerySchema = z.object({
  action: z.string().optional(),
  actorId: z.string().optional(),
  userId: z.string().optional(),
  category: z.enum(["ALL", "SYSTEM", "TRANSACTION"]).default("ALL").optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(50),
});

export type AdminAuditLogQuery = z.infer<typeof adminAuditLogQuerySchema>;

