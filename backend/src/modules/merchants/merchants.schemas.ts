import { z } from "zod";

export const merchantServiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.string(),
  priceUnits: z.string(),
  description: z.string(),
});

export const merchantItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  walletAddress: z.string(),
  contactEmail: z.string(),
  agreementStatus: z.string(),
  services: z.array(merchantServiceSchema),
});

export const merchantListQuerySchema = z.object({
  query: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type MerchantListQuery = z.infer<typeof merchantListQuerySchema>;

export const merchantListResponseSchema = z.object({
  items: z.array(merchantItemSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
  totalPages: z.number(),
});

export type MerchantListResponse = z.infer<typeof merchantListResponseSchema>;
export type MerchantItem = z.infer<typeof merchantItemSchema>;
