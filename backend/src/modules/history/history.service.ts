import { prisma } from "../../lib/prisma.js";
import { formatAmount } from "../../lib/amount.js";
import { NotFoundError, BadRequestError } from "../../lib/errors.js";
import type {
  UserBalanceResponse,
  LoanListQuery,
  LoanListResponse,
  LoanItem,
  UserTransactionsResponse,
} from "./history.schemas.js";

export class HistoryService {
  /**
   * Reads available, locked, and total credit from the read_credit_balances read-model (PRD §4.3 C-01).
   * Strictly read-only query (Rule 9).
   */
  static async getUserBalance(userId: string): Promise<UserBalanceResponse> {
    const binding = await prisma.walletBinding.findUnique({
      where: { userId },
    });

    if (!binding) {
      throw new BadRequestError("User has not bound a wallet yet. Please bind a wallet first.");
    }

    const walletAddress = binding.walletAddress;

    const record = await prisma.creditBalance.findUnique({
      where: { walletAddress },
    });

    if (!record) {
      return {
        walletAddress,
        credit: "0.000000",
        creditUnits: "0",
        lockedCredit: "0.000000",
        lockedCreditUnits: "0",
        availableCredit: "0.000000",
        availableCreditUnits: "0",
      };
    }

    const creditUnits = BigInt(record.creditUnits);
    const lockedCreditUnits = BigInt(record.lockedCreditUnits);
    const availableCreditUnits =
      creditUnits > lockedCreditUnits ? creditUnits - lockedCreditUnits : 0n;

    return {
      walletAddress,
      credit: formatAmount(creditUnits),
      creditUnits: creditUnits.toString(),
      lockedCredit: formatAmount(lockedCreditUnits),
      lockedCreditUnits: lockedCreditUnits.toString(),
      availableCredit: formatAmount(availableCreditUnits),
      availableCreditUnits: availableCreditUnits.toString(),
    };
  }

  /**
   * Reads paginated loans from read_loans for the authenticated user (PRD §4.4 L-09).
   * Supports filtering by loan status (ACTIVE, REPAID, DEFAULTED, ALL).
   * Strictly read-only query (Rule 9).
   */
  static async getUserLoans(
    userId: string,
    query: LoanListQuery
  ): Promise<LoanListResponse> {
    const binding = await prisma.walletBinding.findUnique({
      where: { userId },
    });

    if (!binding) {
      throw new BadRequestError("User has not bound a wallet yet. Please bind a wallet first.");
    }

    const walletAddress = binding.walletAddress;
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: any = { borrower: walletAddress };

    if (query.status && query.status !== "ALL") {
      where.status = query.status;
    }

    const [loans, total] = await Promise.all([
      prisma.loan.findMany({
        where,
        orderBy: { openedAtBlock: "desc" },
        skip,
        take: limit,
      }),
      prisma.loan.count({ where }),
    ]);

    const items: LoanItem[] = loans.map((l) => ({
      loanId: l.loanId.toString(),
      borrower: l.borrower,
      principal: formatAmount(BigInt(l.principalUnits)),
      principalUnits: l.principalUnits,
      collateral: formatAmount(BigInt(l.collateralUnits)),
      collateralUnits: l.collateralUnits,
      dueDate: Number(l.dueDate),
      extensionCount: l.extensionCount,
      status: l.status,
      openedAtBlock: l.openedAtBlock.toString(),
      repaidAtBlock: l.repaidAtBlock ? l.repaidAtBlock.toString() : null,
      defaultedAtBlock: l.defaultedAtBlock ? l.defaultedAtBlock.toString() : null,
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
   * Retrieves single loan record from read_loans, isolating access to the loan borrower.
   */
  static async getLoanById(userId: string, loanIdStr: string): Promise<LoanItem> {
    const binding = await prisma.walletBinding.findUnique({
      where: { userId },
    });

    if (!binding) {
      throw new BadRequestError("User has not bound a wallet yet. Please bind a wallet first.");
    }

    const walletAddress = binding.walletAddress;

    let loanId: bigint;
    try {
      loanId = BigInt(loanIdStr);
    } catch {
      throw new NotFoundError(`Invalid loan ID: "${loanIdStr}"`);
    }

    const loan = await prisma.loan.findUnique({
      where: { loanId },
    });

    if (!loan || loan.borrower.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new NotFoundError(`Loan #${loanIdStr} not found`);
    }

    return {
      loanId: loan.loanId.toString(),
      borrower: loan.borrower,
      principal: formatAmount(BigInt(loan.principalUnits)),
      principalUnits: loan.principalUnits,
      collateral: formatAmount(BigInt(loan.collateralUnits)),
      collateralUnits: loan.collateralUnits,
      dueDate: Number(loan.dueDate),
      extensionCount: loan.extensionCount,
      status: loan.status,
      openedAtBlock: loan.openedAtBlock.toString(),
      repaidAtBlock: loan.repaidAtBlock ? loan.repaidAtBlock.toString() : null,
      defaultedAtBlock: loan.defaultedAtBlock ? loan.defaultedAtBlock.toString() : null,
    };
  }

  /**
   * Retrieves chronological on-chain transaction history for the authenticated user.
   */
  static async getUserTransactions(userId: string): Promise<UserTransactionsResponse> {
    const binding = await prisma.walletBinding.findUnique({
      where: { userId },
    });

    if (!binding) {
      return { items: [], total: 0 };
    }

    const walletAddress = binding.walletAddress.toLowerCase();

    const allEvents = await prisma.chainEvent.findMany({
      orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }],
    });

    const userEvents = allEvents.filter((e) => {
      const data = (e.data || {}) as Record<string, any>;
      const user = (data["user"] || "").toString().toLowerCase();
      const borrower = (data["borrower"] || "").toString().toLowerCase();
      const signer = (data["signer"] || "").toString().toLowerCase();
      const merchant = (data["merchant"] || "").toString().toLowerCase();
      return (
        user === walletAddress ||
        borrower === walletAddress ||
        signer === walletAddress ||
        merchant === walletAddress
      );
    });

    return {
      items: userEvents.map((e) => ({
        id: e.id,
        txHash: e.txHash,
        logIndex: e.logIndex,
        eventName: e.eventName,
        blockNumber: e.blockNumber.toString(),
        blockTimestamp: Number(e.blockTimestamp),
        data: (e.data || {}) as Record<string, any>,
        explorerUrl: `https://sepolia.basescan.org/tx/${e.txHash}`,
      })),
      total: userEvents.length,
    };
  }
}

