import { z } from "zod";

/**
 * User AI Prompt Request (PRD §4.6 AI-01)
 * User natural-language input (1 to 500 characters)
 */
export const userAiPromptSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, "Prompt cannot be empty")
    .max(500, "Prompt cannot exceed 500 characters"),
});

export type UserAiPromptInput = z.infer<typeof userAiPromptSchema>;

/**
 * Admin AI Command Request (PRD §4.7 AD-19)
 * Administrator command input (1 to 500 characters)
 */
export const adminAiPromptSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, "Command cannot be empty")
    .max(500, "Command cannot exceed 500 characters"),
});

export type AdminAiPromptInput = z.infer<typeof adminAiPromptSchema>;

/**
 * Unified AI Response Schema (PRD §4.6 AI-02, AI-03, AI-04; PRD §4.7 AD-19)
 * - MESSAGE: Read-only answers returned immediately with zero wallet signature.
 * - TRANSACTION_PREVIEW: Value-moving intents requiring user wallet signature.
 * - ACTION_PREVIEW: Administrative state changes requiring admin wallet signature.
 * - UNKNOWN: Unmapped/ambiguous intents directing user to standard screens.
 * - ERROR: Graceful failure message (insufficient balance, etc.)
 */
const preparedTxSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: z.string().default("0"),
  estimatedGasEth: z.string().optional(),
});

export const aiResponseSchema = z.object({
  success: z.boolean(),
  type: z.enum(["MESSAGE", "TRANSACTION_PREVIEW", "ACTION_PREVIEW", "UNKNOWN", "ERROR"]),
  intent: z.string(),
  text: z.string(),
  requiresWalletSignature: z.boolean(),
  preview: z.record(z.any()).optional(),
  preparedTx: preparedTxSchema.optional(),
  /** Every transaction to sign, in order. `preparedTx` is set only when there is exactly one. */
  preparedTxs: z.array(preparedTxSchema).optional(),
  /**
   * Buttons under the reply, at most 6. The app sends `prompt`, or puts it in the input box when it
   * ends with a space. A suggestion only fills in a command; money still needs the preview and wallet.
   */
  suggestions: z.array(z.object({ label: z.string(), prompt: z.string() })).max(6).optional(),
});

export type AiResponse = z.infer<typeof aiResponseSchema>;
