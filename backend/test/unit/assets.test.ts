import { describe, it, expect, vi, beforeEach } from "vitest";
import { AssetsService } from "../../src/modules/assets/assets.service.js";
import { prisma } from "../../src/lib/prisma.js";
import { publicClient } from "../../src/lib/viem.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  ForbiddenError,
} from "../../src/lib/errors.js";
import { computeFileSha256 } from "../../src/lib/crypto.js";
import { StorageService } from "../../src/lib/storage.js";
import {
  SubmitAssetInputSchema,
  PresignedUploadInputSchema,
} from "../../src/modules/assets/assets.schemas.js";
import { decodeFunctionData } from "viem";
import { INDICO_LEDGER_ABI } from "../../src/lib/viem.js";

describe("Assets Module (PRD §4.2 A-01 to A-09)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Schema Boundary & Partition Tests (PRD §4.2 A-01 to A-04)", () => {
    const validPayload = {
      assetType: 1,
      declaredValueUsdc: "1000.000000",
      referenceNumber: "REF-2026-001",
      issueDate: "2026-10-18",
      issuingParty: "Global Trade Logistics LLC",
      description: "Bill of exchange for machinery import",
      docHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      uploadId: "valid-upload-session-id",
    };

    it("accepts valid asset types 0, 1, 2, 3, 4, 5", () => {
      for (let type = 0; type <= 5; type++) {
        const result = SubmitAssetInputSchema.safeParse({
          ...validPayload,
          assetType: type,
        });
        expect(result.success).toBe(true);
      }
    });

    it("rejects asset type < 0 and asset type > 5 (Contract Spec D-29)", () => {
      const result6 = SubmitAssetInputSchema.safeParse({
        ...validPayload,
        assetType: 6,
      });
      expect(result6.success).toBe(false);

      const resultNeg = SubmitAssetInputSchema.safeParse({
        ...validPayload,
        assetType: -1,
      });
      expect(resultNeg.success).toBe(false);
    });

    it("accepts valid 6-decimal USDC string amounts", () => {
      const validAmounts = ["0.000001", "1.000000", "50000.500000", "100000000.000000"];
      for (const amt of validAmounts) {
        const res = SubmitAssetInputSchema.safeParse({
          ...validPayload,
          declaredValueUsdc: amt,
        });
        expect(res.success).toBe(true);
      }
    });

    it("rejects zero, negative, floats with >6 decimals, and scientific notation", () => {
      const invalidAmounts = [
        "0",
        "0.000000",
        "-10.000000",
        "10.1234567",
        "1e6",
        "NaN",
        "Infinity",
        "",
      ];
      for (const amt of invalidAmounts) {
        const res = SubmitAssetInputSchema.safeParse({
          ...validPayload,
          declaredValueUsdc: amt,
        });
        expect(res.success).toBe(false);
      }
    });

    it("validates docHash: 66-character 0x hex string", () => {
      const validHash = "0x" + "a".repeat(64);
      expect(SubmitAssetInputSchema.safeParse({ ...validPayload, docHash: validHash }).success).toBe(true);

      const invalidHashes = [
        "0x" + "a".repeat(63), // too short
        "0x" + "a".repeat(65), // too long
        "a".repeat(64), // missing 0x
        "0x" + "z".repeat(64), // non-hex
        "",
      ];
      for (const h of invalidHashes) {
        expect(SubmitAssetInputSchema.safeParse({ ...validPayload, docHash: h }).success).toBe(false);
      }
    });

    it("validates PresignedUpload input schema", () => {
      expect(
        PresignedUploadInputSchema.safeParse({
          fileName: "document.pdf",
          fileSizeBytes: 1048576,
          mimeType: "application/pdf",
        }).success
      ).toBe(true);

      // File size 0 rejected
      expect(
        PresignedUploadInputSchema.safeParse({
          fileName: "document.pdf",
          fileSizeBytes: 0,
          mimeType: "application/pdf",
        }).success
      ).toBe(false);

      // File size > 20MB rejected (20 * 1024 * 1024 = 20971520)
      expect(
        PresignedUploadInputSchema.safeParse({
          fileName: "document.pdf",
          fileSizeBytes: 20971521,
          mimeType: "application/pdf",
        }).success
      ).toBe(false);

      // Unsupported MIME type rejected
      expect(
        PresignedUploadInputSchema.safeParse({
          fileName: "malware.exe",
          fileSizeBytes: 1000,
          mimeType: "application/x-msdownload",
        }).success
      ).toBe(false);
    });
  });

  describe("Presigned Upload Session (PRD §4.2 A-01, A-02)", () => {
    it("creates an upload session with expiry and returns upload parameters", async () => {
      const result = await AssetsService.createPresignedUpload("user-1", {
        fileName: "equipment-invoice.pdf",
        fileSizeBytes: 204800,
        mimeType: "application/pdf",
      });

      expect(result.uploadId).toBeDefined();
      expect(result.uploadUrl).toBeDefined();
      expect(result.expiresAt).toBeDefined();
      expect(result.maxSizeBytes).toBe(20 * 1024 * 1024);
    });
  });

  describe("Submit Asset & Server-Side Verification (PRD §4.2 A-06, A-08)", () => {
    const rawFileBytes = Buffer.from("PDF-MOCK-SAMPLE-ASSET-CONTENT-2026", "utf-8");
    const exactSha256 = computeFileSha256(rawFileBytes);

    it("rejects submission if file bytes were tampered by 1 byte (A-06 Hash Mismatch)", async () => {
      const tamperedBytes = Buffer.from("PDF-MOCK-SAMPLE-ASSET-CONTENT-2027", "utf-8"); // 1 byte change: '6' -> '7'

      vi.spyOn(StorageService, "getUploadedFile").mockReturnValue({
        buffer: tamperedBytes,
        fileName: "doc.pdf",
        mimeType: "application/pdf",
      });

      await expect(
        AssetsService.submitAsset("user-1", {
          uploadId: "session-tampered",
          docHash: exactSha256, // client declared original hash, but file uploaded was tampered
          assetType: 1,
          declaredValueUsdc: "10000.000000",
          referenceNumber: "REF-001",
          issueDate: "2026-10-18",
          issuingParty: "Supplier A",
          description: "Tampered doc test",
        })
      ).rejects.toThrow(BadRequestError);
    });

    it("rejects duplicate docHash if already submitted by another user (A-08 Global Uniqueness)", async () => {
      vi.spyOn(StorageService, "getUploadedFile").mockReturnValue({
        buffer: rawFileBytes,
        fileName: "doc.pdf",
        mimeType: "application/pdf",
      });

      vi.spyOn(prisma.asset, "findUnique").mockResolvedValue({
        id: "existing-asset-id",
        userId: "other-user",
        docHash: exactSha256,
      } as any);

      await expect(
        AssetsService.submitAsset("user-1", {
          uploadId: "session-dup",
          docHash: exactSha256,
          assetType: 2,
          declaredValueUsdc: "5000.000000",
          referenceNumber: "REF-DUP",
          issueDate: "2026-10-18",
          issuingParty: "Supplier B",
          description: "Duplicate asset test",
        })
      ).rejects.toThrow(ConflictError);
    });

    it("rejects duplicate docHash if already registered on-chain", async () => {
      vi.spyOn(StorageService, "getUploadedFile").mockReturnValue({
        buffer: rawFileBytes,
        fileName: "doc.pdf",
        mimeType: "application/pdf",
      });

      vi.spyOn(prisma.asset, "findUnique").mockResolvedValue(null);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "assetRegistered") return true;
        return false;
      });

      await expect(
        AssetsService.submitAsset("user-1", {
          uploadId: "session-chain-dup",
          docHash: exactSha256,
          assetType: 3,
          declaredValueUsdc: "12000.000000",
          referenceNumber: "REF-CHAIN",
          issueDate: "2026-10-18",
          issuingParty: "Supplier C",
          description: "On-chain duplicate check",
        })
      ).rejects.toThrow(ConflictError);
    });

    it("successfully submits asset, encrypts file at rest, and saves DB record", async () => {
      vi.spyOn(StorageService, "getUploadedFile").mockReturnValue({
        buffer: rawFileBytes,
        fileName: "valid-contract.pdf",
        mimeType: "application/pdf",
      });

      vi.spyOn(prisma.asset, "findUnique").mockResolvedValue(null);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "assetRegistered") return false;
        return false;
      });

      const storeSpy = vi.spyOn(StorageService, "saveEncryptedFile").mockResolvedValue({
        storageKey: "assets/user-1/encrypted-doc.enc",
      });

      vi.spyOn(prisma.asset, "create").mockResolvedValue({
        id: "new-asset-uuid",
        userId: "user-1",
        docHash: exactSha256,
        assetType: 1,
        declaredValue: "10000.000000",
        referenceNumber: "REF-SUCCESS-001",
        issueDate: "2026-10-18",
        issuingParty: "Global Supplier",
        description: "Machinery Invoice",
        storageKey: "assets/user-1/encrypted-doc.enc",
        status: "PENDING",
        createdAt: new Date(),
      } as any);

      const result = await AssetsService.submitAsset("user-1", {
        uploadId: "session-valid",
        docHash: exactSha256,
        assetType: 1,
        declaredValueUsdc: "10000.000000",
        referenceNumber: "REF-SUCCESS-001",
        issueDate: "2026-10-18",
        issuingParty: "Global Supplier",
        description: "Machinery Invoice",
      });

      expect(result.id).toBe("new-asset-uuid");
      expect(result.docHash).toBe(exactSha256);
      expect(result.status).toBe("PENDING");
      expect(storeSpy).toHaveBeenCalledWith("user-1", exactSha256, rawFileBytes);
    });
  });

  describe("Calldata Preparation for Asset Registration (PRD §4.2 A-07)", () => {
    const mockWallet = "0x3333333333333333333333333333333333333333" as `0x${string}`;
    const mockDocHash = "0x4444444444444444444444444444444444444444444444444444444444444444" as `0x${string}`;

    it("throws NotFoundError if asset does not exist or belongs to another user", async () => {
      vi.spyOn(prisma.asset, "findUnique").mockResolvedValue(null);

      await expect(
        AssetsService.prepareRegisterCalldata("user-1", "non-existent-id")
      ).rejects.toThrow(NotFoundError);
    });

    it("throws ForbiddenError if asset belongs to another user", async () => {
      vi.spyOn(prisma.asset, "findUnique").mockResolvedValue({
        id: "asset-other",
        userId: "user-other",
      } as any);

      await expect(
        AssetsService.prepareRegisterCalldata("user-1", "asset-other")
      ).rejects.toThrow(ForbiddenError);
    });

    it("prepares valid calldata decoding exactly to registerAsset(docHash, assetType, value)", async () => {
      vi.spyOn(prisma.asset, "findUnique").mockResolvedValue({
        id: "asset-1",
        userId: "user-1",
        docHash: mockDocHash,
        assetType: 2,
        declaredValue: "2500.000000",
        status: "PENDING",
      } as any);

      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        userId: "user-1",
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "approvedUser") return true;
        if (functionName === "termsSigned") return true;
        if (functionName === "assetRegistered") return false;
        return false;
      });

      vi.spyOn(publicClient, "call").mockResolvedValue({
        data: "0x",
      } as any);

      vi.spyOn(publicClient, "estimateGas").mockResolvedValue(75000n);
      vi.spyOn(publicClient, "getGasPrice").mockResolvedValue(1000000000n);
      vi.spyOn(publicClient, "getBalance").mockResolvedValue(20000000000000000n);

      const result = await AssetsService.prepareRegisterCalldata("user-1", "asset-1");

      expect(result.to).toBeDefined();
      expect(result.data).toMatch(/^0x/);

      // Verify exact ABI calldata decoding
      const decoded = decodeFunctionData({
        abi: INDICO_LEDGER_ABI,
        data: result.data,
      });

      expect(decoded.functionName).toBe("registerAsset");
      expect(decoded.args?.[0]).toBe(mockDocHash);
      expect(decoded.args?.[1]).toBe(2); // assetType
      expect(decoded.args?.[2]).toBe(2500000000n); // 2500.000000 * 10^6
      expect(result.canAfford).toBe(true);
    });
  });

  describe("Asset Listing & Detail (PRD §4.2 A-09)", () => {
    it("lists assets with pagination and maps explorer links", async () => {
      vi.spyOn(prisma.asset, "findMany").mockResolvedValue([
        {
          id: "asset-1",
          userId: "user-1",
          docHash: "0x1111",
          assetType: 1,
          declaredValue: "1000.000000",
          referenceNumber: "REF-1",
          status: "REGISTERED",
          txHash: "0xabcdef1234",
          createdAt: new Date(),
        },
      ] as any);
      vi.spyOn(prisma.asset, "count").mockResolvedValue(1);

      const list = await AssetsService.listUserAssets("user-1", { page: 1, limit: 10 });
      expect(list.items).toHaveLength(1);
      expect(list.total).toBe(1);
      expect(list.items[0].txHash).toBe("0xabcdef1234");
      expect(list.items[0].explorerUrl).toContain("0xabcdef1234");
    });
  });
});
