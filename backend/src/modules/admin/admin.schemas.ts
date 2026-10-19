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
  isApproved: z.boolean().default(true),
});

export type AdminCreateMerchantInput = z.infer<typeof adminCreateMerchantSchema>;

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
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export type AdminAuditLogQuery = z.infer<typeof adminAuditLogQuerySchema>;
