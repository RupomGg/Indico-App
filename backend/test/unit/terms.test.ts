import { describe, it, expect, vi, beforeEach } from "vitest";
import { TermsService } from "../../src/modules/terms/terms.service.js";
import { prisma } from "../../src/lib/prisma.js";
import { publicClient } from "../../src/lib/viem.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../src/lib/errors.js";
import { decodeFunctionData } from "viem";
import { INDICO_LEDGER_ABI } from "../../src/lib/viem.js";

describe("Terms Module (PRD §4.1 U-06 to U-08, U-12)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("getCurrentTerms", () => {
    it("returns active terms text, version, and on-chain termsHash", async () => {
      vi.spyOn(publicClient, "readContract").mockResolvedValue(
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
      );

      const terms = await TermsService.getCurrentTerms();
      expect(terms.version).toBe("1.0.0");
      expect(terms.termsHash).toBe(
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
      );
      expect(terms.title).toBeDefined();
      expect(terms.content).toContain("Indico");
      expect(terms.effectiveDate).toBeDefined();
    });

    it("falls back to configured hash if RPC returns zero bytes", async () => {
      vi.spyOn(publicClient, "readContract").mockResolvedValue(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      );

      const terms = await TermsService.getCurrentTerms();
      expect(terms.termsHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    });
  });

  describe("getTermsStatus", () => {
    it("throws BadRequestError if user has no bound wallet", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue(null);

      await expect(TermsService.getTermsStatus("user-no-wallet")).rejects.toThrow(
        BadRequestError
      );
    });

    it("returns signed: true when wallet has signed current terms hash on-chain", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "binding-1",
        userId: "user-1",
        walletAddress: "0x1111111111111111111111111111111111111111",
      } as any);

      const termsHash = "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "termsHash") return termsHash;
        if (functionName === "termsSigned") return true;
        return null;
      });

      const status = await TermsService.getTermsStatus("user-1");
      expect(status.hasBoundWallet).toBe(true);
      expect(status.termsSigned).toBe(true);
      expect(status.walletAddress).toBe("0x1111111111111111111111111111111111111111");
      expect(status.termsHash).toBe(termsHash);
    });

    it("returns signed: false when wallet has not signed terms on-chain", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        id: "binding-1",
        userId: "user-1",
        walletAddress: "0x1111111111111111111111111111111111111111",
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "termsHash") return "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
        if (functionName === "termsSigned") return false;
        return null;
      });

      const status = await TermsService.getTermsStatus("user-1");
      expect(status.termsSigned).toBe(false);
    });
  });

  describe("prepareSignTermsCalldata", () => {
    const mockWallet = "0x2222222222222222222222222222222222222222" as `0x${string}`;
    const mockTermsHash = "0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222" as `0x${string}`;

    it("throws BadRequestError if user has no bound wallet", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue(null);

      await expect(TermsService.prepareSignTermsCalldata("user-no-wallet")).rejects.toThrow(
        BadRequestError
      );
    });

    it("throws ConflictError if user has already signed current terms on chain", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        userId: "user-signed",
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "termsHash") return mockTermsHash;
        if (functionName === "termsSigned") return true;
        return null;
      });

      await expect(TermsService.prepareSignTermsCalldata("user-signed")).rejects.toThrow(
        ConflictError
      );
    });

    it("prepares valid transaction calldata decoding exactly to signTerms(acceptedHash)", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        userId: "user-ready",
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "termsHash") return mockTermsHash;
        if (functionName === "termsSigned") return false;
        return null;
      });

      vi.spyOn(publicClient, "call").mockResolvedValue({
        data: "0x",
      } as any);

      vi.spyOn(publicClient, "estimateGas").mockResolvedValue(55000n);
      vi.spyOn(publicClient, "getGasPrice").mockResolvedValue(1000000000n); // 1 gwei
      vi.spyOn(publicClient, "getBalance").mockResolvedValue(10000000000000000n); // 0.01 ETH

      const result = await TermsService.prepareSignTermsCalldata("user-ready");

      expect(result.to).toBeDefined();
      expect(result.value).toBe("0");
      expect(result.data).toMatch(/^0x/);

      // Verify exact ABI calldata decoding
      const decoded = decodeFunctionData({
        abi: INDICO_LEDGER_ABI,
        data: result.data,
      });

      expect(decoded.functionName).toBe("signTerms");
      expect(decoded.args?.[0]).toBe(mockTermsHash);

      // Verify gas and shortfall calculation
      expect(result.canAfford).toBe(true);
      expect(result.estimatedGasUnits).toBe("66000"); // 55000 * 1.2 buffer
      expect(result.ethShortfall).toBe("0");
    });

    it("calculates positive ethShortfall when wallet balance is lower than gas cost", async () => {
      vi.spyOn(prisma.walletBinding, "findUnique").mockResolvedValue({
        userId: "user-low-balance",
        walletAddress: mockWallet,
      } as any);

      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "termsHash") return mockTermsHash;
        if (functionName === "termsSigned") return false;
        return null;
      });

      vi.spyOn(publicClient, "call").mockResolvedValue({} as any);
      vi.spyOn(publicClient, "estimateGas").mockResolvedValue(50000n);
      vi.spyOn(publicClient, "getGasPrice").mockResolvedValue(20000000000n); // 20 gwei -> cost = 1,000,000 gwei = 0.001 ETH
      vi.spyOn(publicClient, "getBalance").mockResolvedValue(100000000000000n); // 0.0001 ETH

      const result = await TermsService.prepareSignTermsCalldata("user-low-balance");

      expect(result.canAfford).toBe(false);
      expect(BigInt(result.ethShortfallUnits)).toBeGreaterThan(0n);
    });
  });
});
