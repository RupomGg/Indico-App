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
        return this.handleUserReadStatus(userId, intent.target as "BALANCE" | "LOANS" | "TRANSACTIONS" | "ALL");
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
        return this.handleUserSpendCredit(
          userId,
          intent.merchantQuery,
          intent.serviceQuery,
          intent.amount,
          intent.target
        );
      }

      case "UNKNOWN":
      default: {
        return {
          success: true,
          type: "UNKNOWN",
          intent: "UNKNOWN",
          requiresWalletSignature: false,
          text: "I couldn't map that request with certainty. Supported commands:\n• \"What is my available credit and loan status?\"\n• \"What services can I buy?\"\n• \"Buy Software Dev package 1 from Sparktech\"\n• \"Borrow 5,000 USDC\"\n• \"Repay loan #1\"\n• \"Extend loan #1\"\nOr navigate to the dedicated screen in the navigation menu.",
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
   * Resolves merchant and services, presents service catalog, and prepares service purchase calldata (PRD §4.3, §4.6)
   */
  private static async handleUserSpendCredit(
    userId: string,
    merchantQuery: string,
    serviceQuery: string,
    amountStr: string | null,
    target?: string
  ): Promise<AiResponse> {
    // 1. Fetch approved merchants with their cataloged services
    let merchantsWithServices: Array<any> = [];
    try {
      merchantsWithServices = await prisma.merchant.findMany({
        where: { isApproved: true },
        include: {
          services: true,
        },
      });
    } catch {
      // Fallback if DB is disconnected in unit tests
    }

    // Collect all services flattened with their merchant
    const allServices = merchantsWithServices.flatMap((m) =>
      (m.services || []).map((s: any) => ({
        ...s,
        merchant: m,
      }))
    );

    // 2. Target = SERVICES or General Inquiry: List service catalog
    if (target === "SERVICES" || (!merchantQuery && !serviceQuery && !amountStr)) {
      // If user asked about a specific merchant's offerings (e.g. "what does sparktech offer?")
      if (merchantQuery) {
        const targetMerchant = merchantsWithServices.find(
          (m) =>
            m.name.toLowerCase().includes(merchantQuery.toLowerCase()) ||
            (isAddress(merchantQuery) && m.walletAddress.toLowerCase() === merchantQuery.toLowerCase())
        );

        if (targetMerchant) {
          const servicesList =
            targetMerchant.services && targetMerchant.services.length > 0
              ? targetMerchant.services
                  .map(
                    (s: any) =>
                      `• **${s.name}**: ${formatAmount(BigInt(s.priceUnits))} Credit\n  _${s.description || "No description provided"}_`
                  )
                  .join("\n")
              : "• No specific services currently listed for this merchant.";

          return {
            success: true,
            type: "MESSAGE",
            intent: "SPEND_CREDIT",
            requiresWalletSignature: false,
            text: `🛍️ **${targetMerchant.name} Service Catalog**:\n${servicesList}\n\nTo purchase a service, simply say:\n• "Buy [Service Name] from ${targetMerchant.name}"\n• "Pay for [Service Name]"`,
            preview: {
              merchant: targetMerchant.name,
              services: (targetMerchant.services || []).map((s: any) => ({
                name: s.name,
                price: `${formatAmount(BigInt(s.priceUnits))} Credit`,
              })),
            },
          };
        }
      }

      // Overall Catalog of all merchants and their services
      const catalogSections = merchantsWithServices.map((m) => {
        const sList =
          m.services && m.services.length > 0
            ? m.services
                .map((s: any) => `  - **${s.name}**: ${formatAmount(BigInt(s.priceUnits))} Credit (${s.description})`)
                .join("\n")
            : "  - _Custom credit settlement_";
        return `🏢 **${m.name}**:\n${sList}`;
      });

      const catalogText =
        catalogSections.length > 0
          ? catalogSections.join("\n\n")
          : "No approved merchants or services are currently registered.";

      return {
        success: true,
        type: "MESSAGE",
        intent: "SPEND_CREDIT",
        requiresWalletSignature: false,
        text: `🛍️ **Available Merchant Services Directory** (PRD §4.3):\nClients spend credit on specific cataloged services provided by approved merchants ($0 platform fees):\n\n${catalogText}\n\nTo purchase, simply say:\n• "Buy [Service Name] from [Merchant Name]"\n• "Pay for [Service Name]"`,
        preview: {
          totalServices: allServices.length,
          platformFee: "$0 (Zero Fee)",
        },
      };
    }

    // 3. User wants to buy a specific service: match service by name
    let matchedService: any = null;
    if (serviceQuery) {
      const sq = serviceQuery.toLowerCase();
      matchedService = allServices.find((s) => {
        const sName = s.name.toLowerCase();
        return sName.includes(sq) || sq.includes(sName);
      });
    }

    // Also check if merchantQuery matches a service name (e.g. user typed "pay for ICC Emergency Arbitrator Filing")
    if (!matchedService && merchantQuery) {
      const mq = merchantQuery.toLowerCase();
      matchedService = allServices.find((s) => s.name.toLowerCase().includes(mq));
    }

    // If a service was matched, we know the exact merchant and the exact fixed price!
    if (matchedService) {
      const servicePrice = formatAmount(BigInt(matchedService.priceUnits));
      const merchant = matchedService.merchant;

      try {
        const prepared = await CreditService.prepareSpendCalldata(userId, {
          merchantAddress: merchant.walletAddress,
          amount: servicePrice,
        });

        return {
          success: true,
          type: "TRANSACTION_PREVIEW",
          intent: "SPEND_CREDIT",
          requiresWalletSignature: true,
          text: `Prepared purchase preview for service **"${matchedService.name}"** from **${merchant.name}** for **${prepared.amount} Credit** ($0 fee). Please confirm with your wallet.`,
          preview: {
            action: "Purchase Merchant Service",
            service: matchedService.name,
            merchant: merchant.name,
            merchantWallet: merchant.walletAddress,
            servicePrice: `${prepared.amount} Credit`,
            description: matchedService.description,
            platformFee: "$0 (No fee)",
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
          text: err?.message || `Failed to prepare purchase of service "${matchedService.name}".`,
        };
      }
    }

    // 4. User specified a merchant name, but no specific service
    if (merchantQuery) {
      let targetMerchant = merchantsWithServices.find(
        (m) =>
          m.name.toLowerCase().includes(merchantQuery.toLowerCase()) ||
          (isAddress(merchantQuery) && m.walletAddress.toLowerCase() === merchantQuery.toLowerCase())
      );

      // Fallback query if not loaded in merchantsWithServices
      if (!targetMerchant) {
        try {
          targetMerchant = await prisma.merchant.findFirst({
            where: {
              isApproved: true,
              OR: [
                { name: { contains: merchantQuery, mode: "insensitive" } },
                ...(isAddress(merchantQuery) ? [{ walletAddress: merchantQuery.toLowerCase() }] : []),
              ],
            },
            include: { services: true },
          });
        } catch {
          // DB error
        }
      }

      if (!targetMerchant) {
        const names = merchantsWithServices.map((m) => `• ${m.name}`).join("\n");
        return {
          success: false,
          type: "ERROR",
          intent: "SPEND_CREDIT",
          requiresWalletSignature: false,
          text: `Merchant "${merchantQuery}" was not found among approved merchants.${names ? `\n\nApproved Merchants:\n${names}` : ""}`,
        };
      }

      // If this merchant has cataloged services, guide the user to select one
      if (targetMerchant.services && targetMerchant.services.length > 0) {
        const sList = targetMerchant.services
          .map((s: any) => `• **${s.name}**: ${formatAmount(BigInt(s.priceUnits))} Credit (${s.description})`)
          .join("\n");

        return {
          success: true,
          type: "MESSAGE",
          intent: "SPEND_CREDIT",
          requiresWalletSignature: false,
          text: `Credit is spent on specific services. **${targetMerchant.name}** offers the following services:\n\n${sList}\n\nTo purchase one, say:\n• "Buy ${targetMerchant.services[0].name} from ${targetMerchant.name}"`,
          preview: {
            merchant: targetMerchant.name,
            services: targetMerchant.services,
          },
        };
      }

      // Fallback if merchant has no cataloged services and an amount is provided
      if (amountStr && Number(amountStr) > 0) {
        try {
          const prepared = await CreditService.prepareSpendCalldata(userId, {
            merchantAddress: targetMerchant.walletAddress,
            amount: amountStr,
          });

          return {
            success: true,
            type: "TRANSACTION_PREVIEW",
            intent: "SPEND_CREDIT",
            requiresWalletSignature: true,
            text: `Prepared payment of ${prepared.amount} Credit to merchant "${targetMerchant.name}". Merchant will receive an on-chain receipt upon confirmation ($0 fee).`,
            preview: {
              action: "Spend Credit",
              merchant: targetMerchant.name,
              merchantWallet: targetMerchant.walletAddress,
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
    }

    // 5. User specified amount but no merchant or service
    if (amountStr && !merchantQuery && !serviceQuery) {
      const names = merchantsWithServices.map((m) => `• ${m.name}`).join("\n");
      return {
        success: true,
        type: "MESSAGE",
        intent: "SPEND_CREDIT",
        requiresWalletSignature: false,
        text: `You specified ${amountStr} Credit. Credit is spent on specific services offered by approved merchants.\n\nApproved Merchants:\n${names}\n\nAsk: "What services can I buy?" to browse catalog offerings.`,
      };
    }

    // 5. Default Fallback
    return {
      success: true,
      type: "MESSAGE",
      intent: "SPEND_CREDIT",
      requiresWalletSignature: false,
      text: "Please specify which service or merchant you would like to purchase from (for example: \"Buy Software Dev package 1 from Sparktech\"). Or ask: \"What services can I buy?\"",
    };
  }

  /**
   * Deterministic local intent parser for User Assistant (Option A - Zero API Keys)
   * Adheres strictly to PRD §4.6 AI-01 and AI-05 (never guesses, refuses ambiguous intents)
   */
  static parseUserIntent(prompt: string): {
    type: "READ_STATUS" | "REQUEST_LOAN" | "REPAY_LOAN" | "EXTEND_LOAN" | "SPEND_CREDIT" | "UNKNOWN";
    target: "BALANCE" | "LOANS" | "TRANSACTIONS" | "ALL" | "GUIDE" | "SERVICES";
    amount: string | null;
    loanId: string | null;
    merchantQuery: string;
    serviceQuery: string;
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
        serviceQuery: "",
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
      (lower.includes("credit") &&
        !lower.includes("pay") &&
        !lower.includes("spend") &&
        !lower.includes("send") &&
        !lower.includes("transfer") &&
        !lower.includes("buy") &&
        !lower.includes("purchase") &&
        !lower.includes("issue") &&
        !lower.includes("debit")) ||
      lower.includes("status") ||
      (lower.includes("how much") && !lower.includes("pay") && !lower.includes("spend") && !lower.includes("send") && !lower.includes("buy")) ||
      lower.includes("limit")
    ) {
      return {
        type: "READ_STATUS",
        target: "BALANCE",
        amount: null,
        loanId: null,
        merchantQuery: "",
        serviceQuery: "",
      };
    }

    if (lower.includes("my loans") || lower.includes("active loans") || lower.includes("list loans")) {
      return {
        type: "READ_STATUS",
        target: "LOANS",
        amount: null,
        loanId: null,
        merchantQuery: "",
        serviceQuery: "",
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
        serviceQuery: "",
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
        serviceQuery: "",
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
        serviceQuery: "",
      };
    }

    // 6. Spend Credit & Services Catalog Inquiries
    if (
      lower.includes("service") ||
      lower.includes("catalog") ||
      lower.includes("offering") ||
      lower.includes("what can i buy") ||
      lower.includes("what can i purchase") ||
      lower.includes("what does") ||
      lower.includes("how to spend") ||
      lower.includes("how do i spend") ||
      lower.includes("where can i spend") ||
      lower.includes("who can i pay") ||
      lower.includes("list merchants") ||
      lower.includes("show merchants") ||
      lower.includes("approved merchants") ||
      lower.trim() === "spend credit" ||
      lower.trim() === "spend"
    ) {
      let merchantQuery = "";
      const toMatch = lower.match(/(?:from|at|by|of|for|with|does)\s+([a-zA-Z0-9_\- ]+)/i);
      if (toMatch && toMatch[1]) {
        merchantQuery = toMatch[1].replace(/\b(offer|services|service|credit|usdc|\?)\b/gi, "").trim();
      }

      return {
        type: "SPEND_CREDIT",
        target: "SERVICES",
        amount: null,
        loanId: null,
        merchantQuery,
        serviceQuery: "",
      };
    }

    // 7. Spend Credit Transactions (Pay, Spend, Send, Transfer, Buy, Purchase)
    if (
      lower.includes("spend") ||
      lower.includes("send") ||
      lower.includes("transfer") ||
      lower.includes("buy") ||
      lower.includes("purchase") ||
      lower.includes("order") ||
      lower.includes("hire") ||
      (lower.includes("pay") && !lower.includes("repay") && !lower.includes("pay back") && !lower.includes("pay loan"))
    ) {
      let merchantQuery = "";
      let serviceQuery = "";
      let amount: string | null = null;

      // Extract amount if present
      const amountMatch = lower.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/);
      amount = amountMatch && amountMatch[1] ? amountMatch[1].replace(/,/g, "") : null;

      // Check for format: "buy <service> from/at/by/with <merchant>"
      const buyWithMerchantMatch = lower.match(
        /(?:buy|purchase|order|hire|pay for)\s+([a-zA-Z0-9_\- ]+?)\s+(?:from|at|by|with)\s+([a-zA-Z0-9_\- ]+)/i
      );

      if (buyWithMerchantMatch && buyWithMerchantMatch[1] && buyWithMerchantMatch[2]) {
        serviceQuery = buyWithMerchantMatch[1].replace(/\b(credit|usdc)\b/gi, "").trim();
        merchantQuery = buyWithMerchantMatch[2].replace(/\b(credit|usdc)\b/gi, "").trim();
      } else {
        // Extract merchant if after "from", "at", "by", "with", "to"
        const merchantMatch = lower.match(/(?:from|at|by|with|to)\s+([a-zA-Z0-9_\- ]+)/i);
        if (merchantMatch && merchantMatch[1]) {
          merchantQuery = merchantMatch[1].replace(/\b(credit|usdc|dollars|\$|merchant|company|corp)\b/gi, "").trim();
        }

        // Extract service name if after "buy", "purchase", "order", "hire", "pay for"
        const serviceMatch = lower.match(
          /(?:buy|purchase|order|hire|pay for)\s+([a-zA-Z0-9_\- ]+?)(?:\s*$)/i
        );
        if (serviceMatch && serviceMatch[1]) {
          serviceQuery = serviceMatch[1].replace(/\b(credit|usdc)\b/gi, "").trim();
        }
      }

      // Check direct format: "pay sparktech 250"
      if (!merchantQuery) {
        const directPayMatch = lower.match(
          /(?:pay|send|transfer)\s+([a-zA-Z\s]+?)\s+\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)(?:\s*credit|\s*usdc)?$/i
        );

        if (directPayMatch && directPayMatch[1] && directPayMatch[2] && !directPayMatch[1].includes("to ") && !directPayMatch[1].includes("credit")) {
          merchantQuery = directPayMatch[1].trim();
          amount = directPayMatch[2].replace(/,/g, "");
        }
      }

      return {
        type: "SPEND_CREDIT",
        target: !amount && !merchantQuery && !serviceQuery ? "SERVICES" : "ALL",
        amount,
        loanId: null,
        merchantQuery,
        serviceQuery,
      };
    }

    return {
      type: "UNKNOWN",
      target: "ALL",
      amount: null,
      loanId: null,
      merchantQuery: "",
      serviceQuery: "",
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
