import { describe, it, expect, vi, beforeEach } from "vitest";
import { AdminOperationsService } from "../../src/modules/admin/admin.operations.service.js";
import { prisma } from "../../src/lib/prisma.js";
import { NotFoundError, BadRequestError } from "../../src/lib/errors.js";
import { publicClient } from "../../src/lib/viem.js";

/**
 * =======================================================================================
 * INPUT PARTITION TABLE: Admin Operations (PRD §4.7 AD-01 to AD-22; docs/input-testing.md)
 * =======================================================================================
 * 
 * Operation: User Approval & Rejection (AD-02, O-024)
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Non-existent user   | "u-ghost"        | Reject 404 NotFoundError                               |
 * | Pending user        | "u-pending"      | Marks isApproved: true, logs USER_APPROVED              |
 * | Revoke user         | "u-active"       | Marks isApproved: false, logs USER_REJECTED             |
 * 
 * Operation: Merchant & Service Management (AD-04, AD-05)
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Create merchant     | valid name/email | Creates merchant record, logs MERCHANT_CREATED          |
 * | Add service         | 100 USDC service | Creates service, logs SERVICE_ADDED                     |
 * | Update service      | new price        | Updates service, logs SERVICE_UPDATED                   |
 * | Delete service      | existing service | Deletes service, logs SERVICE_DELETED                   |
 * 
 * Operation: Agreement Workflow (AD-06, AD-07, AD-08)
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Send agreement      | merchant ID      | Sets agreementStatus="SENT", logs AGREEMENT_SENT        |
 * | Sign agreement      | signed storageKey| Sets agreementStatus="SIGNED", logs AGREEMENT_SIGNED     |
 * 
 * Operation: Pool & Safe Status (AD-13, AD-22)
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Pool dashboard      | mock pool state  | Returns cash, totalDeposited, totalLent, shares         |
 * | Safe gas status     | 0.05 ETH balance | Returns safe balance, isLow: false                      |
 * | Safe gas status     | 0.001 ETH balance| Returns safe balance, isLow: true (warning triggered)   |
 * =======================================================================================
 */

