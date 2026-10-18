import { z } from "zod";
import { amountSchema } from "../../lib/amount.js";

export const prepareBorrowSchema = z.object({
  amount: amountSchema,
});

export type PrepareBorrowInput = z.infer<typeof prepareBorrowSchema>;

export const prepareBorrowResponseSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: z.string(),
  principal: z.string(),
  principalUnits: z.string(),
  requiredCollateral: z.string(),
  requiredCollateralUnits: z.string(),
  estimatedGasUnits: z.string(),
  gasCostEth: z.string(),
  gasCostUsd: z.string(),
  userEthBalance: z.string(),
  ethShortfall: z.string(),
  ethShortfallUnits: z.string(),
  canAfford: z.boolean(),
});

export type PrepareBorrowResponse = z.infer<typeof prepareBorrowResponseSchema>;

export const prepareRepaySchema = z.object({
  loanId: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/, "loanId must be a positive integer"),
  ]),
});

export type PrepareRepayInput = z.infer<typeof prepareRepaySchema>;

export const preparedTxDetailsSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: z.string(),
  estimatedGasUnits: z.string(),
  gasCostEth: z.string(),
  gasCostUsd: z.string(),
  canAfford: z.boolean(),
});

export const prepareRepayResponseSchema = z.object({
  loanId: z.string(),
  principal: z.string(),
  principalUnits: z.string(),
  collateral: z.string(),
  collateralUnits: z.string(),
  dueDate: z.number(),
  requiresApproval: z.boolean(),
  approvalTx: preparedTxDetailsSchema.nullable(),
  repayTx: preparedTxDetailsSchema,
  userEthBalance: z.string(),
  ethShortfall: z.string(),
  canAfford: z.boolean(),
});

export type PrepareRepayResponse = z.infer<typeof prepareRepayResponseSchema>;

export const prepareExtendSchema = z.object({
  loanId: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/, "loanId must be a positive integer"),
  ]),
});

export type PrepareExtendInput = z.infer<typeof prepareExtendSchema>;

export const prepareExtendResponseSchema = z.object({
  loanId: z.string(),
  dueDate: z.number(),
  newDueDate: z.number(),
  extensionCount: z.number(),
  to: z.string(),
  data: z.string(),
  value: z.string(),
  estimatedGasUnits: z.string(),
  gasCostEth: z.string(),
  gasCostUsd: z.string(),
  userEthBalance: z.string(),
  ethShortfall: z.string(),
  ethShortfallUnits: z.string(),
  canAfford: z.boolean(),
});

export type PrepareExtendResponse = z.infer<typeof prepareExtendResponseSchema>;
