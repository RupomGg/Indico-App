import { prisma } from "../../lib/prisma.js";
import { formatAmount } from "../../lib/amount.js";
import { NotFoundError } from "../../lib/errors.js";
import type {
  MerchantListQuery,
  MerchantListResponse,
  MerchantItem,
} from "./merchants.schemas.js";

export class MerchantsService {
  /**
   * Lists approved merchants and their services for user browsing (PRD §4.3 C-03).
   * Unapproved merchants are strictly hidden.
   */
  static async listMerchants(query: MerchantListQuery): Promise<MerchantListResponse> {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: any = { isApproved: true };

    if (query.query && query.query.trim().length > 0) {
      where.name = { contains: query.query.trim(), mode: "insensitive" };
    }

    const [merchants, total] = await Promise.all([
      prisma.merchant.findMany({
        where,
        include: {
          services: {
            orderBy: { name: "asc" },
          },
        },
        orderBy: { name: "asc" },
        skip,
        take: limit,
      }),
      prisma.merchant.count({ where }),
    ]);

    const items: MerchantItem[] = merchants.map((m) => ({
      id: m.id,
      name: m.name,
      walletAddress: m.walletAddress,
      contactEmail: m.contactEmail,
      agreementStatus: m.agreementStatus,
      services: m.services.map((s) => ({
        id: s.id,
        name: s.name,
        priceUnits: s.priceUnits,
        price: formatAmount(BigInt(s.priceUnits)),
        description: s.description,
      })),
    }));

    return {
      items,
      total,
      page,
      limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /**
   * Gets details and service offerings for a single approved merchant (PRD §4.3 C-04).
   */
  static async getMerchantById(id: string): Promise<MerchantItem> {
    const merchant = await prisma.merchant.findUnique({
      where: { id },
      include: {
        services: {
          orderBy: { name: "asc" },
        },
      },
    });

    if (!merchant || !merchant.isApproved) {
      throw new NotFoundError(`Merchant with ID "${id}" not found`);
    }

    return {
      id: merchant.id,
      name: merchant.name,
      walletAddress: merchant.walletAddress,
      contactEmail: merchant.contactEmail,
      agreementStatus: merchant.agreementStatus,
      services: merchant.services.map((s) => ({
        id: s.id,
        name: s.name,
        priceUnits: s.priceUnits,
        price: formatAmount(BigInt(s.priceUnits)),
        description: s.description,
      })),
    };
  }
}
