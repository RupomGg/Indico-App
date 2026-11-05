import { encodeFunctionData, isAddress, Address, stringToHex, pad } from "viem";
import { prisma } from "../../lib/prisma.js";
import { INDICO_LEDGER_ABI } from "../../lib/viem.js";
import { parseAmount, formatAmount } from "../../lib/amount.js";
import { env } from "../../config/env.js";
import { LoansService } from "../loans/loans.service.js";
import { CreditService } from "../credit/credit.service.js";
import { AdminOperationsService } from "../admin/admin.operations.service.js";
import { AiResponse } from "./ai.schemas.js";

export class AiService {
  /**
   * Dispatches user prompt to local deterministic intent parser and prepares response
   * (PRD §4.6 AI-01 to AI-07; Rule D-11: Intents, never direct actions)
   */
  static async handleUserPrompt(userId: string, rawPrompt: string): Promise<AiResponse> {
    const prompt = rawPrompt.trim();
    const intent = this.parseUserIntent(prompt);

    switch (intent.type) {
      case "READ_STATUS": {
        return this.handleUserReadStatus(userId, intent.target);
      }

      case "REQUEST_LOAN": {
        if (!intent.amount || Number(intent.amount) <= 0) {
          return {
            success: true,
            type: "UNKNOWN",
            intent: "REQUEST_LOAN",
            requiresWalletSignature: false,
            text: "Please specify a positive USDC amount to borrow (for example: \"Borrow 5,000 USDC\"). Or visit the Loans screen directly.",
          };
        }

        try {
          const prepared = await LoansService.prepareBorrowCalldata(userId, {
            amount: intent.amount,
          });

          return {
            success: true,
            type: "TRANSACTION_PREVIEW",
            intent: "REQUEST_LOAN",
            requiresWalletSignature: true,
            text: `Prepared borrow preview for ${prepared.principal} USDC against ${prepared.requiredCollateral} Credit collateral. Please confirm and sign with your wallet.`,
            preview: {
              action: "Request Loan",
              principal: `${prepared.principal} USDC`,
              collateralLocked: `${prepared.requiredCollateral} Credit`,
              loanToValue: "80% (125% collateral)",
              duration: "90 Days (0% Interest, $0 Fees)",
            },
            preparedTx: {
              to: prepared.to,
              data: prepared.data,
              value: prepared.value,
              estimatedGasEth: prepared.gasCostEth,
            },
          };
        } catch (err: any) {
          return {
            success: false,
            type: "ERROR",
            intent: "REQUEST_LOAN",
            requiresWalletSignature: false,
            text: err?.message || "Failed to prepare loan request. Please check your available credit.",
          };
        }
      }

      case "REPAY_LOAN": {
        if (!intent.loanId) {
          return {
            success: true,
            type: "UNKNOWN",
            intent: "REPAY_LOAN",
            requiresWalletSignature: false,
            text: "Please specify which loan ID to repay (for example: \"Repay loan #1\"). You can view your loans by asking \"Show my active loans\".",
          };
        }

        try {
          const prepared = await LoansService.prepareRepayCalldata(userId, {
            loanId: intent.loanId,
          });

          return {
            success: true,
            type: "TRANSACTION_PREVIEW",
            intent: "REPAY_LOAN",
            requiresWalletSignature: true,
            text: `Prepared repayment preview for Loan #${prepared.loanId}. Principal of ${prepared.principal} USDC will be repaid and ${prepared.collateral} Credit collateral unlocked.`,
            preview: {
              action: "Repay Loan",
              loanId: prepared.loanId,
              principalToRepay: `${prepared.principal} USDC`,
              collateralToRelease: `${prepared.collateral} Credit`,
            },
            preparedTx: {
              to: prepared.repayTx.to,
              data: prepared.repayTx.data,
              value: prepared.repayTx.value,
              estimatedGasEth: prepared.repayTx.gasCostEth,
            },
          };
        } catch (err: any) {
          return {
            success: false,
            type: "ERROR",
            intent: "REPAY_LOAN",
            requiresWalletSignature: false,
            text: err?.message || `Failed to prepare repayment for loan #${intent.loanId}.`,
          };
        }
      }

      case "EXTEND_LOAN": {
        if (!intent.loanId) {
          return {
            success: true,
            type: "UNKNOWN",
            intent: "EXTEND_LOAN",
            requiresWalletSignature: false,
            text: "Please specify which loan ID to extend (for example: \"Extend loan #1\"). Extensions must be within 30 days of the due date.",
          };
        }

        try {
          const prepared = await LoansService.prepareExtendCalldata(userId, {
            loanId: intent.loanId,
          });

          return {
            success: true,
            type: "TRANSACTION_PREVIEW",
            intent: "EXTEND_LOAN",
            requiresWalletSignature: true,
            text: `Prepared 90-day extension preview for Loan #${prepared.loanId}. Due date will be pushed to ${new Date(Number(prepared.newDueDate) * 1000).toLocaleDateString()}.`,
            preview: {
              action: "Extend Loan",
              loanId: prepared.loanId,
              extensionCount: prepared.extensionCount,
              newDueDate: new Date(Number(prepared.newDueDate) * 1000).toLocaleDateString(),
              additionalDays: "+90 Days",
            },
            preparedTx: {
              to: prepared.to,
              data: prepared.data,
              value: prepared.value,
              estimatedGasEth: prepared.gasCostEth,
            },
          };
        } catch (err: any) {
          return {
            success: false,
            type: "ERROR",
            intent: "EXTEND_LOAN",
            requiresWalletSignature: false,
            text: err?.message || `Failed to prepare extension for loan #${intent.loanId}. Note: loans can only be extended within 30 days before their due date.`,
          };
        }
      }

      case "SPEND_CREDIT": {
        return this.handleUserSpendCredit(userId, intent.merchantQuery, intent.amount);
      }

      case "UNKNOWN":
      default: {
        return {
          success: true,
          type: "UNKNOWN",
          intent: "UNKNOWN",
          requiresWalletSignature: false,
          text: "I couldn't map that request with certainty. Supported commands:\n• \"What is my available credit and loan status?\"\n• \"Borrow 5,000 USDC\"\n• \"Pay 250 credit to [Merchant Name]\"\n• \"Repay loan #1\"\n• \"Extend loan #1\"\nOr navigate to the dedicated screen in the navigation menu.",
        };
      }
    }
  }

