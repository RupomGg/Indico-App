import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters long"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  RPC_URL: z.string().url().default("https://sepolia.base.org"),
  CHAIN_ID: z.coerce.number().default(84532),
  INDICO_LEDGER_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid IndicoLedger contract address")
    .default("0x422D36E2198863C5b2A6B8E2865fBf5196de96cF"),
  USDC_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid USDC contract address")
    .default("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_PATH: z.string().default("./storage"),
  DOCUMENT_ENCRYPTION_KEY: z.string().min(32).default("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
  KEEPER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid keeper private key")
    .optional(),
  RUN_WORKER: z.string().optional().default("false"),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(customEnv?: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(customEnv || process.env);
  if (!result.success) {
    const errorMessages = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
    throw new Error(`Environment validation failed: ${errorMessages}`);
  }
  return result.data;
}

export const env = parseEnv();
