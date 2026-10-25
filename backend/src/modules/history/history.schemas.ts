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

export const userTransactionItemSchema = z.object({
  id: z.string(),
  txHash: z.string(),
  logIndex: z.number(),
  eventName: z.string(),
  blockNumber: z.string(),
  blockTimestamp: z.number(),
  data: z.record(z.any()),
  explorerUrl: z.string(),
});

export type UserTransactionItem = z.infer<typeof userTransactionItemSchema>;

export const userTransactionsResponseSchema = z.object({
  items: z.array(userTransactionItemSchema),
  total: z.number(),
});

export type UserTransactionsResponse = z.infer<typeof userTransactionsResponseSchema>;
