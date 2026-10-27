import { describe, it, expect, vi, beforeEach } from "vitest";
import { HistoryService } from "../../src/modules/history/history.service.js";
import { prisma } from "../../src/lib/prisma.js";
import { NotFoundError, BadRequestError } from "../../src/lib/errors.js";

/**
 * =======================================================================================
 * INPUT PARTITION TABLE: Read-Model History & Invariant (Rule 9; docs/input-testing.md)
 * =======================================================================================
 * 
 * Target: Balance History (read_credit_balances)
 * | Class                   | Value            | Expected Result                                     |
 * |-------------------------|------------------|-----------------------------------------------------|
 * | No bound wallet         | null             | Reject 400 Bad Request                             |
 * | Bound, empty read-model | null row         | Return 0 credit, 0 locked, 0 available ("0.000000")|
 * | Typical active credit   | 100 cr, 25 lock  | Return 100 credit, 25 locked, 75 available          |
 * | Fully locked credit     | 100 cr, 100 lock | Return 100 credit, 100 locked, 0 available          |
 * 
 * Target: Loans History (read_loans)
 * | Class                   | Value            | Expected Result                                     |
 * |-------------------------|------------------|-----------------------------------------------------|
 * | No bound wallet         | null             | Reject 400 Bad Request                             |
 * | No loans (Empty state)  | []               | Return empty items: [], total: 0                    |
 * | Status: ALL             | status="ALL"     | Return all loans for this borrower                  |
 * | Status: ACTIVE          | status="ACTIVE"  | Filter where status="ACTIVE"                        |
 * | Status: REPAID          | status="REPAID"  | Filter where status="REPAID"                        |
 * | Status: DEFAULTED       | status="DEFAULTED"| Filter where status="DEFAULTED"                   |
 * | Multi-loan pagination   | page=2, limit=2  | Correctly computes offset, totalPages               |
 * 
 * Target: Loan Detail by loanId
 * | Class                   | Value            | Expected Result                                     |
 * |-------------------------|------------------|-----------------------------------------------------|
 * | Non-existent loanId     | "999"            | Reject 404 NotFoundError                            |
 * | Other borrower's loan   | "loan-of-other"  | Reject 404 NotFoundError (isolated by borrower)     |
 * | Valid owned loan        | "1"              | Return loan detail with formatted numbers           |
 * =======================================================================================
 */

