import { z } from "zod";

export const CurrentTermsResponseSchema = z.object({
  version: z.string(),
  termsHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Invalid termsHash"),
  title: z.string(),
  content: z.string(),
  effectiveDate: z.string(),
  isOnChainSet: z.boolean().optional(),
});

export const TermsStatusResponseSchema = z.object({
  hasBoundWallet: z.boolean(),
  walletAddress: z.string().nullable(),
  termsSigned: z.boolean(),
  termsHash: z.string(),
  signedTermsHash: z.string().nullable(),
});

export const PrepareSignTermsResponseSchema = z.object({
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
  termsHash: z.string(),
});

export type CurrentTermsResponse = z.infer<typeof CurrentTermsResponseSchema>;
export type TermsStatusResponse = z.infer<typeof TermsStatusResponseSchema>;
export type PrepareSignTermsResponse = z.infer<typeof PrepareSignTermsResponseSchema>;
