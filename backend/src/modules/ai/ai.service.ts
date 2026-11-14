import { randomBytes } from "node:crypto";
import { encodeFunctionData, isAddress, Address, bytesToHex } from "viem";
import { prisma } from "../../lib/prisma.js";
import { INDICO_LEDGER_ABI, publicClient } from "../../lib/viem.js";
import { AppError } from "../../lib/errors.js";
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

          // The USDC approval, when needed, must be signed before the repay or the repay reverts.
          const txs = [prepared.approvalTx, prepared.repayTx]
            .filter((tx): tx is NonNullable<typeof tx> => tx != null)
            .map((tx) => ({ to: tx.to, data: tx.data, value: tx.value, estimatedGasEth: tx.gasCostEth }));

          return {
            success: true,
            type: "TRANSACTION_PREVIEW",
            intent: "REPAY_LOAN",
            requiresWalletSignature: true,
            text:
              `Prepared repayment preview for Loan #${prepared.loanId}. Principal of ${prepared.principal} USDC will be repaid and ${prepared.collateral} Credit collateral unlocked.` +
              (txs.length > 1 ? " Your wallet will ask for 2 approvals: USDC spending, then the repayment." : ""),
            preview: {
              action: "Repay Loan",
              loanId: prepared.loanId,
              principalToRepay: `${prepared.principal} USDC`,
              collateralToRelease: `${prepared.collateral} Credit`,
              walletApprovals: txs.length,
            },
            ...(txs.length === 1 ? { preparedTx: txs[0] } : {}),
            preparedTxs: txs,
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
    const limitUnits = (availableUnits * 8000n) / 10000n;
    // A loan is also refused above the pool's cash, so the real maximum is the smaller of the two.
    let poolUnits: bigint | null;
    try {
      poolUnits = (await publicClient.readContract({
        address: env.INDICO_LEDGER_ADDRESS as Address,
        abi: INDICO_LEDGER_ABI,
        functionName: "poolAvailable",
      })) as bigint;
    } catch {
      poolUnits = null;
    }
    const poolLimited = poolUnits !== null && poolUnits < limitUnits;
    const maxBorrowUnits = poolLimited ? poolUnits! : limitUnits;
    const maxBorrow = formatAmount(maxBorrowUnits);
    const maxBorrowLine =
      poolUnits === null
        ? `• Max Borrowable Now (80% LTV, before pool liquidity): ${maxBorrow} USDC`
        : poolLimited
          ? `• Max Borrowable Now: ${maxBorrow} USDC (limited by pool liquidity)`
          : `• Max Borrowable Now (80% LTV): ${maxBorrow} USDC`;

    const activeLoansCount = await prisma.loan.count({
      where: { borrower: walletAddress, status: "ACTIVE" },
    });

    return {
      success: true,
      type: "MESSAGE",
      intent: "READ_STATUS",
      requiresWalletSignature: false,
      text: `📊 Financial Summary:\n• Available Credit: ${availableCredit} USDC\n• Locked Collateral: ${lockedCredit} Credit\n${maxBorrowLine}\n• Active Loans: ${activeLoansCount}`,
      preview: {
        availableCredit: `${availableCredit} USDC`,
        lockedCredit: `${lockedCredit} Credit`,
        maxBorrowable: `${maxBorrow} USDC`,
        poolAvailable: poolUnits === null ? null : `${formatAmount(poolUnits)} USDC`,
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
  static async handleAdminCommand(adminId: string, rawPrompt: string): Promise<AiResponse> {
    const prompt = rawPrompt.trim();
    const lower = prompt.toLowerCase();

    // 1. Issue and debit credit (AD-10, AD-11, AD-12)
    if (/\b(issue|mint|grant)\s+credit\b/.test(lower)) return AiService.prepareAdminCredit("ISSUE", adminId, prompt);
    if (/\b(debit|burn|deduct)\s+credit\b/.test(lower)) return AiService.prepareAdminCredit("DEBIT", adminId, prompt);

    // 2. Merchant bookkeeping (AD-05, AD-06): off-chain, no wallet signature
    const merchantReply = await AiService.handleMerchantCommand(adminId, prompt);
    if (merchantReply) return merchantReply;

    // 3. Lookup a user or merchant by email, wallet or merchant name
    const emailMatch = prompt.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const addressMatch = prompt.match(/0x[a-fA-F0-9]{40}/);
    const merchantName = addressMatch ? undefined : prompt.match(/\bmerchant\s+(.+?)\s*$/i)?.[1];
    const mentionsUser = /\buser\b/i.test(prompt);
    const lookupWord = /\b(look\s*up|lookup|find|show|who\s+is|details?|info)\b/i.test(prompt);
    if ((lookupWord || mentionsUser) && (emailMatch || addressMatch || merchantName || mentionsUser)) {
      const user =
        emailMatch || addressMatch
          ? await prisma.user.findFirst({
              where: {
                OR: [
                  ...(emailMatch ? [{ email: emailMatch[0].toLowerCase() }] : []),
                  ...(addressMatch ? [{ walletBinding: { walletAddress: addressMatch[0].toLowerCase() } }] : []),
                ],
              },
              include: { walletBinding: true },
            })
          : null;

      if (user) {
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

      // Not a user: the wallet or name may be a merchant's.
      const merchantWhere = addressMatch
        ? { walletAddress: addressMatch[0].toLowerCase() }
        : merchantName
          ? { name: { equals: merchantName, mode: "insensitive" as const } }
          : null;
      const merchants = merchantWhere
        ? await prisma.merchant.findMany({ where: merchantWhere, include: { services: true }, take: 2 })
        : [];
      if (merchants.length > 1) {
        return {
          success: true,
          type: "MESSAGE",
          intent: "ADMIN_LOOKUP_MERCHANT",
          requiresWalletSignature: false,
          text: `More than one merchant is named "${merchantName}". Look it up by its wallet address.`,
        };
      }
      if (merchants.length === 1) return AiService.merchantRecord(merchants[0]!, !!addressMatch);

      return {
        success: true,
        type: "MESSAGE",
        intent: "ADMIN_LOOKUP_USER",
        requiresWalletSignature: false,
        text: "User not found. No user or merchant matches that email, wallet or name (e.g. \"Lookup user alice@indico.example\" or \"Lookup merchant TestMerchant\").",
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
      text: "Supported Admin Console Commands:\n• \"Pool liquidity status\"\n• \"Show active and overdue loans\"\n• \"Lookup user [email or wallet]\" or \"Lookup merchant [name or wallet]\"\n• \"Issue credit of [amount] to [wallet]\"\n• \"Debit credit of [amount] from [wallet]\"\n  (add \"ref [your reference]\" to either; it stays off-chain)\n• \"Add service [name] to merchant [name or wallet] price [amount]\"\n• \"Update price of [service] for merchant [name or wallet] to [amount]\"\n• \"Send agreement to merchant [name or wallet]\" (records it as sent; no email is sent)",
    };
  }

  /** Prepares adminIssueCredit / adminDebitCredit after checking the ledger would accept it. */
  private static async prepareAdminCredit(kind: "ISSUE" | "DEBIT", adminId: string, prompt: string): Promise<AiResponse> {
    const intent = kind === "ISSUE" ? "ADMIN_ISSUE_CREDIT" : "ADMIN_DEBIT_CREDIT";
    const fail = (type: "UNKNOWN" | "ERROR", text: string): AiResponse => ({
      success: type === "UNKNOWN",
      type,
      intent,
      requiresWalletSignature: false,
      text,
    });

    const wallet = prompt.match(/0x[a-fA-F0-9]{40}/)?.[0] as Address | undefined;
    const reference = prompt.match(REFERENCE_RE)?.[1] ?? null;
    const amountUnits = parseCommandAmount(prompt.replace(/0x[a-fA-F0-9]{40}/g, " ").replace(REFERENCE_RE, " "));
    if (!wallet || amountUnits === null) {
      return fail(
        "UNKNOWN",
        kind === "ISSUE"
          ? 'To issue credit, give the wallet and an amount above 0 with at most 6 decimals, e.g. "Issue credit of 1,000 to 0x7099...79C8 ref INV-001".'
          : 'To debit credit, give the wallet and an amount above 0 with at most 6 decimals, e.g. "Debit credit of 500 from 0x7099...79C8 ref CASH-001".'
      );
    }

    // The same refusals the ledger would give, so the admin never signs a transaction that reverts.
    const read = (functionName: "participantRole" | "paused" | "credit" | "available", args: readonly unknown[]) =>
      publicClient.readContract({ address: env.INDICO_LEDGER_ADDRESS as Address, abi: INDICO_LEDGER_ABI, functionName, args } as any);
    let role: number, paused: boolean, balance: bigint;
    try {
      [role, paused, balance] = (await Promise.all([
        read("participantRole", [wallet]),
        read("paused", []),
        read(kind === "ISSUE" ? "credit" : "available", [wallet]),
      ])) as [number, boolean, bigint];
    } catch {
      return fail("ERROR", "Could not read the ledger to check this command. Nothing was prepared; try again.");
    }
    const amount = formatAmount(amountUnits);
    if (paused) return fail("ERROR", "The ledger is paused; credit cannot be issued or debited until it is unpaused.");
    if (kind === "ISSUE" && Number(role) !== 1) return fail("ERROR", `${wallet} is not a registered user; credit is issued to users only.`);
    if (kind === "DEBIT" && Number(role) !== 1 && Number(role) !== 2) return fail("ERROR", `${wallet} is not a registered user or merchant.`);
    if (kind === "ISSUE" && balance + amountUnits > CREDIT_CAP) {
      return fail("ERROR", `Issuing ${amount} would pass the per-account credit cap for ${wallet}.`);
    }
    if (kind === "DEBIT" && amountUnits > balance) {
      return fail("ERROR", `Debit of ${amount} exceeds the available credit of ${formatAmount(balance)} for ${wallet}.`);
    }

    // The memo is public on chain, so it is random; the admin's reference stays in the audit log (O-043).
    const memo = bytesToHex(randomBytes(32));
    const data = encodeFunctionData({
      abi: INDICO_LEDGER_ABI,
      functionName: kind === "ISSUE" ? "adminIssueCredit" : "adminDebitCredit",
      args: [wallet, amountUnits, memo],
    });
    await prisma.auditLog.create({
      data: {
        actorType: "ADMIN",
        actorId: adminId,
        action: "AI_CREDIT_PREPARED",
        resource: "Credit",
        resourceId: wallet.toLowerCase(),
        payload: { kind, wallet, amount, reference, memo },
      },
    });

    return {
      success: true,
      type: "ACTION_PREVIEW",
      intent,
      requiresWalletSignature: true,
      text:
        kind === "ISSUE"
          ? `Prepared issuance of ${amount} Credit to ${wallet}. It needs the admin wallet's signature.`
          : `Prepared debit of ${amount} Credit from ${wallet}. It needs the admin wallet's signature.`,
      preview:
        kind === "ISSUE"
          ? { action: "adminIssueCredit (AD-10)", recipient: wallet, creditToIssue: `${amount} Credit`, reference, memo }
          : { action: "adminDebitCredit (AD-12)", userAddress: wallet, creditToDebit: `${amount} Credit`, reference, memo },
      preparedTx: { to: env.INDICO_LEDGER_ADDRESS, data, value: "0" },
    };
  }

  /** A merchant's database record plus its on-chain figures; figures read as unavailable if the ledger can't be read. */
  private static async merchantRecord(
    merchant: { id: string; name: string; walletAddress: string; agreementStatus: string; services?: unknown[] },
    byWallet: boolean
  ): Promise<AiResponse> {
    const wallet = merchant.walletAddress as Address;
    const read = (functionName: "approvedMerchant" | "depositBoxOf" | "credit" | "maxWithdraw") =>
      publicClient.readContract({ address: env.INDICO_LEDGER_ADDRESS as Address, abi: INDICO_LEDGER_ABI, functionName, args: [wallet] } as any);
    let approved: boolean | null = null, box: string | null = null, credit: bigint | null = null, position: bigint | null = null;
    try {
      const [a, b, c, d] = await Promise.all([read("approvedMerchant"), read("depositBoxOf"), read("credit"), read("maxWithdraw")]);
      approved = Boolean(a);
      box = /^0x0+$/.test(String(b)) ? null : String(b);
      credit = c as bigint;
      position = d as bigint;
    } catch {
      // On-chain figures stay unknown; the database fields are still shown.
    }
    const shown = (v: string | null) => v ?? "unavailable";
    const creditText = credit === null ? null : formatAmount(credit);
    const positionText = position === null ? null : formatAmount(position);
    return {
      success: true,
      type: "MESSAGE",
      intent: "ADMIN_LOOKUP_MERCHANT",
      requiresWalletSignature: false,
      text:
        (byWallet ? "This wallet is a merchant, not a user.\n" : "") +
        `🏢 Merchant Record (${merchant.name}):\n• Wallet: ${merchant.walletAddress}\n• Approved On-Chain: ${approved === null ? "unavailable" : approved ? "YES" : "NO"}\n• Agreement: ${merchant.agreementStatus}\n• Deposit Address: ${box ?? (approved === null ? "unavailable" : "none")}\n• Credit Received: ${shown(creditText)}${creditText ? " Credit" : ""}\n• Pool Position (withdrawable): ${shown(positionText)}${positionText ? " USDC" : ""}\n• Services: ${merchant.services?.length ?? 0}`,
      preview: {
        kind: "merchant",
        id: merchant.id,
        name: merchant.name,
        walletAddress: merchant.walletAddress,
        approvedOnChain: approved,
        agreementStatus: merchant.agreementStatus,
        depositAddress: box,
        creditReceived: creditText,
        poolPosition: positionText,
        services: merchant.services?.length ?? 0,
      },
    };
  }

  /** Add or update a merchant's service, or mark its agreement sent. Returns null if the prompt is none of these. */
  private static async handleMerchantCommand(adminId: string, prompt: string): Promise<AiResponse | null> {
    // "merchant" named first (so a service name may contain "for"), then the looser older wording.
    const price = String.raw`\s+(?:(?:at\s+)?price(?:\s+of)?|at|for|to)\s+\$?([\d,]+(?:\.\d+)?)(?:\s*(?:usdc|credits?))?\s*$`;
    const add =
      prompt.match(new RegExp(String.raw`^add\s+(?:a\s+)?service\s+(.+?)\s+(?:to|for)\s+merchant\s+(.+?)` + price, "i")) ??
      prompt.match(new RegExp(String.raw`^add\s+(?:a\s+)?service\s+(.+?)\s+(?:to|for)\s+(.+?)` + price, "i"));
    if (!add && /^add\s+(?:a\s+)?service\b/i.test(prompt)) {
      return {
        success: true,
        type: "UNKNOWN",
        intent: "ADMIN_ADD_SERVICE",
        requiresWalletSignature: false,
        text: 'To add a service, write: "Add service [name] to merchant [name or wallet] price [amount]" (for example "Add service Legal consultation to merchant TestMerchant price 50").',
      };
    }
    const upd = prompt.match(/^(?:update|change|set)\s+(?:the\s+)?price\s+of\s+(.+?)\s+for\s+(?:merchant\s+)?(.+?)\s+to\s+\$?(\S+)\s*$/i);
    const send = prompt.match(/^send\s+(?:the\s+)?(?:arbitration\s+)?agreement\s+to\s+(?:merchant\s+)?(.+?)\s*$/i);
    const intent = add ? "ADMIN_ADD_SERVICE" : upd ? "ADMIN_UPDATE_SERVICE" : send ? "ADMIN_SEND_AGREEMENT" : null;
    if (!intent) return null;

    const reply = (type: "MESSAGE" | "UNKNOWN" | "ERROR", text: string): AiResponse => ({
      success: type !== "ERROR",
      type,
      intent,
      requiresWalletSignature: false,
      text,
    });

    const query = (add?.[2] ?? upd?.[2] ?? send![1]!).trim();
    const merchants = await prisma.merchant.findMany({
      where: isAddress(query)
        ? { walletAddress: query.toLowerCase() }
        : { name: { equals: query, mode: "insensitive" } },
      take: 2,
    });
    if (merchants.length === 0) return reply("UNKNOWN", `No merchant matches "${query}". Use its exact name or wallet address.`);
    if (merchants.length > 1) return reply("UNKNOWN", `More than one merchant is named "${query}". Use its wallet address.`);
    const merchant = merchants[0]!;

    try {
      if (send) {
        await AdminOperationsService.sendMerchantAgreement(adminId, merchant.id);
        return reply("MESSAGE", `Recorded the agreement as sent to ${merchant.name}. No email is sent; send the document yourself.`);
      }

      const priceText = (add?.[3] ?? upd![3])!;
      const units = /^[\d,]+(?:\.\d+)?$/.test(priceText) ? parseCommandAmount(priceText) : null;
      if (units === null) return reply("UNKNOWN", `"${priceText}" is not a price above 0 with at most 6 decimals.`);
      const price = formatAmount(units);

      if (add) {
        const name = add[1]!.trim();
        await AdminOperationsService.addMerchantService(adminId, merchant.id, { name, price, description: name });
        return reply("MESSAGE", `Added "${name}" at ${price} credit to ${merchant.name}.`);
      }

      const wanted = upd![1]!.trim();
      const { services } = await AdminOperationsService.getMerchantServices(merchant.id);
      const service = services.find((sv: { name: string }) => sv.name.toLowerCase() === wanted.toLowerCase());
      if (!service) {
        const names = services.map((sv: { name: string }) => sv.name).join(", ") || "none";
        return reply("UNKNOWN", `${merchant.name} has no service "${wanted}". Its services: ${names}.`);
      }
      await AdminOperationsService.updateMerchantService(adminId, merchant.id, service.id, { price });
      return reply("MESSAGE", `Updated "${service.name}" for ${merchant.name} to ${price} credit.`);
    } catch (err) {
      if (err instanceof AppError) return reply("ERROR", err.message);
      throw err;
    }
  }
}

/** "ref INV-001", "reference: X", "memo #X": an admin's own reference, kept off-chain. */
const REFERENCE_RE = /\b(?:ref|reference|memo)\b\s*[:#]?\s*([A-Za-z0-9._\/-]{1,64})/i;

/** Per-account credit cap enforced by the ledger (D-27). */
const CREDIT_CAP = (1n << 128n) - 1n;

/** First number in the text as 6-decimal units, or null if there is none, it is 0, or it has over 6 decimals. */
function parseCommandAmount(text: string): bigint | null {
  const match = text.match(/(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?![\w.])/);
  if (!match) return null;
  try {
    const units = parseAmount(match[1]!.replace(/,/g, "") + (match[2] ?? ""));
    return units > 0n ? units : null;
  } catch {
    return null;
  }
}
