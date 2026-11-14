import { z } from "zod";
import { newPasswordSchema } from "../../lib/password.js";

export const ProfileResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    isEmailVerified: z.boolean(),
    isApproved: z.boolean(),
    walletAddress: z.string().nullable(),
    accountRef: z.string().nullable(),
    createdAt: z.string(),
  }),
});

export const BindWalletRequestSchema = z.object({
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum wallet address format")
    .transform((val) => val.toLowerCase()),
  accountRef: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, "accountRef must be a 32-byte hex string (64 characters)")
    .transform((val) => val.toLowerCase()),
  signature: z
    .string()
    .regex(/^0x[a-fA-F0-9]{130}$/, "Invalid signature format (must be 65 bytes / 130 hex characters)"),
  message: z.string().min(1, "Signed message cannot be empty"),
});

export const WalletStatusResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    isBound: z.boolean(),
    walletAddress: z.string().nullable(),
    accountRef: z.string().nullable(),
    boundAt: z.string().nullable(),
    ethBalance: z.string().optional(),
    isTermsSignedOnChain: z.boolean(),
    isUserApprovedOnChain: z.boolean(),
  }),
});

export const UpdateProfileRequestSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: newPasswordSchema("New password"),
});