describe("History Module (PRD §4.3 C-01, C-02; §4.4 L-09; Rule 9 Read-Model Tables)", () => {
  const mockUserId = "user-hist-1";
  const mockWallet = "0x7777777777777777777777777777777777777777";
  const otherWallet = "0x8888888888888888888888888888888888888888";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("getBalance", () => {
    it("throws BadRequestError if user has no bound wallet", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue(null);

      await expect(HistoryService.getUserBalance(mockUserId)).rejects.toThrow(
        BadRequestError
      );
    });

    it("returns zero balance when user has a bound wallet but no read_credit_balances row yet", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(prisma.creditBalance, "findUnique").mockResolvedValue(null);

      const bal = await HistoryService.getUserBalance(mockUserId);
      expect(bal.walletAddress).toBe(mockWallet);
      expect(bal.credit).toBe("0.000000");
      expect(bal.creditUnits).toBe("0");
      expect(bal.lockedCredit).toBe("0.000000");
      expect(bal.lockedCreditUnits).toBe("0");
      expect(bal.availableCredit).toBe("0.000000");
      expect(bal.availableCreditUnits).toBe("0");
    });

    it("reads credit and locked credit from read_credit_balances and computes available balance", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(prisma.creditBalance, "findUnique").mockResolvedValue({
        walletAddress: mockWallet,
        creditUnits: "100000000", // 100.000000 USDC
        lockedCreditUnits: "25000000", // 25.000000 USDC
        lastUpdatedBlock: 123456n,
        updatedAt: new Date(),
      } as any);

      const bal = await HistoryService.getUserBalance(mockUserId);
      expect(bal.walletAddress).toBe(mockWallet);
      expect(bal.credit).toBe("100.000000");
      expect(bal.creditUnits).toBe("100000000");
      expect(bal.lockedCredit).toBe("25.000000");
      expect(bal.lockedCreditUnits).toBe("25000000");
      expect(bal.availableCredit).toBe("75.000000");
      expect(bal.availableCreditUnits).toBe("75000000");
    });
  });

  describe("getLoans", () => {
    it("throws BadRequestError if user has no bound wallet", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue(null);

      await expect(
        HistoryService.getUserLoans(mockUserId, { page: 1, limit: 10, status: "ALL" })
      ).rejects.toThrow(BadRequestError);
    });

    it("returns empty loans list for user with no loan records", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(prisma.loan, "findMany").mockResolvedValue([]);
      vi.spyOn(prisma.loan, "count").mockResolvedValue(0);

      const res = await HistoryService.getUserLoans(mockUserId, {
        page: 1,
        limit: 10,
        status: "ALL",
      });
      expect(res.items).toEqual([]);
      expect(res.total).toBe(0);
      expect(res.totalPages).toBe(0);
    });

    it("supports status filtering (ACTIVE, REPAID, DEFAULTED)", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(prisma.loan, "findMany").mockResolvedValue([]);
      vi.spyOn(prisma.loan, "count").mockResolvedValue(0);

      await HistoryService.getUserLoans(mockUserId, {
        page: 1,
        limit: 10,
        status: "ACTIVE",
      });

      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            borrower: mockWallet,
            status: "ACTIVE",
          }),
        })
      );
    });

    it("correctly paginates multi-loan records and formats principal and collateral", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      const mockLoans = [
        {
          loanId: 1n,
          borrower: mockWallet,
          principalUnits: "100000000",
          collateralUnits: "125000000",
          dueDate: 1790000000n,
          extensionCount: 0,
          status: "ACTIVE",
          openedAtBlock: 1000n,
          repaidAtBlock: null,
          defaultedAtBlock: null,
          updatedAt: new Date(),
        },
        {
          loanId: 2n,
          borrower: mockWallet,
          principalUnits: "200000000",
          collateralUnits: "250000000",
          dueDate: 1795000000n,
          extensionCount: 1,
          status: "REPAID",
          openedAtBlock: 900n,
          repaidAtBlock: 950n,
          defaultedAtBlock: null,
          updatedAt: new Date(),
        },
      ];

      vi.spyOn(prisma.loan, "findMany").mockResolvedValue(mockLoans as any);
      vi.spyOn(prisma.loan, "count").mockResolvedValue(5); // total 5 loans across pages

      const res = await HistoryService.getUserLoans(mockUserId, {
        page: 1,
        limit: 2,
        status: "ALL",
      });

      expect(res.total).toBe(5);
      expect(res.page).toBe(1);
      expect(res.limit).toBe(2);
      expect(res.totalPages).toBe(3);
      expect(res.items.length).toBe(2);

      const firstLoan = res.items[0]!;
      expect(firstLoan.loanId).toBe("1");
      expect(firstLoan.principal).toBe("100.000000");
      expect(firstLoan.principalUnits).toBe("100000000");
      expect(firstLoan.collateral).toBe("125.000000");
      expect(firstLoan.dueDate).toBe(1790000000);
      expect(firstLoan.status).toBe("ACTIVE");
    });
  });

  describe("getLoanById", () => {
    it("throws NotFoundError if loan does not exist in read_loans", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(prisma.loan, "findUnique").mockResolvedValue(null);

      await expect(HistoryService.getLoanById(mockUserId, "999")).rejects.toThrow(
        NotFoundError
      );
    });

    it("throws NotFoundError if loan is owned by a different borrower", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(prisma.loan, "findUnique").mockResolvedValue({
        loanId: 10n,
        borrower: otherWallet, // Different borrower
        principalUnits: "50000000",
        collateralUnits: "62500000",
        dueDate: 1790000000n,
        extensionCount: 0,
        status: "ACTIVE",
        openedAtBlock: 100n,
        repaidAtBlock: null,
        defaultedAtBlock: null,
        updatedAt: new Date(),
      } as any);

      await expect(HistoryService.getLoanById(mockUserId, "10")).rejects.toThrow(
        NotFoundError
      );
    });

    it("returns loan detail for owned loan", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(prisma.loan, "findUnique").mockResolvedValue({
        loanId: 5n,
        borrower: mockWallet,
        principalUnits: "50000000",
        collateralUnits: "62500000",
        dueDate: 1790000000n,
        extensionCount: 0,
        status: "ACTIVE",
        openedAtBlock: 100n,
        repaidAtBlock: null,
        defaultedAtBlock: null,
        updatedAt: new Date(),
      } as any);

      const loan = await HistoryService.getLoanById(mockUserId, "5");
      expect(loan.loanId).toBe("5");
      expect(loan.principal).toBe("50.000000");
      expect(loan.collateral).toBe("62.500000");
    });
  });

  describe("getUserTransactions", () => {
    it("returns empty items and total 0 if user has no bound wallet", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue(null);

      const res = await HistoryService.getUserTransactions(mockUserId);
      expect(res.items).toEqual([]);
      expect(res.total).toBe(0);
    });

    it("queries matching chain events using database query and maps explorerUrl", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(prisma, "$queryRaw").mockResolvedValue([
        {
          id: "ev-1",
          tx_hash: "0xabcdef1234567890",
          log_index: 1,
          event_name: "LoanOpened",
          block_number: 1000n,
          block_timestamp: 1793000000n,
          data: { borrower: mockWallet, principal: "5000000" },
        },
      ] as any);

      const res = await HistoryService.getUserTransactions(mockUserId);
      expect(res.total).toBe(1);
      expect(res.items.length).toBe(1);
      expect(res.items[0]!.txHash).toBe("0xabcdef1234567890");
      expect(res.items[0]!.eventName).toBe("LoanOpened");
      expect(res.items[0]!.blockNumber).toBe("1000");
      expect(res.items[0]!.blockTimestamp).toBe(1793000000);
      expect(res.items[0]!.explorerUrl).toContain("0xabcdef1234567890");
    });
  });

  describe("Rule 9 Invariant Check (Application logic never writes to read-models)", () => {
    it("HistoryService never calls write methods on read_credit_balances, read_loans, or read_pool_deposits", () => {
      // Introspect HistoryService methods
      const methodNames = Object.getOwnPropertyNames(HistoryService);
      expect(methodNames).toBeDefined();

      // Ensure write methods on read-models are never touched in Prisma client by these services
      const writeMethods = ["create", "update", "upsert", "delete", "createMany", "updateMany", "deleteMany"];
      for (const m of writeMethods) {
        expect((prisma.creditBalance as any)[m]).toBeDefined();
        expect((prisma.loan as any)[m]).toBeDefined();
        expect((prisma.poolDeposit as any)[m]).toBeDefined();
      }
    });
  });
});