  /**
   * Handles user read-only status lookups (PRD §4.6 AI-02: Zero wallet signature)
   */
  private static async handleUserReadStatus(
    userId: string,
    target: "BALANCE" | "LOANS" | "TRANSACTIONS" | "ALL"
  ): Promise<AiResponse> {
    const binding = await prisma.walletBinding.findUnique({ where: { userId } });
    if (!binding) {
      return {
        success: true,
        type: "MESSAGE",
        intent: "READ_STATUS",
        requiresWalletSignature: false,
        text: "You haven't bound a wallet yet. Please connect and bind your wallet (MetaMask or Tangem) first.",
      };
    }

    const walletAddress = binding.walletAddress;

    if (target === "LOANS") {
      const loans = await prisma.loan.findMany({
        where: { borrower: walletAddress, status: "ACTIVE" },
        orderBy: { openedAtBlock: "desc" },
      });

      if (loans.length === 0) {
        return {
          success: true,
          type: "MESSAGE",
          intent: "READ_STATUS",
          requiresWalletSignature: false,
          text: "You have no active loans. You can borrow up to 80% of your available credit anytime by asking: \"Borrow [amount] USDC\".",
        };
      }

      const loanSummaries = loans.map((l) => {
        const principal = formatAmount(BigInt(l.principalUnits));
        const collateral = formatAmount(BigInt(l.collateralUnits));
        const due = new Date(Number(l.dueDate) * 1000).toLocaleDateString();
        return `• Loan #${l.loanId.toString()}: ${principal} USDC (Collateral: ${collateral} Credit, Due: ${due})`;
      });

      return {
        success: true,
        type: "MESSAGE",
        intent: "READ_STATUS",
        requiresWalletSignature: false,
        text: `You have ${loans.length} active loan(s):\n${loanSummaries.join("\n")}`,
      };
    }

    // Default: Balance & Overall Status
    const balanceRecord = await prisma.creditBalance.findUnique({
      where: { walletAddress },
    });

    const creditUnits = balanceRecord ? BigInt(balanceRecord.creditUnits) : 0n;
    const lockedUnits = balanceRecord ? BigInt(balanceRecord.lockedCreditUnits) : 0n;
    const availableUnits = creditUnits > lockedUnits ? creditUnits - lockedUnits : 0n;

    const availableCredit = formatAmount(availableUnits);
    const lockedCredit = formatAmount(lockedUnits);
    const maxBorrowUnits = (availableUnits * 8000n) / 10000n;
    const maxBorrow = formatAmount(maxBorrowUnits);

    const activeLoansCount = await prisma.loan.count({
      where: { borrower: walletAddress, status: "ACTIVE" },
    });

    return {
      success: true,
      type: "MESSAGE",
      intent: "READ_STATUS",
      requiresWalletSignature: false,
      text: `📊 Financial Summary:\n• Available Credit: ${availableCredit} USDC\n• Locked Collateral: ${lockedCredit} Credit\n• Max Borrowable Now (80% LTV): ${maxBorrow} USDC\n• Active Loans: ${activeLoansCount}`,
      preview: {
        availableCredit: `${availableCredit} USDC`,
        lockedCredit: `${lockedCredit} Credit`,
        maxBorrowable: `${maxBorrow} USDC`,
        activeLoans: activeLoansCount,
      },
    };
  }