describe("Admin Operations (PRD §4.7 AD-02 to AD-22)", () => {
  const mockAdminId = "admin-1";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("User Management (AD-02, AD-03)", () => {
    it("throws NotFoundError when approving non-existent user", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null);

      await expect(
        AdminOperationsService.approveUser(mockAdminId, "user-ghost")
      ).rejects.toThrow(NotFoundError);
    });

    it("approves user and creates audit log", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "u-1",
        email: "user@test.com",
        isApproved: false,
      } as any);

      vi.spyOn(prisma.user, "update").mockResolvedValue({
        id: "u-1",
        email: "user@test.com",
        isApproved: true,
      } as any);

      vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const res = await AdminOperationsService.approveUser(mockAdminId, "u-1");
      expect(res.isApproved).toBe(true);
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorType: "ADMIN",
            actorId: mockAdminId,
            action: "USER_APPROVED",
            resource: "User",
            resourceId: "u-1",
          }),
        })
      );
    });

    it("rejects / revokes user and creates audit log", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "u-1",
        email: "user@test.com",
        isApproved: true,
      } as any);

      vi.spyOn(prisma.user, "update").mockResolvedValue({
        id: "u-1",
        email: "user@test.com",
        isApproved: false,
      } as any);

      vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const res = await AdminOperationsService.rejectUser(mockAdminId, "u-1");
      expect(res.isApproved).toBe(false);
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorType: "ADMIN",
            actorId: mockAdminId,
            action: "USER_REJECTED",
            resource: "User",
            resourceId: "u-1",
          }),
        })
      );
    });

    it("retrieves full user detail including wallet, assets, and balance (AD-03)", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "u-1",
        email: "user@test.com",
        isApproved: true,
        walletBinding: {
          walletAddress: "0x1111111111111111111111111111111111111111",
          boundAt: new Date(),
        },
        assets: [
          {
            id: "a-1",
            docHash: "0xhash",
            assetType: 1,
            declaredValue: "500.000000",
            status: "REGISTERED",
          },
        ],
      } as any);

      vi.spyOn(prisma.creditBalance, "findUnique").mockResolvedValue({
        creditUnits: "500000000",
        lockedCreditUnits: "0",
      } as any);

      const userDetail = await AdminOperationsService.getUserDetail("u-1");
      expect(userDetail.id).toBe("u-1");
      expect(userDetail.walletAddress).toBe("0x1111111111111111111111111111111111111111");
      expect(userDetail.credit).toBe("500.000000");
      expect(userDetail.assets.length).toBe(1);
    });
  });

  describe("Merchant & Services Management (AD-04, AD-05)", () => {
    it("creates merchant and logs audit event", async () => {
      vi.spyOn(prisma.merchant, "create").mockResolvedValue({
        id: "m-new",
        name: "New Merchant",
        contactEmail: "new@merchant.com",
        walletAddress: "0x3333333333333333333333333333333333333333",
        isApproved: true,
        agreementStatus: "NOT_SENT",
      } as any);

      vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const res = await AdminOperationsService.createMerchant(mockAdminId, {
        name: "New Merchant",
        contactEmail: "new@merchant.com",
        walletAddress: "0x3333333333333333333333333333333333333333",
        isApproved: true,
      });

      expect(res.id).toBe("m-new");
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorType: "ADMIN",
            action: "MERCHANT_CREATED",
          }),
        })
      );
    });

    it("adds a service to merchant (AD-05)", async () => {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue({ id: "m-1" } as any);
      vi.spyOn(prisma.merchantService, "create").mockResolvedValue({
        id: "s-1",
        merchantId: "m-1",
        name: "Legal Retainer",
        priceUnits: "250000000",
        description: "Monthly retainer",
      } as any);

      vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const res = await AdminOperationsService.addMerchantService(mockAdminId, "m-1", {
        name: "Legal Retainer",
        price: "250.000000",
        description: "Monthly retainer",
      });

      expect(res.id).toBe("s-1");
      expect(res.price).toBe("250.000000");
    });
  });

  describe("Merchant Agreement Workflow (AD-06, AD-07, AD-08)", () => {
    it("marks agreement sent and updates timestamp", async () => {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue({ id: "m-1" } as any);
      vi.spyOn(prisma.merchant, "update").mockResolvedValue({
        id: "m-1",
        agreementStatus: "SENT",
        agreementSentAt: new Date(),
      } as any);
      vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const res = await AdminOperationsService.sendMerchantAgreement(mockAdminId, "m-1");
      expect(res.agreementStatus).toBe("SENT");
    });

    it("marks agreement signed and records agreement document", async () => {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue({ id: "m-1" } as any);
      vi.spyOn(prisma.merchant, "update").mockResolvedValue({
        id: "m-1",
        agreementStatus: "SIGNED",
        agreementSignedAt: new Date(),
      } as any);
      vi.spyOn(prisma.merchantAgreement, "create").mockResolvedValue({} as any);
      vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const res = await AdminOperationsService.signMerchantAgreement(
        mockAdminId,
        "m-1",
        "agreements/m-1-signed.pdf"
      );
      expect(res.agreementStatus).toBe("SIGNED");
    });
  });

  describe("Pool, Loans & Safe Dashboard (AD-13, AD-15, AD-22)", () => {
    it("retrieves pool metrics (AD-13)", async () => {
      vi.spyOn(prisma.poolDeposit, "findMany").mockResolvedValue([
        { merchant: "0x1", shares: "1000000" },
        { merchant: "0x2", shares: "2000000" },
      ] as any);
      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "poolAvailable") return 50_000_000_000n; // 50,000 USDC
        if (functionName === "totalLent") return 10_000_000_000n; // 10,000 USDC
        return 0n;
      });

      const pool = await AdminOperationsService.getPoolDashboard();
      expect(pool.poolCash).toBe("50000.000000");
      expect(pool.totalLent).toBe("10000.000000");
      expect(pool.depositorCount).toBe(2);
    });

    it("retrieves platform loan list with overdue liquidation status (AD-15, AD-21)", async () => {
      const pastDueDate = BigInt(Math.floor(Date.now() / 1000) - 3600); // 1 hour overdue
      vi.spyOn(prisma.loan, "findMany").mockResolvedValue([
        {
          loanId: 101n,
          borrower: "0xborrower",
          principalUnits: "1000000000",
          collateralUnits: "1250000000",
          dueDate: pastDueDate,
          extensionCount: 0,
          status: "ACTIVE",
          openedAtBlock: 1000n,
        },
      ] as any);
      vi.spyOn(prisma.loan, "count").mockResolvedValue(1);

      const loansRes = await AdminOperationsService.getLoansDashboard({ page: 1, limit: 10 });
      expect(loansRes.items.length).toBe(1);
      const loan = loansRes.items[0]!;
      expect(loan.isOverdue).toBe(true);
      expect(loan.canLiquidate).toBe(true);
    });

    it("checks Safe Base ETH balance and triggers low-balance alert if balance < 0.01 ETH (AD-22)", async () => {
      // 0.005 ETH (low)
      vi.spyOn(publicClient, "getBalance").mockResolvedValue(5_000_000_000_000_000n);

      const status = await AdminOperationsService.getSafeStatus();
      expect(status.balanceEth).toBe("0.005");
      expect(status.isLow).toBe(true);
      expect(status.warning).toBeDefined();
    });
  });
});
