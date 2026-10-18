import { encodeFunctionData, type Hex, type Address } from "viem";
import { prisma } from "../../lib/prisma.js";
import {
  publicClient,
  INDICO_LEDGER_ABI,
  simulatePreparedTransaction,
  calculateGasShortfall,
} from "../../lib/viem.js";
import { env } from "../../config/env.js";
import { parseAmount } from "../../lib/amount.js";
import { computeFileSha256 } from "../../lib/crypto.js";
import { StorageService } from "../../lib/storage.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../lib/errors.js";
import type {
  PresignedUploadInput,
  PresignedUploadResponse,
  SubmitAssetInput,
  SubmitAssetResponse,
  PrepareRegisterAssetResponse,
  AssetDetail,
  AssetListQuery,
  AssetListResponse,
} from "./assets.schemas.js";

export class AssetsService {
  /**
   * Allocates a presigned upload session for file upload (PRD §4.2 A-02).
   */
  static async createPresignedUpload(
    userId: string,
    input: PresignedUploadInput
  ): Promise<PresignedUploadResponse> {
    return StorageService.createUploadSession(userId, input);
  }

  /**
   * Stores binary file buffer for an active upload session.
   */
  static async uploadFileChunk(
    userId: string,
    uploadId: string,
    buffer: Buffer,
    fileName: string,
    mimeType: string
  ): Promise<{ uploadId: string; fileSizeBytes: number; docHash: string }> {
    StorageService.storeUploadedBuffer(uploadId, userId, buffer, fileName, mimeType);
    const docHash = computeFileSha256(buffer);
    return {
      uploadId,
      fileSizeBytes: buffer.length,
      docHash,
    };
  }

  /**
   * Submits asset document and metadata with server-side SHA-256 byte recomputation
   * and AES-256-GCM encryption at rest (PRD §4.2 A-04, A-06, A-08).
   */
  static async submitAsset(
    userId: string,
    input: SubmitAssetInput
  ): Promise<SubmitAssetResponse> {
    // 1. Retrieve raw file bytes from upload session
    const file = StorageService.getUploadedFile(input.uploadId);

    // 2. Server-side SHA-256 recomputation and byte verification (PRD §4.2 A-06)
    const serverHash = computeFileSha256(file.buffer);
    if (serverHash.toLowerCase() !== input.docHash.toLowerCase()) {
      throw new BadRequestError(
        `File SHA-256 mismatch. Client claimed ${input.docHash}, but computed hash was ${serverHash}. Upload rejected.`
      );
    }

    // 3. Global uniqueness check across database (PRD §4.2 A-08)
    const existingDbAsset = await prisma.asset.findUnique({
      where: { docHash: input.docHash },
    });
    if (existingDbAsset) {
      throw new ConflictError(
        "An asset with this document hash has already been registered on the platform."
      );
    }

    // 4. Global uniqueness check on-chain (PRD §4.2 A-08)
    try {
      const isRegisteredOnChain = await publicClient.readContract({
        address: env.INDICO_LEDGER_ADDRESS as Address,
        abi: INDICO_LEDGER_ABI,
        functionName: "assetRegistered",
        args: [input.docHash as Hex],
      });
      if (isRegisteredOnChain) {
        throw new ConflictError(
          "This document hash is already registered on the blockchain ledger."
        );
      }
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      // If RPC is unavailable or mock mode, proceed
    }

    // 5. Encrypt file with AES-256-GCM at rest on disk
    const { storageKey } = await StorageService.saveEncryptedFile(
      userId,
      input.docHash,
      file.buffer
    );

    // 6. Record asset in database
    const asset = await prisma.asset.create({
      data: {
        userId,
        docHash: input.docHash,
        assetType: input.assetType,
        declaredValue: input.declaredValueUsdc,
        referenceNumber: input.referenceNumber,
        issueDate: input.issueDate,
        issuingParty: input.issuingParty,
        description: input.description,
        storageKey,
        status: "PENDING",
      },
    });

    return {
      id: asset.id,
      userId: asset.userId,
      docHash: asset.docHash,
      assetType: asset.assetType,
      declaredValue: asset.declaredValue,
      referenceNumber: asset.referenceNumber,
      issueDate: asset.issueDate,
      issuingParty: asset.issuingParty,
      description: asset.description,
      status: asset.status,
      createdAt: asset.createdAt.toISOString(),
    };
  }

