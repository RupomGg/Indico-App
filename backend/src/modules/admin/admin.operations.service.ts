import { prisma } from "../../lib/prisma.js";
import { parseAmount, formatAmount } from "../../lib/amount.js";
import { NotFoundError } from "../../lib/errors.js";
import {
  publicClient,
  INDICO_LEDGER_ABI,
} from "../../lib/viem.js";
import { env } from "../../config/env.js";
import { formatEther, type Address } from "viem";
import type {
  AdminUserListQuery,
  AdminCreateMerchantInput,
  AdminAddServiceInput,
  AdminUpdateServiceInput,
  AdminAuditLogQuery,
} from "./admin.schemas.js";

export class AdminOperationsService {
  /**
   * Approves a registered user account (PRD §4.7 AD-02; O-024).
   * Note: approving a bound wallet makes its on-chain role permanent (D-22).
   */
  static async approveUser(adminId: string, userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { walletBinding: true },
    });

    if (!user) {
      throw new NotFoundError(`User with ID "${userId}" not found`);
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { isApproved: true },
    });

    await prisma.auditLog.create({
      data: {
        actorType: "ADMIN",
        actorId: adminId,
        action: "USER_APPROVED",
        resource: "User",
        resourceId: userId,
        payload: {
          email: user.email,
          walletAddress: user.walletBinding?.walletAddress ?? null,
          rolePermanentWarning:
            "Approved wallet address permanently assumes USER role on-chain (D-22)",
        },
      },
    });

    return updated;
  }

  /**
   * Rejects or revokes an approved user account (PRD §4.7 AD-02).
   */
  static async rejectUser(adminId: string, userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundError(`User with ID "${userId}" not found`);
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { isApproved: false },
    });

    await prisma.auditLog.create({
      data: {
        actorType: "ADMIN",
        actorId: adminId,
        action: "USER_REJECTED",
        resource: "User",
        resourceId: userId,
        payload: { email: user.email },
      },
    });

    return updated;
  }

  /**
   * Retrieves full profile, bound wallet, assets, and credit balance for any user (PRD §4.7 AD-03).
   */
  static async getUserDetail(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        walletBinding: true,
        assets: true,
      },
    });

    if (!user) {
      throw new NotFoundError(`User with ID "${userId}" not found`);
    }

    let credit = "0.000000";
    let lockedCredit = "0.000000";

    if (user.walletBinding) {
      const balanceRecord = await prisma.creditBalance.findUnique({
        where: { walletAddress: user.walletBinding.walletAddress },
      });

      if (balanceRecord) {
        credit = formatAmount(BigInt(balanceRecord.creditUnits));
        lockedCredit = formatAmount(BigInt(balanceRecord.lockedCreditUnits));
      }
    }

    return {
      id: user.id,
      email: user.email,
      isEmailVerified: user.isEmailVerified,
      isApproved: user.isApproved,
      createdAt: user.createdAt,
      walletAddress: user.walletBinding?.walletAddress ?? null,
      boundAt: user.walletBinding?.boundAt ?? null,
      credit,
      lockedCredit,
      assets: user.assets.map((a) => ({
        id: a.id,
        docHash: a.docHash,
        assetType: a.assetType,
        declaredValue: a.declaredValue,
        status: a.status,
      })),
    };
  }

  /**
   * Lists users with status filter and pagination.
   */
  static async listUsers(query: AdminUserListQuery) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status === "APPROVED") where.isApproved = true;
    if (query.status === "PENDING") where.isApproved = false;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: { walletBinding: true },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    return {
      items: users.map((u) => ({
        id: u.id,
        email: u.email,
        isEmailVerified: u.isEmailVerified,
        isApproved: u.isApproved,
        createdAt: u.createdAt,
        walletAddress: u.walletBinding?.walletAddress ?? null,
      })),
      total,
      page,
      limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /**
   * Adds a new merchant with details and wallet address (PRD §4.7 AD-04).
   */
  static async createMerchant(adminId: string, input: AdminCreateMerchantInput) {
    const merchant = await prisma.merchant.create({
      data: {
        name: input.name,
        contactEmail: input.contactEmail,
        walletAddress: input.walletAddress,
        isApproved: input.isApproved,
        agreementStatus: "NOT_SENT",
      },
    });

    await prisma.auditLog.create({
      data: {
        actorType: "ADMIN",
        actorId: adminId,
        action: "MERCHANT_CREATED",
        resource: "Merchant",
        resourceId: merchant.id,
        payload: {
          name: merchant.name,
          walletAddress: merchant.walletAddress,
          isApproved: merchant.isApproved,
        },
      },
    });

    return merchant;
  }

  /**
   * Adds a service and price to a merchant (PRD §4.7 AD-05).
   */
  static async addMerchantService(
    adminId: string,
    merchantId: string,
    input: AdminAddServiceInput
  ) {
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
    });

    if (!merchant) {
      throw new NotFoundError(`Merchant with ID "${merchantId}" not found`);
    }

    const priceUnits = parseAmount(input.price);

    const service = await prisma.merchantService.create({
      data: {
        merchantId,
        name: input.name,
        priceUnits: priceUnits.toString(),
        description: input.description,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorType: "ADMIN",
        actorId: adminId,
        action: "SERVICE_ADDED",
        resource: "MerchantService",
        resourceId: service.id,
        payload: {
          merchantId,
          name: service.name,
          price: input.price,
        },
      },
    });

    return {
      id: service.id,
      merchantId: service.merchantId,
      name: service.name,
      price: formatAmount(priceUnits),
      priceUnits: service.priceUnits,
      description: service.description,
    };
  }

  /**
   * Updates a merchant's service name, price, or description (PRD §4.7 AD-05).
   */
  static async updateMerchantService(
    adminId: string,
    merchantId: string,
    serviceId: string,
    input: AdminUpdateServiceInput
  ) {
    const service = await prisma.merchantService.findFirst({
      where: { id: serviceId, merchantId },
    });

    if (!service) {
      throw new NotFoundError(`Service with ID "${serviceId}" not found for this merchant`);
    }

    const data: any = {};
    if (input.name) data.name = input.name;
    if (input.description) data.description = input.description;
    if (input.price) data.priceUnits = parseAmount(input.price).toString();

    const updated = await prisma.merchantService.update({
      where: { id: serviceId },
      data,
    });

    await prisma.auditLog.create({
      data: {
        actorType: "ADMIN",
        actorId: adminId,
        action: "SERVICE_UPDATED",
        resource: "MerchantService",
        resourceId: serviceId,
        payload: data,
      },
    });

    return {
      id: updated.id,
      merchantId: updated.merchantId,
      name: updated.name,
      price: formatAmount(BigInt(updated.priceUnits)),
      priceUnits: updated.priceUnits,
      description: updated.description,
    };
  }

  /**
   * Deletes a merchant's service (PRD §4.7 AD-05).
   */
  static async deleteMerchantService(
    adminId: string,
    merchantId: string,
    serviceId: string
  ) {
    const service = await prisma.merchantService.findFirst({
      where: { id: serviceId, merchantId },
    });

    if (!service) {
      throw new NotFoundError(`Service with ID "${serviceId}" not found for this merchant`);
    }

    await prisma.merchantService.delete({
      where: { id: serviceId },
    });

    await prisma.auditLog.create({
      data: {
        actorType: "ADMIN",
        actorId: adminId,
        action: "SERVICE_DELETED",
        resource: "MerchantService",
        resourceId: serviceId,
      },
    });

    return { message: "Service successfully deleted" };
  }

  /**
   * Records arbitration agreement sent to merchant by email (PRD §4.7 AD-06, AD-08).
   */
  static async sendMerchantAgreement(adminId: string, merchantId: string) {
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
    });

    if (!merchant) {
      throw new NotFoundError(`Merchant with ID "${merchantId}" not found`);
    }

    const updated = await prisma.merchant.update({
      where: { id: merchantId },
      data: {
        agreementStatus: "SENT",
        agreementSentAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        actorType: "ADMIN",
        actorId: adminId,
        action: "AGREEMENT_SENT",
        resource: "Merchant",
        resourceId: merchantId,
        payload: { sentAt: updated.agreementSentAt },
      },
    });

    return updated;
  }

  /**
   * Records arbitration agreement signed by merchant (PRD §4.7 AD-07, AD-08).
   */
  static async signMerchantAgreement(
    adminId: string,
    merchantId: string,
    storageKey: string
  ) {
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
    });

    if (!merchant) {
      throw new NotFoundError(`Merchant with ID "${merchantId}" not found`);
    }

    const updated = await prisma.merchant.update({
      where: { id: merchantId },
      data: {
        agreementStatus: "SIGNED",
        agreementSignedAt: new Date(),
        agreementStorageKey: storageKey,
      },
    });

    await prisma.merchantAgreement.create({
      data: {
        merchantId,
        documentType: "ARBITRATION_AGREEMENT",
        storageKey,
        status: "SIGNED",
        signedAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        actorType: "ADMIN",
        actorId: adminId,
        action: "AGREEMENT_SIGNED",
        resource: "Merchant",
        resourceId: merchantId,
        payload: { storageKey },
      },
    });

    return updated;
  }

  /**
   * Pool metrics dashboard: total cash, total lent, and depositor count (PRD §4.7 AD-13).
   */
  static async getPoolDashboard() {
    let poolCashUnits = 0n;
    let totalLentUnits = 0n;

    try {
      const [cash, lent] = await Promise.all([
        publicClient.readContract({
          address: env.INDICO_LEDGER_ADDRESS as Address,
          abi: INDICO_LEDGER_ABI,
          functionName: "poolAvailable",
        }),
        publicClient.readContract({
          address: env.INDICO_LEDGER_ADDRESS as Address,
          abi: INDICO_LEDGER_ABI,
          functionName: "totalLent",
        }),
      ]);
      poolCashUnits = cash;
      totalLentUnits = lent;
    } catch {
      // Fallback
    }

    const deposits = await prisma.poolDeposit.findMany();

    const poolCash = formatAmount(poolCashUnits);
    const totalLent = formatAmount(totalLentUnits);
    const totalAssets = formatAmount(poolCashUnits + totalLentUnits);

    return {
      poolCash,
      poolCashUnits: poolCashUnits.toString(),
      totalLent,
      totalLentUnits: totalLentUnits.toString(),
      totalAssets,
      depositorCount: deposits.length,
    };
  }

  /**
   * System-wide loan dashboard showing active, repaid, and defaulted loans with liquidation status (PRD §4.7 AD-15, AD-21).
   */
  static async getLoansDashboard(query: { page?: number; limit?: number }) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const [loans, total] = await Promise.all([
      prisma.loan.findMany({
        orderBy: { dueDate: "asc" },
        skip,
        take: limit,
      }),
      prisma.loan.count(),
    ]);

    const now = BigInt(Math.floor(Date.now() / 1000));

    const items = loans.map((l) => {
      const isOverdue = l.dueDate < now && l.status === "ACTIVE";
      return {
        loanId: l.loanId.toString(),
        borrower: l.borrower,
        principal: formatAmount(BigInt(l.principalUnits)),
        principalUnits: l.principalUnits,
        collateral: formatAmount(BigInt(l.collateralUnits)),
        dueDate: Number(l.dueDate),
        extensionCount: l.extensionCount,
        status: l.status,
        isOverdue,
        canLiquidate: isOverdue, // Permissionless liquidation call by admin keeper (AD-21)
      };
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /**
   * Inspects Safe Base ETH balance and raises a warning if < 0.01 ETH (PRD §4.7 AD-22).
   */
  static async getSafeStatus() {
    let balanceWei = 0n;
    try {
      balanceWei = await publicClient.getBalance({
        address: env.INDICO_LEDGER_ADDRESS as Address,
      });
    } catch {
      balanceWei = 0n;
    }

    const balanceEth = formatEther(balanceWei);
    // Low balance threshold: 0.01 ETH
    const isLow = balanceWei < 10_000_000_000_000_000n;

    return {
      safeAddress: env.INDICO_LEDGER_ADDRESS,
      balanceEth,
      balanceWei: balanceWei.toString(),
      isLow,
      warning: isLow
        ? "Warning: Safe Base ETH balance is low. Fund the Safe to ensure user approvals and transaction execution succeed (AD-22)."
        : null,
    };
  }

  /**
   * Retrieves paginated immutable audit logs (PRD §4.7 AD-16).
   */
  static async listAuditLogs(query: AdminAuditLogQuery) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 100);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.action) where.action = query.action;
    if (query.actorId) where.actorId = query.actorId;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return {
      items: logs,
      total,
      page,
      limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }
}
