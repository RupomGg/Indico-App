import { z } from "zod";
import { amountSchema } from "../../lib/amount.js";

export const prepareSpendSchema = z.object({
  merchantAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid merchant Ethereum address"),
  amount: amountSchema,
});

export type PrepareSpendInput = z.infer<typeof prepareSpendSchema>;

export const prepareSpendResponseSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: z.string(),
  merchantAddress: z.string(),
  amount: z.string(),
  amountUnits: z.string(),
  estimatedGasUnits: z.string(),
  gasCostEth: z.string(),
  gasCostUsd: z.string(),
  userEthBalance: z.string(),
  ethShortfall: z.string(),
  ethShortfallUnits: z.string(),
  canAfford: z.boolean(),
});

export type PrepareSpendResponse = z.infer<typeof prepareSpendResponseSchema>;