  /**
   * Prepares calldata and gas shortfall analysis for on-chain registerAsset (PRD §4.2 A-07).
   */
  static async prepareRegisterCalldata(
    userId: string,
    assetId: string
  ): Promise<PrepareRegisterAssetResponse> {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
    });

    if (!asset) {
      throw new NotFoundError("Asset not found");
    }

    if (asset.userId !== userId) {
      throw new ForbiddenError("You do not have permission to register this asset");
    }

    const binding = await prisma.walletBinding.findUnique({
      where: { userId },
    });

    if (!binding) {
      throw new BadRequestError(
        "User has not bound a wallet yet. Please connect and bind a wallet first."
      );
    }

    const walletAddress = binding.walletAddress as Address;
    const docHash = asset.docHash as Hex;
    const assetType = asset.assetType;
    const valueUnits = parseAmount(asset.declaredValue);

    const data = encodeFunctionData({
      abi: INDICO_LEDGER_ABI,
      functionName: "registerAsset",
      args: [docHash, assetType, valueUnits],
    });

    // Simulate contract execution to detect reverts (NotApprovedUser, TermsNotSigned, CreditCapExceeded)
    await simulatePreparedTransaction({
      to: env.INDICO_LEDGER_ADDRESS as Address,
      data,
      from: walletAddress,
    });

    // Estimate gas and compute shortfall against user's Base ETH balance
    const shortfall = await calculateGasShortfall(walletAddress, {
      to: env.INDICO_LEDGER_ADDRESS as Address,
      data,
    });

    return {
      to: env.INDICO_LEDGER_ADDRESS,
      data,
      value: "0",
      estimatedGasUnits: shortfall.estimatedGasUnits,
      gasCostEth: shortfall.gasCostEth,
      gasCostUsd: shortfall.gasCostUsd,
      userEthBalance: shortfall.userEthBalance,
      ethShortfall: shortfall.ethShortfall,
      ethShortfallUnits: shortfall.ethShortfallUnits,
      canAfford: shortfall.canAfford,
      assetId: asset.id,
      docHash: asset.docHash,
      assetType: asset.assetType,
      declaredValueUnits: valueUnits.toString(),
    };
  }

  /**
   * Lists all assets for authenticated user (PRD §4.2 A-09).
   */
  static async listUserAssets(
    userId: string,
    query: AssetListQuery
  ): Promise<AssetListResponse> {
    const skip = (query.page - 1) * query.limit;

    const [items, total] = await Promise.all([
      prisma.asset.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        skip,
        take: query.limit,
      }),
      prisma.asset.count({
        where: { userId },
      }),
    ]);

    const explorerBase =
      env.CHAIN_ID === 8453
        ? "https://basescan.org/tx/"
        : "https://sepolia.basescan.org/tx/";

    return {
      items: items.map((a) => ({
        id: a.id,
        userId: a.userId,
        docHash: a.docHash,
        assetType: a.assetType,
        declaredValue: a.declaredValue,
        referenceNumber: a.referenceNumber,
        issueDate: a.issueDate,
        issuingParty: a.issuingParty,
        description: a.description,
        status: a.status,
        txHash: a.txHash,
        createdAt: a.createdAt.toISOString(),
        explorerUrl: a.txHash ? `${explorerBase}${a.txHash}` : null,
      })),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 1,
    };
  }

  /**
   * Fetches single asset detail for authenticated owner (PRD §4.2 A-09).
   */
  static async getAssetDetail(userId: string, assetId: string): Promise<AssetDetail> {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
    });

    if (!asset) {
      throw new NotFoundError("Asset not found");
    }

    if (asset.userId !== userId) {
      throw new ForbiddenError("You do not have access to this asset");
    }

    const explorerBase =
      env.CHAIN_ID === 8453
        ? "https://basescan.org/tx/"
        : "https://sepolia.basescan.org/tx/";

    return {
      id: asset.id,
      userId: asset.userId,
      docHash: asset.docHash,
      assetType: asset.assetType,
      declaredValue: asset.declaredValue,
      referenceNumber: asset.referenceNumber,
      issueDate: asset.issueDate,
      issuingParty: asset.issuingParty,
      description: asset.description,
      status: asset.status,
      txHash: asset.txHash,
      createdAt: asset.createdAt.toISOString(),
      explorerUrl: asset.txHash ? `${explorerBase}${asset.txHash}` : null,
    };
  }

  /**
   * Decrypts and retrieves stored document bytes for authorized user.
   */
  static async getDecryptedDocument(
    userId: string,
    assetId: string
  ): Promise<{ buffer: Buffer; docHash: string }> {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
    });

    if (!asset) {
      throw new NotFoundError("Asset not found");
    }

    if (asset.userId !== userId) {
      throw new ForbiddenError("You do not have access to this document");
    }

    const buffer = await StorageService.readDecryptedFile(asset.storageKey);
    return {
      buffer,
      docHash: asset.docHash,
    };
  }
}