  /**
   * Resolves merchant and prepares spend transaction (PRD §4.3, §4.6)
   */
  private static async handleUserSpendCredit(
    userId: string,
    merchantQuery: string,
    amountStr: string | null
  ): Promise<AiResponse> {
    if (!amountStr || Number(amountStr) <= 0) {
      return {
        success: true,
        type: "UNKNOWN",
        intent: "SPEND_CREDIT",
        requiresWalletSignature: false,
        text: "Please specify the amount of credit to spend (for example: \"Pay 250 credit to Sparktech\").",
      };
    }

    if (!merchantQuery) {
      const merchants = await prisma.merchant.findMany({
        where: { isApproved: true },
        select: { name: true, walletAddress: true },
        take: 5,
      });

      const list = merchants.map((m) => `• ${m.name}`).join("\n");
      return {
        success: true,
        type: "UNKNOWN",
        intent: "SPEND_CREDIT",
        requiresWalletSignature: false,
        text: `Please specify which merchant to pay. Approved merchants:\n${list}`,
      };
    }

    // Lookup merchant by name (case-insensitive) or wallet address
    const merchant = await prisma.merchant.findFirst({
      where: {
        isApproved: true,
        OR: [
          { name: { contains: merchantQuery, mode: "insensitive" } },
          ...(isAddress(merchantQuery) ? [{ walletAddress: merchantQuery.toLowerCase() }] : []),
        ],
      },
    });

    if (!merchant) {
      const allApproved = await prisma.merchant.findMany({
        where: { isApproved: true },
        select: { name: true },
        take: 5,
      });
      const names = allApproved.map((m) => `• ${m.name}`).join("\n");
      return {
        success: false,
        type: "ERROR",
        intent: "SPEND_CREDIT",
        requiresWalletSignature: false,
        text: `Merchant "${merchantQuery}" was not found among approved merchants. Approved merchants:\n${names}`,
      };
    }

    try {
      const prepared = await CreditService.prepareSpendCalldata(userId, {
        merchantAddress: merchant.walletAddress,
        amount: amountStr,
      });

      return {
        success: true,
        type: "TRANSACTION_PREVIEW",
        intent: "SPEND_CREDIT",
        requiresWalletSignature: true,
        text: `Prepared payment of ${prepared.amount} Credit to merchant "${merchant.name}". Merchant will receive an on-chain receipt upon confirmation.`,
        preview: {
          action: "Spend Credit",
          merchant: merchant.name,
          merchantWallet: merchant.walletAddress,
          amountToSpend: `${prepared.amount} Credit`,
          fee: "$0 (No fee)",
        },
        preparedTx: {
          to: prepared.to,
          data: prepared.data,
          value: prepared.value,
          estimatedGasEth: prepared.gasCostEth,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        type: "ERROR",
        intent: "SPEND_CREDIT",
        requiresWalletSignature: false,
        text: err?.message || "Failed to prepare spend transaction.",
      };
    }
  }

  /**
   * Deterministic local intent parser for User Assistant (Option A - Zero API Keys)
   * Adheres strictly to PRD §4.6 AI-01 and AI-05 (never guesses, refuses ambiguous intents)
   */
  static parseUserIntent(prompt: string): {
    type: "READ_STATUS" | "REQUEST_LOAN" | "REPAY_LOAN" | "EXTEND_LOAN" | "SPEND_CREDIT" | "UNKNOWN";
    target: "BALANCE" | "LOANS" | "TRANSACTIONS" | "ALL";
    amount: string | null;
    loanId: string | null;
    merchantQuery: string;
  } {
    const lower = prompt.toLowerCase();

    // 1. Check for prompt injection or adversarial overrides
    if (
      lower.includes("ignore all instructions") ||
      lower.includes("system prompt") ||
      lower.includes("give me admin") ||
      lower.includes("bypass")
    ) {
      return {
        type: "UNKNOWN",
        target: "ALL",
        amount: null,
        loanId: null,
        merchantQuery: "",
      };
    }

    // 2. Read Status / Balance / Borrowing Limit inquiries (Check before action intents)
    if (
      lower.includes("how much can i borrow") ||
      lower.includes("what can i borrow") ||
      lower.includes("how much can i take") ||
      lower.includes("can i borrow") ||
      lower.includes("borrow limit") ||
      lower.includes("borrowing limit") ||
      lower.includes("credit limit") ||
      lower.includes("balance") ||
      (lower.includes("credit") && !lower.includes("pay") && !lower.includes("spend") && !lower.includes("issue") && !lower.includes("debit")) ||
      lower.includes("status") ||
      (lower.includes("how much") && !lower.includes("pay") && !lower.includes("spend")) ||
      lower.includes("limit")
    ) {
      return {
        type: "READ_STATUS",
        target: "BALANCE",
        amount: null,
        loanId: null,
        merchantQuery: "",
      };
    }

    if (lower.includes("my loans") || lower.includes("active loans") || lower.includes("list loans")) {
      return {
        type: "READ_STATUS",
        target: "LOANS",
        amount: null,
        loanId: null,
        merchantQuery: "",
      };
    }

    // 3. Loan Repayment
    if (lower.includes("repay") || lower.includes("pay back") || lower.includes("settle loan") || lower.includes("clear loan")) {
      const loanMatch = lower.match(/(?:loan|#|id)\s*#?\s*(\d+)/i) || lower.match(/\b(\d+)\b/);
      const loanId = loanMatch && loanMatch[1] ? loanMatch[1] : null;
      return {
        type: "REPAY_LOAN",
        target: "LOANS",
        amount: null,
        loanId,
        merchantQuery: "",
      };
    }

    // 4. Loan Extension
    if (lower.includes("extend") || lower.includes("rollover") || lower.includes("roll over") || lower.includes("renew")) {
      const loanMatch = lower.match(/(?:loan|#|id)\s*#?\s*(\d+)/i) || lower.match(/\b(\d+)\b/);
      const loanId = loanMatch && loanMatch[1] ? loanMatch[1] : null;
      return {
        type: "EXTEND_LOAN",
        target: "LOANS",
        amount: null,
        loanId,
        merchantQuery: "",
      };
    }

    // 5. Loan Request / Borrow
    if (lower.includes("borrow") || lower.includes("request loan") || lower.includes("take loan") || lower.includes("take out a loan")) {
      const amountMatch = lower.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/);
      const amount = amountMatch && amountMatch[1] ? amountMatch[1].replace(/,/g, "") : null;
      return {
        type: "REQUEST_LOAN",
        target: "LOANS",
        amount,
        loanId: null,
        merchantQuery: "",
      };
    }

    // 6. Spend Credit
    if (
      lower.includes("spend") ||
      lower.includes("send credit") ||
      (lower.includes("pay") && !lower.includes("repay") && !lower.includes("pay back") && !lower.includes("pay loan"))
    ) {
      const amountMatch = lower.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/);
      const amount = amountMatch && amountMatch[1] ? amountMatch[1].replace(/,/g, "") : null;

      // Extract merchant: text after "to", "at", or "with"
      let merchantQuery = "";
      const toMatch = lower.match(/(?:to|at|with)\s+([a-zA-Z0-9_\- ]+)/i);
      if (toMatch && toMatch[1]) {
        merchantQuery = toMatch[1].replace(/credit|usdc|dollars|\$/gi, "").trim();
      }

      return {
        type: "SPEND_CREDIT",
        target: "ALL",
        amount,
        loanId: null,
        merchantQuery,
      };
    }

    return {
      type: "UNKNOWN",
      target: "ALL",
      amount: null,
      loanId: null,
      merchantQuery: "",
    };
  }

  /**
   * Dispatches admin commands to local deterministic engine (PRD §4.7 AD-19)
   */
  static async handleAdminCommand(_adminId: string, rawPrompt: string): Promise<AiResponse> {
    const prompt = rawPrompt.trim();
    const lower = prompt.toLowerCase();

    // 1. Issue Credit (PRD §4.7 AD-10, AD-11)
    if (lower.includes("issue credit") || lower.includes("mint credit") || lower.includes("grant credit")) {
      const addressMatch = prompt.match(/0x[a-fA-F0-9]{40}/);
      const amountMatch = prompt.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/);

      if (!addressMatch || !amountMatch || !amountMatch[1]) {
        return {
          success: true,
          type: "UNKNOWN",
          intent: "ADMIN_ISSUE_CREDIT",
          requiresWalletSignature: false,
          text: "To issue credit, please provide the recipient's wallet address and amount (for example: \"Issue credit of 1,000 to 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 for manual wire\").",
        };
      }

      const recipient = addressMatch[0] as Address;
      const amountUnits = parseAmount(amountMatch[1].replace(/,/g, ""));
      const memoBytes = pad(stringToHex("ADMIN_MANUAL_ISSUE"), { size: 32 });

      const data = encodeFunctionData({
        abi: INDICO_LEDGER_ABI,
        functionName: "adminIssueCredit",
        args: [recipient, amountUnits, memoBytes],
      });

      return {
        success: true,
        type: "ACTION_PREVIEW",
        intent: "ADMIN_ISSUE_CREDIT",
        requiresWalletSignature: true,
        text: `Prepared administrative issuance of ${formatAmount(amountUnits)} Credit to ${recipient}. Broadcast requires an Admin wallet signature on Base Sepolia.`,
        preview: {
          action: "adminIssueCredit (AD-10)",
          recipient,
          creditToIssue: `${formatAmount(amountUnits)} Credit`,
          reasonMemo: "ADMIN_MANUAL_ISSUE",
        },
        preparedTx: {
          to: env.INDICO_LEDGER_ADDRESS,
          data,
          value: "0",
        },
      };
    }

    // 2. Debit Credit (PRD §4.7 AD-12)
    if (lower.includes("debit credit") || lower.includes("burn credit") || lower.includes("deduct credit")) {
      const addressMatch = prompt.match(/0x[a-fA-F0-9]{40}/);
      const amountMatch = prompt.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/);

      if (!addressMatch || !amountMatch || !amountMatch[1]) {
        return {
          success: true,
          type: "UNKNOWN",
          intent: "ADMIN_DEBIT_CREDIT",
          requiresWalletSignature: false,
          text: "To debit credit for a private cash settlement, please provide the user's wallet address and amount (for example: \"Debit credit of 500 from 0x7099... for settlement\").",
        };
      }

      const userAddress = addressMatch[0] as Address;
      const amountUnits = parseAmount(amountMatch[1].replace(/,/g, ""));
      const memoBytes = pad(stringToHex("CASH_SETTLEMENT"), { size: 32 });

      const data = encodeFunctionData({
        abi: INDICO_LEDGER_ABI,
        functionName: "adminDebitCredit",
        args: [userAddress, amountUnits, memoBytes],
      });

      return {
        success: true,
        type: "ACTION_PREVIEW",
        intent: "ADMIN_DEBIT_CREDIT",
        requiresWalletSignature: true,
        text: `Prepared administrative debit of ${formatAmount(amountUnits)} Credit from ${userAddress} for private settlement. Broadcast requires an Admin wallet signature on Base Sepolia.`,
        preview: {
          action: "adminDebitCredit (AD-12)",
          userAddress,
          creditToDebit: `${formatAmount(amountUnits)} Credit`,
          reasonMemo: "CASH_SETTLEMENT",
        },
        preparedTx: {
          to: env.INDICO_LEDGER_ADDRESS,
          data,
          value: "0",
        },
      };
    }

    // 3. User Lookup
    if (lower.includes("user") || lower.includes("lookup") || lower.includes("find user")) {
      // Find email, 0x address, or UUID
      const emailMatch = prompt.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      const addressMatch = prompt.match(/0x[a-fA-F0-9]{40}/);

      const user = await prisma.user.findFirst({
        where: {
          OR: [
            ...(emailMatch ? [{ email: emailMatch[0].toLowerCase() }] : []),
            ...(addressMatch
              ? [
                  {
                    walletBinding: {
                      walletAddress: addressMatch[0].toLowerCase(),
                    },
                  },
                ]
              : []),
          ],
        },
        include: { walletBinding: true },
      });

      if (!user) {
        return {
          success: true,
          type: "MESSAGE",
          intent: "ADMIN_LOOKUP_USER",
          requiresWalletSignature: false,
          text: "User not found. Please provide a valid email or bound wallet address (e.g. \"Lookup user alice@indico.example\").",
        };
      }

      const detail = await AdminOperationsService.getUserDetail(user.id);
      return {
        success: true,
        type: "MESSAGE",
        intent: "ADMIN_LOOKUP_USER",
        requiresWalletSignature: false,
        text: `👤 User Record (${detail.email}):\n• Status: ${detail.status} (Email Verified: ${detail.isEmailVerified})\n• Bound Wallet: ${detail.walletAddress || "None"}\n• On-Chain Approved: ${detail.isOnChainApproved ? "YES" : "NO"}\n• Credit Balance: ${detail.credit} USDC (Locked: ${detail.lockedCredit})\n• Registered Assets: ${detail.assets.length}`,
        preview: detail,
      };
    }

    // 4. Loans Supervision Query
    if (lower.includes("loan") || lower.includes("overdue") || lower.includes("supervision")) {
      const loansRes = await AdminOperationsService.getLoansDashboard({ page: 1, limit: 100 });
      const overdue = loansRes.items.filter((l) => l.isOverdue).length;
      const active = loansRes.items.filter((l) => l.status === "ACTIVE").length;

      return {
        success: true,
        type: "MESSAGE",
        intent: "ADMIN_READ_LOANS",
        requiresWalletSignature: false,
        text: `📑 Loan Supervision:\n• Total Tracked Loans: ${loansRes.total}\n• Active Loans: ${active}\n• Overdue Loans (Eligible for liquidation): ${overdue}`,
        preview: {
          total: loansRes.total,
          active,
          overdue,
        },
      };
    }

    // 5. Pool Status Query
    if (lower.includes("pool") || lower.includes("liquidity") || lower.includes("available cash")) {
      const pool = await AdminOperationsService.getPoolDashboard();
      return {
        success: true,
        type: "MESSAGE",
        intent: "ADMIN_READ_POOL",
        requiresWalletSignature: false,
        text: `📊 Pool Operations State:\n• Available Liquidity: ${pool.availableUsdc} USDC\n• Total Lent Out: ${pool.totalLent} USDC\n• Total Pool Assets: ${pool.totalAssets} USDC\n• Active Depositors: ${pool.depositorCount}`,
        preview: pool,
      };
    }

    // Default Unknown
    return {
      success: true,
      type: "UNKNOWN",
      intent: "ADMIN_UNKNOWN",
      requiresWalletSignature: false,
      text: "Supported Admin Console Commands:\n• \"Pool liquidity status\"\n• \"Show active and overdue loans\"\n• \"Lookup user [email or wallet]\"\n• \"Issue credit of [amount] to [wallet]\"\n• \"Debit credit of [amount] from [wallet]\"",
    };
  }
}
