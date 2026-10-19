import { z } from "zod";

export const userBalanceResponseSchema = z.object({
  walletAddress: z.string(),
  credit: z.string(),
  creditUnits: z.string(),
  lockedCredit: z.string(),
  lockedCreditUnits: z.string(),
  availableCredit: z.string(),
  availableCreditUnits: z.string(),
});

export type UserBalanceResponse = z.infer<typeof userBalanceResponseSchema>;

export const loanItemSchema = z.object({
  loanId: z.string(),
  borrower: z.string(),
  principal: z.string(),
  principalUnits: z.string(),
  collateral: z.string(),
  collateralUnits: z.string(),
  dueDate: z.number(),
  extensionCount: z.number(),
  status: z.string(),
  openedAtBlock: z.string(),
  repaidAtBlock: z.string().nullable(),
  defaultedAtBlock: z.string().nullable(),
});

export type LoanItem = z.infer<typeof loanItemSchema>;

export const loanListQuerySchema = z.object({
  status: z.enum(["ALL", "ACTIVE", "REPAID", "DEFAULTED"]).default("ALL"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type LoanListQuery = z.infer<typeof loanListQuerySchema>;

export const loanListResponseSchema = z.object({
  items: z.array(loanItemSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
  totalPages: z.number(),
});

export type LoanListResponse = z.infer<typeof loanListResponseSchema>;
