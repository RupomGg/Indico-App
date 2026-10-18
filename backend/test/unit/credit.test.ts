import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreditService } from "../../src/modules/credit/credit.service.js";
import { prisma } from "../../src/lib/prisma.js";
import { publicClient, INDICO_LEDGER_ABI } from "../../src/lib/viem.js";
import {
  BadRequestError,
  ForbiddenError,
} from "../../src/lib/errors.js";
import { decodeFunctionData, type Address, type Hex } from "viem";

/**
 * =======================================================================================
 * INPUT PARTITION TABLE: Credit Spending (docs/input-testing.md §1 & PRD §4.3 C-01 to C-08)
 * =======================================================================================
 * 
 * Parameter: amount (uint256 / string, 6-decimal credit)
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Zero                | "0.000000"       | Reject 400 Bad Request (ZeroAmount)                    |
 * | One unit (1 wei)    | "0.000001"       | Success (1 wei spend)                                  |
 * | Typical             | "50.000000"      | Success (50 credit spend)                               |
 * | Exact Available     | "100.000000"     | Success (spends all available credit)                   |
 * | Available + 1 wei   | "100.000001"     | Reject 400 InsufficientAvailableCredit                 |
 * | Exceeds Available   | "500.000000"     | Reject 400 InsufficientAvailableCredit                 |
 * | Invalid Decimals    | "50.1234567"     | Reject 400 Bad Request (>6 decimals)                   |
 * | Negative Amount     | "-10.000000"     | Reject 400 Bad Request (must be positive)              |
 * | Malformed String    | "not-a-number"   | Reject 400 Bad Request (invalid format)                |
 * 
 * Parameter: merchantAddress (address)
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Zero Address        | 0x000...000      | Reject 400 Bad Request (ZeroAddress)                    |
 * | Caller (Self-spend) | userWallet       | Reject 400 Bad Request (Cannot spend to self)          |
 * | Invalid Format      | "0x123"          | Reject 400 Bad Request (Invalid Ethereum address)      |
 * | Not Approved        | unapprovedWallet | Reject 400 Bad Request (NotApprovedMerchant)           |
 * | Terms Not Signed    | unsignedMerchant | Reject 400 Bad Request (MerchantTermsNotSigned)        |
 * | Approved & Signed   | validMerchant    | Success (Happy path)                                   |
 * =======================================================================================
 */

describe("Credit Module (PRD §4.3 C-01 to C-08; PRD §4.1 U-11; contract-spec §6.4)", () => {
  const mockUserId = "user-abc";
  const userWallet = "0x1111111111111111111111111111111111111111" as Address;
  const merchantWallet = "0x3333333333333333333333333333333333333333" as Address;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST /credit/prepare-spend", () => {
    it("throws BadRequestError if user has no bound wallet", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue(null);

      await expect(
        CreditService.prepareSpendCalldata(mockUserId, {
          merchantAddress: merchantWallet,
          amount: "50.000000",
        })
      ).rejects.toThrow(BadRequestError);
    });

    it("throws BadRequestError if merchant address is self (user's own wallet)", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: userWallet,
      } as any);

      await expect(
        CreditService.prepareSpendCalldata(mockUserId, {
          merchantAddress: userWallet,
          amount: "50.000000",
        })
      ).rejects.toThrow(/cannot spend credit to your own wallet/i);
    });

    it("throws BadRequestError if merchant address is zero address", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: userWallet,
      } as any);

      await expect(
        CreditService.prepareSpendCalldata(mockUserId, {
          merchantAddress: "0x0000000000000000000000000000000000000000",
          amount: "50.000000",
        })
      ).rejects.toThrow(/zero address/i);
    });

    it("throws ForbiddenError if user is not approved on-chain", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: userWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "approvedUser") return false;
        if (functionName === "termsSigned") return true;
        return 0n;
      });

      await expect(
        CreditService.prepareSpendCalldata(mockUserId, {
          merchantAddress: merchantWallet,
          amount: "50.000000",
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it("throws BadRequestError if user has not signed platform terms", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: userWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "approvedUser") return true;
        if (functionName === "termsSigned") return false;
        return 0n;
      });

      await expect(
        CreditService.prepareSpendCalldata(mockUserId, {
          merchantAddress: merchantWallet,
          amount: "50.000000",
        })
      ).rejects.toThrow(/terms/i);
    });

    it("throws BadRequestError if recipient is not an approved merchant (NotApprovedMerchant)", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: userWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "approvedUser") return true;
        if (functionName === "termsSigned") return true;
        if (functionName === "approvedMerchant") return false; // Not approved merchant
        return 0n;
      });

      await expect(
        CreditService.prepareSpendCalldata(mockUserId, {
          merchantAddress: merchantWallet,
          amount: "50.000000",
        })
      ).rejects.toThrow(/not an approved merchant/i);
    });

    it("throws BadRequestError if merchant has not signed platform terms (MerchantTermsNotSigned / O-031)", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: userWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName, args }: any) => {
        if (functionName === "approvedUser") return true;
        if (functionName === "termsSigned") {
          // User has signed, but merchant has not
          if (args?.[0]?.toLowerCase() === merchantWallet.toLowerCase()) return false;
          return true;
        }
        if (functionName === "approvedMerchant") return true;
        return 0n;
      });

      await expect(
        CreditService.prepareSpendCalldata(mockUserId, {
          merchantAddress: merchantWallet,
          amount: "50.000000",
        })
      ).rejects.toThrow(/merchant has not signed/i);
    });

    it("throws BadRequestError (InsufficientAvailableCredit) if spend exceeds user available credit", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: userWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "approvedUser") return true;
        if (functionName === "termsSigned") return true;
        if (functionName === "approvedMerchant") return true;
        if (functionName === "available") return 30_000_000n; // 30 credit available
        return 0n;
      });

      await expect(
        CreditService.prepareSpendCalldata(mockUserId, {
          merchantAddress: merchantWallet,
          amount: "50.000000",
        })
      ).rejects.toThrow(/exceeds available credit/i);
    });

    it("prepares valid spend calldata decoding back to exact ABI parameters", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "b-1",
        userId: mockUserId,
        walletAddress: userWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "approvedUser") return true;
        if (functionName === "termsSigned") return true;
        if (functionName === "approvedMerchant") return true;
        if (functionName === "available") return 100_000_000n; // 100 credit
        return 0n;
      });

      vi.spyOn(publicClient, "call").mockResolvedValue({ data: "0x" } as any);
      vi.spyOn(publicClient, "estimateGas").mockResolvedValue(75_000n);
      vi.spyOn(publicClient, "getGasPrice").mockResolvedValue(1_000_000_000n);
      vi.spyOn(publicClient, "getBalance").mockResolvedValue(100_000_000_000_000_000n);

      const res = await CreditService.prepareSpendCalldata(mockUserId, {
        merchantAddress: merchantWallet,
        amount: "50.000000",
      });

      expect(res.merchantAddress).toBe(merchantWallet);
      expect(res.amount).toBe("50.000000");
      expect(res.amountUnits).toBe("50000000");

      const decoded = decodeFunctionData({
        abi: INDICO_LEDGER_ABI,
        data: res.data as Hex,
      });
      expect(decoded.functionName).toBe("spend");
      expect(decoded.args?.[0]?.toLowerCase()).toBe(merchantWallet.toLowerCase());
      expect(decoded.args?.[1]).toBe(50_000_000n);
    });
  });
});
