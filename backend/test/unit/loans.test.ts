import { describe, it, expect, vi, beforeEach } from "vitest";
import { LoansService } from "../../src/modules/loans/loans.service.js";
import { prisma } from "../../src/lib/prisma.js";
import { publicClient, INDICO_LEDGER_ABI, ERC20_ABI } from "../../src/lib/viem.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../src/lib/errors.js";
import { decodeFunctionData, type Address, type Hex } from "viem";

/**
 * =======================================================================================
 * INPUT PARTITION TABLE (docs/input-testing.md §1 & §2.1)
 * =======================================================================================
 * 
 * Parameter: principal (uint256 / string, 6-decimal USDC)
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Zero                | "0.000000"       | Reject 400 Bad Request (ZeroAmount)                    |
 * | One unit (1 wei)    | "0.000001"       | Collateral = ceilDiv(1 * 10000, 8000) = 2 (0.000002)    |
 * | Typical             | "100.000000"     | Collateral = ceilDiv(100 * 10000, 8000) = 125.000000   |
 * | Non-exact multiple  | "0.000004"       | Collateral = ceilDiv(40000, 8000) = 5 (0.000005)        |
 * | Non-exact multiple  | "0.000005"       | Collateral = ceilDiv(50000, 8000) = 7 (0.000007)        |
 * | Exceeds Available   | "1000.000000"    | Reject 400 InsufficientAvailableCredit                 |
 * | Exceeds Pool Cash   | "5000.000000"    | Reject 400 InsufficientLiquidity                        |
 * | Invalid Decimals    | "100.1234567"    | Reject 400 Bad Request (>6 decimals)                   |
 * | Malformed String    | "abc"            | Reject 400 Bad Request (non-numeric)                   |
 * 
 * Parameter: loanId (uint256)
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Zero                | 0                | Reject 404 LoanNotFound                                 |
 * | Valid Active        | 1                | Happy path (repay / extend)                             |
 * | Non-Existent        | 999              | Reject 404 LoanNotFound                                 |
 * | Repaid (status=1)   | 2                | Reject 400 LoanNotActive                                |
 * | Defaulted (status=2)| 3                | Reject 400 LoanNotActive                                |
 * | Other User's Loan   | 4                | Reject 403 NotBorrower                                  |
 * 
 * Parameter: Time Axis for Loan Extension (5 time points, Matrix.sol)
 * | Time                | Offset           | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Before window opens | dueDate - 30d -1 | Reject 400 ExtensionWindowNotOpen                      |
 * | Window opens        | dueDate - 30d    | Success (newDueDate = dueDate + 90d)                    |
 * | Inside window       | dueDate - 15d    | Success (newDueDate = dueDate + 90d)                    |
 * | Exactly due         | dueDate          | Success (newDueDate = dueDate + 90d)                    |
 * | After due date      | dueDate + 1      | Reject 400 ExtensionWindowClosed                       |
 * =======================================================================================
 */

