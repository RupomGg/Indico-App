import { z } from "zod";
import { parseAmount } from "../../lib/amount.js";

// Accepted MIME types (PRD §4.2 A-01: PDF, PNG, JPEG)
export const ACCEPTED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
] as const;

export const PresignedUploadInputSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSizeBytes: z
    .number()
    .int()
    .min(1, "File must not be empty (0 bytes)")
    .max(20 * 1024 * 1024, "File exceeds maximum size of 20 MB"),
  mimeType: z.enum(ACCEPTED_MIME_TYPES, {
    errorMap: () => ({ message: "Accepted file types are: application/pdf, image/png, image/jpeg" }),
  }),
});

export const PresignedUploadResponseSchema = z.object({
  uploadId: z.string(),
  uploadUrl: z.string(),
  expiresAt: z.string(),
  maxSizeBytes: z.number(),
});

export const SubmitAssetInputSchema = z.object({
  uploadId: z.string().min(1, "uploadId is required"),
  docHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "docHash must be a 66-character 0x-prefixed hex string"),
  assetType: z
    .number()
    .int()
    .min(0, "assetType must be between 0 and 5")
    .max(5, "assetType must be between 0 and 5 (PRD D-29)"),
  declaredValueUsdc: z
    .string()
    .regex(/^\d+\.\d{6}$/, "declaredValueUsdc must be a decimal string with exactly 6 decimal places")
    .refine((val) => {
      try {
        const units = parseAmount(val);
        return units > 0n;
      } catch {
        return false;
      }
    }, "declaredValueUsdc must be greater than zero"),
  referenceNumber: z.string().min(1).max(100),
  issueDate: z.string().min(1).max(50),
  issuingParty: z.string().min(1).max(150),
  description: z.string().min(1).max(1000),
});

export const SubmitAssetResponseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  docHash: z.string(),
  assetType: z.number(),
  declaredValue: z.string(),
  referenceNumber: z.string(),
  issueDate: z.string(),
  issuingParty: z.string(),
  description: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

export const PrepareRegisterAssetResponseSchema = z.object({
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
  assetId: z.string(),
  docHash: z.string(),
  assetType: z.number(),
  declaredValueUnits: z.string(),
});

export const AssetDetailSchema = z.object({
  id: z.string(),
  userId: z.string(),
  docHash: z.string(),
  assetType: z.number(),
  declaredValue: z.string(),
  referenceNumber: z.string(),
  issueDate: z.string(),
  issuingParty: z.string(),
  description: z.string(),
  status: z.string(),
  txHash: z.string().nullable(),
  createdAt: z.string(),
  explorerUrl: z.string().nullable(),
});

export const AssetListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const AssetListResponseSchema = z.object({
  items: z.array(AssetDetailSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
  totalPages: z.number(),
});

export type PresignedUploadInput = z.infer<typeof PresignedUploadInputSchema>;
export type PresignedUploadResponse = z.infer<typeof PresignedUploadResponseSchema>;
export type SubmitAssetInput = z.infer<typeof SubmitAssetInputSchema>;
export type SubmitAssetResponse = z.infer<typeof SubmitAssetResponseSchema>;
export type PrepareRegisterAssetResponse = z.infer<typeof PrepareRegisterAssetResponseSchema>;
export type AssetDetail = z.infer<typeof AssetDetailSchema>;
export type AssetListQuery = z.infer<typeof AssetListQuerySchema>;
export type AssetListResponse = z.infer<typeof AssetListResponseSchema>;
