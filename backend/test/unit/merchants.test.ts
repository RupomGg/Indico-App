import { describe, it, expect, vi, beforeEach } from "vitest";
import { MerchantsService } from "../../src/modules/merchants/merchants.service.js";
import { prisma } from "../../src/lib/prisma.js";
import { NotFoundError } from "../../src/lib/errors.js";

/**
 * =======================================================================================
 * INPUT PARTITION TABLE: Merchants Directory (PRD §4.3 C-03, C-04; docs/input-testing.md)
 * =======================================================================================
 * 
 * Query Parameter: merchantId
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Non-existent ID     | "m-non-existent" | Reject 404 NotFoundError                               |
 * | Unapproved merchant | "m-unapproved"   | Reject 404 NotFoundError (hidden from public directory)|
 * | Approved merchant   | "m-approved"     | Success 200 OK with merchant details & services list    |
 * 
 * Query Parameter: search (query string)
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Empty string        | ""               | Returns all approved merchants                          |
 * | Substring match     | "coffee"         | Returns matching approved merchants                     |
 * | Case-insensitive    | "COFFEE"         | Returns matching approved merchants                     |
 * | No matches          | "xyz123nonexist" | Returns empty items array: []                           |
 * 
 * Query Parameter: page & limit
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Defaults            | undefined        | page = 1, limit = 20                                    |
 * | Custom pagination   | page=2, limit=5  | skip = 5, take = 5                                      |
 * | Max limit capping   | limit=500        | Capped at max allowed limit (100)                       |
 * =======================================================================================
 */

describe("Merchants Module (PRD §4.3 C-03, C-04; §4.7 AD-04)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("listMerchants", () => {
    it("returns empty items array when no approved merchants exist", async () => {
      vi.spyOn(prisma.merchant, "findMany").mockResolvedValue([]);
      vi.spyOn(prisma.merchant, "count").mockResolvedValue(0);

      const res = await MerchantsService.listMerchants({ page: 1, limit: 20 });
      expect(res.items).toEqual([]);
      expect(res.total).toBe(0);
      expect(res.page).toBe(1);
      expect(res.limit).toBe(20);
      expect(res.totalPages).toBe(0);
    });

    it("returns only approved merchants with their service offerings and formatted prices", async () => {
      const mockMerchants = [
        {
          id: "m-1",
          name: "Apex Legal Services",
          contactEmail: "legal@apex.com",
          walletAddress: "0x4444444444444444444444444444444444444444",
          isApproved: true,
          agreementStatus: "SIGNED",
          services: [
            {
              id: "s-1",
              merchantId: "m-1",
              name: "Contract Review",
              priceUnits: "150000000", // 150 USDC
              description: "Full arbitration clause review",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        },
      ];

      vi.spyOn(prisma.merchant, "findMany").mockResolvedValue(mockMerchants as any);
      vi.spyOn(prisma.merchant, "count").mockResolvedValue(1);

      const res = await MerchantsService.listMerchants({ page: 1, limit: 20 });
      expect(res.total).toBe(1);
      expect(res.items.length).toBe(1);
      const merchant = res.items[0]!;
      expect(merchant.id).toBe("m-1");
      expect(merchant.name).toBe("Apex Legal Services");
      expect(merchant.walletAddress).toBe("0x4444444444444444444444444444444444444444");
      expect(merchant.services.length).toBe(1);
      expect(merchant.services[0]!.price).toBe("150.000000");
      expect(merchant.services[0]!.priceUnits).toBe("150000000");
    });

    it("filters merchants by query string", async () => {
      vi.spyOn(prisma.merchant, "findMany").mockResolvedValue([]);
      vi.spyOn(prisma.merchant, "count").mockResolvedValue(0);

      await MerchantsService.listMerchants({ query: "Apex", page: 1, limit: 10 });
      expect(prisma.merchant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isApproved: true,
            name: { contains: "Apex", mode: "insensitive" },
          }),
        })
      );
    });
  });

  describe("getMerchantById", () => {
    it("throws NotFoundError if merchant does not exist", async () => {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue(null);

      await expect(MerchantsService.getMerchantById("non-existent")).rejects.toThrow(
        NotFoundError
      );
    });

    it("throws NotFoundError if merchant exists but is unapproved (isApproved = false)", async () => {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue({
        id: "m-unapproved",
        name: "Pending Merchant",
        walletAddress: "0x5555555555555555555555555555555555555555",
        isApproved: false,
        services: [],
      } as any);

      await expect(MerchantsService.getMerchantById("m-unapproved")).rejects.toThrow(
        NotFoundError
      );
    });

    it("returns approved merchant with full details and services", async () => {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue({
        id: "m-approved",
        name: "Verified Merchant",
        walletAddress: "0x6666666666666666666666666666666666666666",
        contactEmail: "verified@merchant.com",
        isApproved: true,
        agreementStatus: "SIGNED",
        services: [
          {
            id: "s-2",
            merchantId: "m-approved",
            name: "Audit Escrow",
            priceUnits: "500000000",
            description: "Security deposit escrow",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      } as any);

      const merchant = await MerchantsService.getMerchantById("m-approved");
      expect(merchant.id).toBe("m-approved");
      expect(merchant.name).toBe("Verified Merchant");
      expect(merchant.services[0]!.price).toBe("500.000000");
    });
  });
});