describe("Loans Module (PRD §4.1 U-11; §4.4 L-01 to L-10; §4.5 R-01 to R-06)", () => {
  const mockUserId = "user-123";
  const mockWallet = "0x1111111111111111111111111111111111111111" as Address;
  const otherWallet = "0x2222222222222222222222222222222222222222" as Address;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST /loans/prepare-borrow", () => {
    it("throws BadRequestError if user has no bound wallet", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue(null);

      await expect(
        LoansService.prepareBorrowCalldata(mockUserId, { amount: "100.000000" })
      ).rejects.toThrow(BadRequestError);
    });

    it("throws ForbiddenError if user is not approved on-chain", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "approvedUser") return false;
        if (functionName === "termsSigned") return true;
        return 0n;
      });

      await expect(
        LoansService.prepareBorrowCalldata(mockUserId, { amount: "100.000000" })
      ).rejects.toThrow(ForbiddenError);
    });

    it("throws BadRequestError if user has not signed terms on-chain", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "approvedUser") return true;
        if (functionName === "termsSigned") return false;
        return 0n;
      });

      await expect(
        LoansService.prepareBorrowCalldata(mockUserId, { amount: "100.000000" })
      ).rejects.toThrow(BadRequestError);
    });

    it("throws BadRequestError (ZeroAmount) if amount is zero", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      await expect(
        LoansService.prepareBorrowCalldata(mockUserId, { amount: "0.000000" })
      ).rejects.toThrow(BadRequestError);
    });

    it("throws BadRequestError (InsufficientAvailableCredit) if required collateral exceeds available credit", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      // Principal: 100 USDC -> Collateral needed: 125 USDC (125_000_000 units)
      // Available credit: 100 USDC (100_000_000 units)
      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "approvedUser") return true;
        if (functionName === "termsSigned") return true;
        if (functionName === "available") return 100_000_000n; // 100 credit
        if (functionName === "poolAvailable") return 10_000_000_000n; // 10,000 USDC
        return 0n;
      });

      await expect(
        LoansService.prepareBorrowCalldata(mockUserId, { amount: "100.000000" })
      ).rejects.toThrow(/insufficient available credit/i);
    });

    it("throws BadRequestError (InsufficientLiquidity) if requested principal exceeds pool liquidity", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      // Principal: 500 USDC -> Collateral needed: 625 USDC
      // Available credit: 1000 credit (plenty)
      // Pool available: 200 USDC (short)
      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "approvedUser") return true;
        if (functionName === "termsSigned") return true;
        if (functionName === "available") return 1_000_000_000n;
        if (functionName === "poolAvailable") return 200_000_000n; // only 200 USDC available
        return 0n;
      });

      await expect(
        LoansService.prepareBorrowCalldata(mockUserId, { amount: "500.000000" })
      ).rejects.toThrow(/insufficient.*liquidity/i);
    });

    it("calculates exact 1.25x collateral with rounding up in pool favour", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "approvedUser") return true;
        if (functionName === "termsSigned") return true;
        if (functionName === "available") return 1_000_000_000n;
        if (functionName === "poolAvailable") return 1_000_000_000n;
        return 0n;
      });

      vi.spyOn(publicClient, "call").mockResolvedValue({ data: "0x" } as any);
      vi.spyOn(publicClient, "estimateGas").mockResolvedValue(150_000n);
      vi.spyOn(publicClient, "getGasPrice").mockResolvedValue(1_000_000_000n);
      vi.spyOn(publicClient, "getBalance").mockResolvedValue(100_000_000_000_000_000n); // 0.1 ETH

      // Case 1: 1 unit (0.000001) -> ceilDiv(1 * 10000, 8000) = 2 units
      const res1 = await LoansService.prepareBorrowCalldata(mockUserId, { amount: "0.000001" });
      expect(res1.principalUnits).toBe("1");
      expect(res1.requiredCollateralUnits).toBe("2");
      expect(res1.requiredCollateral).toBe("0.000002");

      // Case 2: 100 USDC -> 125 USDC
      const res2 = await LoansService.prepareBorrowCalldata(mockUserId, { amount: "100.000000" });
      expect(res2.principalUnits).toBe("100000000");
      expect(res2.requiredCollateralUnits).toBe("125000000");
      expect(res2.requiredCollateral).toBe("125.000000");

      // Verify calldata decodes back to requestLoan(100000000)
      const decoded = decodeFunctionData({
        abi: INDICO_LEDGER_ABI,
        data: res2.data as Hex,
      });
      expect(decoded.functionName).toBe("requestLoan");
      expect(decoded.args).toEqual([100_000_000n]);
    });

    it("calculates Base ETH gas shortfall accurately without wallet prompt (PRD §4.1 U-11)", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "approvedUser") return true;
        if (functionName === "termsSigned") return true;
        if (functionName === "available") return 1_000_000_000n;
        if (functionName === "poolAvailable") return 1_000_000_000n;
        return 0n;
      });

      vi.spyOn(publicClient, "call").mockResolvedValue({ data: "0x" } as any);
      vi.spyOn(publicClient, "estimateGas").mockResolvedValue(100_000n);
      vi.spyOn(publicClient, "getGasPrice").mockResolvedValue(2_000_000_000n);
      // User has 0 ETH
      vi.spyOn(publicClient, "getBalance").mockResolvedValue(0n);

      const res = await LoansService.prepareBorrowCalldata(mockUserId, { amount: "50.000000" });
      expect(res.canAfford).toBe(false);
      expect(Number(res.ethShortfall)).toBeGreaterThan(0);
      expect(res.userEthBalance).toBe("0");
    });
  });

  describe("POST /loans/prepare-repay", () => {
    it("throws NotFoundError if loanId does not exist on-chain", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "loans") {
          // Zero address borrower means non-existent loan
          return [
            "0x0000000000000000000000000000000000000000",
            0n,
            0,
            0,
            0n,
            0n,
          ];
        }
        return 0n;
      });

      await expect(
        LoansService.prepareRepayCalldata(mockUserId, { loanId: "999" })
      ).rejects.toThrow(NotFoundError);
    });

    it("throws BadRequestError if loan is already Repaid (status = 1)", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "loans") {
          return [
            mockWallet,
            1790000000n,
            0,
            1, // Repaid
            100_000_000n,
            125_000_000n,
          ];
        }
        return 0n;
      });

      await expect(
        LoansService.prepareRepayCalldata(mockUserId, { loanId: "1" })
      ).rejects.toThrow(/loan.*not active/i);
    });

    it("throws BadRequestError if loan is Defaulted (status = 2)", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "loans") {
          return [
            mockWallet,
            1790000000n,
            0,
            2, // Defaulted
            100_000_000n,
            125_000_000n,
          ];
        }
        return 0n;
      });

      await expect(
        LoansService.prepareRepayCalldata(mockUserId, { loanId: "1" })
      ).rejects.toThrow(/loan.*not active/i);
    });

    it("throws ForbiddenError if caller is not the borrower", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "loans") {
          return [
            otherWallet, // Not mockWallet
            1790000000n,
            0,
            0, // Active
            100_000_000n,
            125_000_000n,
          ];
        }
        return 0n;
      });

      await expect(
        LoansService.prepareRepayCalldata(mockUserId, { loanId: "1" })
      ).rejects.toThrow(ForbiddenError);
    });

    it("throws BadRequestError if user has insufficient USDC balance to repay principal", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "loans") {
          return [
            mockWallet,
            1790000000n,
            0,
            0, // Active
            100_000_000n, // 100 USDC principal
            125_000_000n,
          ];
        }
        if (functionName === "balanceOf") {
          return 50_000_000n; // Only 50 USDC balance
        }
        if (functionName === "allowance") {
          return 100_000_000n;
        }
        return 0n;
      });

      await expect(
        LoansService.prepareRepayCalldata(mockUserId, { loanId: "1" })
      ).rejects.toThrow(/insufficient usdc balance/i);
    });

    it("returns 2-step approval sequence if USDC allowance < principal", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "loans") {
          return [
            mockWallet,
            1790000000n,
            0,
            0, // Active
            100_000_000n, // 100 USDC principal
            125_000_000n,
          ];
        }
        if (functionName === "balanceOf") {
          return 200_000_000n; // 200 USDC
        }
        if (functionName === "allowance") {
          return 0n; // 0 allowance (needs approve)
        }
        return 0n;
      });

      vi.spyOn(publicClient, "call").mockResolvedValue({ data: "0x" } as any);
      vi.spyOn(publicClient, "estimateGas").mockResolvedValue(80_000n);
      vi.spyOn(publicClient, "getGasPrice").mockResolvedValue(1_000_000_000n);
      vi.spyOn(publicClient, "getBalance").mockResolvedValue(100_000_000_000_000_000n);

      const res = await LoansService.prepareRepayCalldata(mockUserId, { loanId: "1" });
      expect(res.requiresApproval).toBe(true);
      expect(res.approvalTx).not.toBeNull();
      expect(res.repayTx).toBeDefined();

      // Verify approval calldata
      const decodedApprove = decodeFunctionData({
        abi: ERC20_ABI,
        data: res.approvalTx!.data as Hex,
      });
      expect(decodedApprove.functionName).toBe("approve");
      expect(decodedApprove.args?.[1]).toBe(100_000_000n);

      // Verify repay calldata
      const decodedRepay = decodeFunctionData({
        abi: INDICO_LEDGER_ABI,
        data: res.repayTx.data as Hex,
      });
      expect(decodedRepay.functionName).toBe("repay");
      expect(decodedRepay.args).toEqual([1n]);
    });

    it("prepares direct repay transaction if USDC allowance >= principal", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "loans") {
          return [
            mockWallet,
            1790000000n,
            0,
            0, // Active
            100_000_000n,
            125_000_000n,
          ];
        }
        if (functionName === "balanceOf") {
          return 200_000_000n;
        }
        if (functionName === "allowance") {
          return 500_000_000n; // Sufficient allowance
        }
        return 0n;
      });

      vi.spyOn(publicClient, "call").mockResolvedValue({ data: "0x" } as any);
      vi.spyOn(publicClient, "estimateGas").mockResolvedValue(80_000n);
      vi.spyOn(publicClient, "getGasPrice").mockResolvedValue(1_000_000_000n);
      vi.spyOn(publicClient, "getBalance").mockResolvedValue(100_000_000_000_000_000n);

      const res = await LoansService.prepareRepayCalldata(mockUserId, { loanId: "1" });
      expect(res.requiresApproval).toBe(false);
      expect(res.approvalTx).toBeNull();
      expect(res.repayTx).toBeDefined();

      const decodedRepay = decodeFunctionData({
        abi: INDICO_LEDGER_ABI,
        data: res.repayTx.data as Hex,
      });
      expect(decodedRepay.functionName).toBe("repay");
      expect(decodedRepay.args).toEqual([1n]);
    });
  });

  describe("POST /loans/prepare-extend", () => {
    const mockDueDate = 1790000000n; // unix timestamp

    it("throws NotFoundError if loan does not exist", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "loans") {
          return ["0x0000000000000000000000000000000000000000", 0n, 0, 0, 0n, 0n];
        }
        return 0n;
      });

      await expect(
        LoansService.prepareExtendCalldata(mockUserId, { loanId: "99" })
      ).rejects.toThrow(NotFoundError);
    });

    it("throws ForbiddenError if caller is not borrower", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "loans") {
          return [otherWallet, mockDueDate, 0, 0, 100_000_000n, 125_000_000n];
        }
        return 0n;
      });

      await expect(
        LoansService.prepareExtendCalldata(mockUserId, { loanId: "1" })
      ).rejects.toThrow(ForbiddenError);
    });

    it("throws ForbiddenError if borrower is revoked on-chain (D-50)", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "loans") {
          return [mockWallet, mockDueDate, 0, 0, 100_000_000n, 125_000_000n];
        }
        if (functionName === "approvedUser") {
          return false; // Revoked
        }
        return 0n;
      });

      await expect(
        LoansService.prepareExtendCalldata(mockUserId, { loanId: "1" })
      ).rejects.toThrow(ForbiddenError);
    });

    it("throws BadRequestError (ExtensionWindowNotOpen) before 30-day window", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "loans") {
          return [mockWallet, mockDueDate, 0, 0, 100_000_000n, 125_000_000n];
        }
        if (functionName === "approvedUser") return true;
        return 0n;
      });

      // Window is mockDueDate - 30 days = mockDueDate - 2592000
      // Current time is mockDueDate - 31 days (before window)
      vi.spyOn(publicClient, "getBlock").mockResolvedValue({
        timestamp: mockDueDate - 2592000n - 100n,
      } as any);

      await expect(
        LoansService.prepareExtendCalldata(mockUserId, { loanId: "1" })
      ).rejects.toThrow(/extension window.*not open/i);
    });

    it("throws BadRequestError (ExtensionWindowClosed) after due date", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "loans") {
          return [mockWallet, mockDueDate, 0, 0, 100_000_000n, 125_000_000n];
        }
        if (functionName === "approvedUser") return true;
        return 0n;
      });

      // Current time is 10 seconds past due date
      vi.spyOn(publicClient, "getBlock").mockResolvedValue({
        timestamp: mockDueDate + 10n,
      } as any);

      await expect(
        LoansService.prepareExtendCalldata(mockUserId, { loanId: "1" })
      ).rejects.toThrow(/extension window.*closed/i);
    });

    it("prepares extend transaction inside 30-day window, adding 90 days to due date", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "loans") {
          return [mockWallet, mockDueDate, 1, 0, 100_000_000n, 125_000_000n];
        }
        if (functionName === "approvedUser") return true;
        return 0n;
      });

      // 10 days before due date (inside window)
      vi.spyOn(publicClient, "getBlock").mockResolvedValue({
        timestamp: mockDueDate - (10n * 86400n),
      } as any);

      vi.spyOn(publicClient, "call").mockResolvedValue({ data: "0x" } as any);
      vi.spyOn(publicClient, "estimateGas").mockResolvedValue(90_000n);
      vi.spyOn(publicClient, "getGasPrice").mockResolvedValue(1_000_000_000n);
      vi.spyOn(publicClient, "getBalance").mockResolvedValue(100_000_000_000_000_000n);

      const res = await LoansService.prepareExtendCalldata(mockUserId, { loanId: "1" });
      expect(res.loanId).toBe("1");
      expect(res.dueDate).toBe(Number(mockDueDate));
      // 90 days = 7,776,000 seconds
      expect(res.newDueDate).toBe(Number(mockDueDate + 7776000n));
      expect(res.extensionCount).toBe(2);

      const decoded = decodeFunctionData({
        abi: INDICO_LEDGER_ABI,
        data: res.data as Hex,
      });
      expect(decoded.functionName).toBe("extend");
      expect(decoded.args).toEqual([1n]);
    });
  });
});
