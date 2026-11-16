import { randomBytes } from "node:crypto";
import { encodeFunctionData, isAddress, Address, bytesToHex } from "viem";
import { prisma } from "../../lib/prisma.js";
import { INDICO_LEDGER_ABI, publicClient } from "../../lib/viem.js";
import { AppError } from "../../lib/errors.js";
import { parseAmount, formatAmount } from "../../lib/amount.js";
import { env } from "../../config/env.js";
import { LoansService } from "../loans/loans.service.js";
import { CreditService } from "../credit/credit.service.js";
import { HistoryService } from "../history/history.service.js";
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

      case "INFO": {
        return {
          success: true,
          type: "MESSAGE",
          intent: "READ_STATUS",
          requiresWalletSignature: false,
          text: INFO_TEXT[intent.info!],
          ...(intent.info === "HELP" ? { suggestions: STARTERS } : {}),
        };
      }

      case "MULTIPLE": {
        return {
          success: true,
          type: "UNKNOWN",
          intent: "UNKNOWN",
          requiresWalletSignature: false,
          text: 'Please ask for these one at a time: one payment, one loan, or one repayment. For example "Borrow 500 USDC", then "Repay loan #4".',
        };
      }

      case "REQUEST_LOAN": {
        if (!intent.amount || !(Number(intent.amount) > 0)) {
          return {
            success: true,
            type: "UNKNOWN",
            intent: "REQUEST_LOAN",
            requiresWalletSignature: false,
            text: 'How much do you want to borrow? Write a positive amount in numbers, for example "Borrow 500 USDC". Or use the Loans screen.',
            suggestions: [{ label: "Borrow…", prompt: "Borrow " }],
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
          const loans = await AiService.activeLoans(userId);
          return {
            success: true,
            type: "UNKNOWN",
            intent: "REPAY_LOAN",
            requiresWalletSignature: false,
            text: loans.length
              ? 'Which loan do you want to repay? Tell me its number, for example "Repay loan #4".'
              : "You have no active loans to repay.",
            suggestions: loans.slice(0, 6).map(repaySuggestion),
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
          const loans = await AiService.activeLoans(userId);
          return {
            success: true,
            type: "UNKNOWN",
            intent: "EXTEND_LOAN",
            requiresWalletSignature: false,
            text: loans.length
              ? 'Which loan do you want to extend? Tell me its number, for example "Extend loan #4". A loan can be extended in the last 30 days before it is due.'
              : "You have no active loans to extend.",
            suggestions: loans.filter(extensionOpen).slice(0, 6).map(extendSuggestion),
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
          text: `I couldn't map that request with certainty. ${INFO_TEXT.HELP}`,
          suggestions: STARTERS,
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
    if (target === "TRANSACTIONS") {
      const { items } = await HistoryService.getUserTransactions(userId);
      const lines = items
        .filter((e) => HISTORY_LABELS[e.eventName])
        .slice(0, 8)
        .map((e) => {
          const raw = e.data?.amount ?? e.data?.principal ?? e.data?.value;
          const amount = raw !== undefined && /^\d+$/.test(String(raw)) ? `: ${formatAmount(BigInt(raw))}` : "";
          return `• ${new Date(e.blockTimestamp * 1000).toISOString().slice(0, 10)} ${HISTORY_LABELS[e.eventName]}${amount}`;
        });
      return {
        success: true,
        type: "MESSAGE",
        intent: "READ_STATUS",
        requiresWalletSignature: false,
        text: lines.length ? `Your recent transactions:\n${lines.join("\n")}` : "You have no transactions yet.",
      };
    }

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
      suggestions: [
        ...(await AiService.activeLoans(userId)).filter(extensionOpen).flatMap((l) => [repaySuggestion(l), extendSuggestion(l)]),
        ...(maxBorrowUnits > 0n ? [{ label: `Borrow (up to ${short(maxBorrowUnits)} USDC)`, prompt: "Borrow " }] : []),
      ].slice(0, 6),
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
   * Resolves the merchant and service and prepares a payment (PRD §4.3, §4.6). A merchant is named by
   * its full name or wallet, never guessed from part of a name (AI-05); two candidates mean a question.
   */
  private static async handleUserSpendCredit(
    userId: string,
    merchantQuery: string,
    serviceQuery: string,
    amountStr: string | null,
    target?: string
  ): Promise<AiResponse> {
    let merchants: Array<any> = [];
    try {
      merchants = await prisma.merchant.findMany({ where: { isApproved: true }, include: { services: true } });
    } catch {
      // No merchant list; every lookup below then finds nothing.
    }
    const reply = (type: AiResponse["type"], text: string, extra: Partial<AiResponse> = {}): AiResponse => ({
      success: type !== "ERROR",
      type,
      intent: "SPEND_CREDIT",
      requiresWalletSignature: false,
      text,
      ...extra,
    });
    const price = (s: any) => `${formatAmount(BigInt(s.priceUnits))} credit`;
    const catalog = (m: any) =>
      reply(
        "MESSAGE",
        (m.services?.length
          ? `${m.name} offers:\n${m.services.map((s: any) => `• ${s.name}: ${price(s)}${s.description ? ` (${s.description})` : ""}`).join("\n")}\n\nSay "Buy ${m.services[0].name} from ${m.name}", or pay any amount with "Pay ${m.name} 50".`
          : `${m.name} has no services listed. Pay any amount with "Pay ${m.name} 50".`),
        {
          preview: { merchant: m.name, services: (m.services || []).map((s: any) => ({ name: s.name, price: price(s) })) },
          suggestions: (m.services || []).slice(0, 6).map((s: any) => ({
            label: `Buy ${s.name} (${short(BigInt(s.priceUnits))})`,
            prompt: `Buy ${s.name} from ${m.name}`,
          })),
        }
      );
    const offers = (list: Array<any>) => list.slice(0, 6).map((m) => ({ label: m.name, prompt: `What does ${m.name} offer?` }));
    const names = merchants.map((m) => `• ${m.name}`).join("\n");

    const found = merchantQuery ? AiService.resolveMerchant(merchants, merchantQuery) : null;
    if (found && "ambiguous" in found) {
      return reply("UNKNOWN", `Which merchant do you mean?\n${found.ambiguous.map((m) => `• ${m.name}`).join("\n")}\nWrite the full name.`, {
        suggestions: found.ambiguous.slice(0, 6).map((m) => ({
          label: m.name,
          prompt: amountStr ? `Pay ${m.name} ${amountStr}` : serviceQuery ? `Buy ${serviceQuery} from ${m.name}` : `What does ${m.name} offer?`,
        })),
      });
    }
    const merchant = found?.merchant ?? null;

    // Questions about what can be bought
    if (target === "SERVICES" || (!merchantQuery && !serviceQuery && !amountStr)) {
      if (merchant) return catalog(merchant);
      const sections = merchants.map((m) =>
        `${m.name}:\n${m.services?.length ? m.services.map((s: any) => `  - ${s.name}: ${price(s)}`).join("\n") : "  - Any amount"}`
      );
      return reply(
        "MESSAGE",
        `Available Merchant Services Directory (no platform fees):\n\n${sections.length ? sections.join("\n\n") : "No approved merchants yet."}\n\nTo pay, say "Buy [service] from [merchant]" or "Pay [merchant] [amount]".`,
        { preview: { totalServices: merchants.reduce((n, m) => n + (m.services?.length ?? 0), 0), platformFee: "$0 (Zero Fee)" }, suggestions: offers(merchants) }
      );
    }

    if (amountStr !== null && !(Number(amountStr) > 0)) {
      return reply("UNKNOWN", 'Please write a positive amount in numbers, for example "Pay TestMerchant 50".');
    }
    if (merchantQuery && !merchant) {
      return reply(
        "ERROR",
        `Merchant "${merchantQuery}" was not found among approved merchants. Write the merchant's full name and the amount in numbers, for example "Pay TestMerchant 50".${names ? `\n\nApproved merchants:\n${names}` : ""}`,
        { suggestions: offers(merchants) }
      );
    }

    const prepare = async (m: any, amount: string, extraPreview: Record<string, unknown>, text: (a: string) => string) => {
      try {
        const prepared = await CreditService.prepareSpendCalldata(userId, { merchantAddress: m.walletAddress, amount });
        return reply("TRANSACTION_PREVIEW", text(prepared.amount), {
          requiresWalletSignature: true,
          preview: { merchant: m.name, merchantWallet: m.walletAddress, platformFee: "$0 (No fee)", ...extraPreview, ...(extraPreview.action === "Spend Credit" ? { amountToSpend: `${prepared.amount} Credit` } : { servicePrice: `${prepared.amount} Credit` }) },
          preparedTx: { to: prepared.to, data: prepared.data, value: prepared.value, estimatedGasEth: prepared.gasCostEth },
        });
      } catch (err: any) {
        return reply("ERROR", err?.message || "Failed to prepare the payment.");
      }
    };

    // A named service, at the named merchant when one is given
    if (serviceQuery) {
      const q = serviceQuery.trim().toLowerCase();
      const pool = (merchant ? [merchant] : merchants).flatMap((m) => (m.services || []).map((s: any) => ({ ...s, merchant: m })));
      const exact = pool.filter((s) => s.name.toLowerCase() === q);
      const hits = exact.length ? exact : pool.filter((s) => s.name.toLowerCase().includes(q));
      if (hits.length > 1) {
        return reply("UNKNOWN", `Which one do you mean?\n${hits.map((s) => `• ${s.name} from ${s.merchant.name}: ${price(s)}`).join("\n")}`, {
          suggestions: hits.slice(0, 6).map((s) => ({
            label: `${s.name} from ${s.merchant.name} (${short(BigInt(s.priceUnits))})`,
            prompt: `Buy ${s.name} from ${s.merchant.name}`,
          })),
        });
      }
      if (hits.length === 1) {
        const s = hits[0];
        return prepare(s.merchant, formatAmount(BigInt(s.priceUnits)), { action: "Purchase Merchant Service", service: s.name, description: s.description },
          (a) => `Prepared purchase of "${s.name}" from ${s.merchant.name} for ${a} credit (no fee). Please confirm in your wallet.`);
      }
      if (merchant) return catalog(merchant);
      return reply("ERROR", `No approved merchant offers "${serviceQuery}". Ask "What services can I buy?" to see them.`);
    }

    // Any amount to a named merchant (C-04)
    if (merchant && amountStr) {
      return prepare(merchant, amountStr, { action: "Spend Credit", fee: "$0 (No fee)" },
        (a) => `Prepared payment of ${a} credit to ${merchant.name}. The merchant gets an on-chain receipt when you confirm (no fee).`);
    }
    if (merchant) return catalog(merchant);

    return reply("MESSAGE", `You specified ${amountStr} Credit. Credit is spent with approved merchants:\n${names}\n\nSay "Pay [merchant] ${amountStr}", or ask "What services can I buy?".`);
  }

  /** The user's active loans from the read model; none when unbound or unreadable. */
  private static async activeLoans(userId: string): Promise<Array<any>> {
    try {
      const binding = await prisma.walletBinding.findUnique({ where: { userId } });
      if (!binding) return [];
      return await prisma.loan.findMany({ where: { borrower: binding.walletAddress, status: "ACTIVE" }, orderBy: { loanId: "asc" } });
    } catch {
      return [];
    }
  }

  /** A merchant by wallet, full name, or the first whole words of exactly one name. */
  static resolveMerchant(merchants: Array<any>, query: string): { merchant: any } | { ambiguous: Array<any> } | null {
    const q = query.trim().toLowerCase();
    if (isAddress(q)) {
      const m = merchants.find((x) => x.walletAddress.toLowerCase() === q);
      return m ? { merchant: m } : null;
    }
    const exact = merchants.filter((m) => m.name.toLowerCase() === q);
    const hits = exact.length ? exact : merchants.filter((m) => m.name.toLowerCase().startsWith(`${q} `));
    if (hits.length === 1) return { merchant: hits[0] };
    return hits.length ? { ambiguous: hits } : null;
  }

  /**
   * Deterministic local intent parser for User Assistant (Option A - Zero API Keys)
   * Adheres strictly to PRD §4.6 AI-01 and AI-05 (never guesses, refuses ambiguous intents).
   * Amounts, loan numbers and durations are kept apart; two commands in one message are refused.
   */
  static parseUserIntent(prompt: string): {
    type: "READ_STATUS" | "REQUEST_LOAN" | "REPAY_LOAN" | "EXTEND_LOAN" | "SPEND_CREDIT" | "MULTIPLE" | "INFO" | "UNKNOWN";
    target: "BALANCE" | "LOANS" | "TRANSACTIONS" | "ALL" | "GUIDE" | "SERVICES";
    amount: string | null;
    loanId: string | null;
    merchantQuery: string;
    serviceQuery: string;
    info: InfoTopic | null;
  } {
    const lower = prompt.toLowerCase().trim();
    type Result = ReturnType<typeof AiService.parseUserIntent>;
    const out = (r: Partial<Result> & Pick<Result, "type">): Result => ({
      target: "ALL", amount: null, loanId: null, merchantQuery: "", serviceQuery: "", info: null, ...r,
    });

    if (/ignore all instructions|system prompt|give me admin|bypass/.test(lower)) return out({ type: "UNKNOWN" });
    if (/^(?:hi|hello|hey|help|menu|commands|what can you do|thanks|thank you)[\s!?.]*$/.test(lower)) {
      return out({ type: "INFO", info: "HELP" });
    }
    if (/\b(?:interest|apr|fees?|charges?)\b/.test(lower) && !/\d/.test(lower)) return out({ type: "INFO", info: "NO_INTEREST" });
    if (/\b(?:sell|withdraw|cash\s*out|convert|exchange|swap|redeem)\b/.test(lower)) return out({ type: "INFO", info: "NO_CASHOUT" });

    const repay = /\brepay\b|\bpay\s*(?:back|off)\b|\b(?:settle|clear|close)\s+(?:my\s+|the\s+)?loan\b|\bpay\s+(?:my\s+|the\s+)?loan\b/.test(lower);
    const extend = /\b(?:extend|roll\s*over|rollover|renew)\b/.test(lower);
    const borrowQuestion = /\b(?:how much|what) can i (?:borrow|take)\b|\bcan i borrow\b|\bborrow(?:ing)? limit\b/.test(lower);
    const borrow =
      !borrowQuestion &&
      /\bborrow\b|\bloan\s+me\b|\b(?:need|want|get|take(?:\s+out)?|request|apply\s+for)\s+(?:a\s+|an\s+|another\s+|new\s+)?loan\b/.test(lower);
    const spend = /\b(?:pay|spend|send|transfer|buy|purchase|order|hire)\b/.test(
      lower.replace(/\brepay\b|\bpay\s*(?:back|off)\b|\bpay\s+(?:my\s+|the\s+)?loan\b/g, " ")
    );
    if ([repay, extend, borrow, spend].filter(Boolean).length > 1) return out({ type: "MULTIPLE" });

    if (spend && (lower.includes("@") || /\b(?:friend|someone|somebody|person|people|user|family|my\s+(?:brother|sister|mom|mother|dad|father|wife|husband|son|daughter))\b/.test(lower))) {
      return out({ type: "INFO", info: "NO_USER_TRANSFER" });
    }

    // Questions
    if (/\b(?:history|transactions?|activity|statement)\b|\bwhat did i (?:spend|buy|pay)\b|\bspent\b/.test(lower)) {
      return out({ type: "READ_STATUS", target: "TRANSACTIONS" });
    }
    if (!repay && !extend && !borrow &&
      /\bloans?\b.*\b(?:status|due)\b|\b(?:my|active|open|list|show|all)\s+loans?\b|\bwhen\b.*\bdue\b|\bhow much do i owe\b|\bdo i owe\b/.test(lower)) {
      return out({ type: "READ_STATUS", target: "LOANS" });
    }
    if (borrowQuestion || /\bbalance\b|\bstatus\b|\blimit\b|\bhow much\b/.test(lower) || (/\bcredit\b/.test(lower) && !spend && !repay && !extend && !borrow)) {
      return out({ type: "READ_STATUS", target: "BALANCE" });
    }

    // Loan actions: a loan number only counts after "loan", "#" or "id", or alone after repay/extend
    if (repay || extend) {
      const type = repay ? "REPAY_LOAN" : "EXTEND_LOAN";
      const tagged = new Set([...lower.matchAll(/(?:\bloan\s*(?:#|no\.?|number|id)?\s*|#\s*|\bid\s*)(\d+)\b/g)].map((m) => m[1]));
      const bare = lower.match(/^(?:repay|extend)\s+#?(\d+)\s*$/)?.[1];
      if (bare) tagged.add(bare);
      const others = amountsIn(lower).filter((a) => !tagged.has(a));
      if (tagged.size > 1 || (tagged.size === 1 && others.length > 0)) return out({ type: "MULTIPLE" });
      return out({ type, target: "LOANS", loanId: tagged.size === 1 ? [...tagged][0] ?? null : null });
    }

    if (borrow) {
      const amounts = amountsIn(lower);
      return out({ type: "REQUEST_LOAN", target: "LOANS", amount: amounts.length === 1 ? amounts[0] ?? null : null });
    }

    // What can be bought
    if (/\b(?:service|services|catalog|offering|offer)\b|\bwhat can i (?:buy|purchase)\b|\bwhat does\b|\bhow (?:to|do i) spend\b|\bwhere can i spend\b|\bwho can i pay\b|\b(?:list|show|which|approved)\s+merchants\b/.test(lower) ||
      lower === "spend credit" || lower === "spend") {
      const about = lower.match(/\b(?:from|at|by|of|for|with|does)\s+([a-z0-9_\- ]+)/)?.[1] ?? "";
      const merchantQuery = /\bspend|\bpay|\bbuy/.test(lower) && !/\bwhat does\b/.test(lower) && !/\bfrom\b|\bat\b|\bwith\b/.test(lower)
        ? ""
        : about.replace(/\b(?:offer|offers|services?|credit|usdc|sell|sells|have|has)\b/g, "").replace(/\s+/g, " ").trim();
      if (!spend || !amountsIn(lower).length) return out({ type: "SPEND_CREDIT", target: "SERVICES", merchantQuery });
    }

    if (spend) {
      const amounts = amountsIn(lower);
      const amount = amounts.length === 1 ? amounts[0] ?? null : null;
      let merchantQuery = "";
      let serviceQuery = "";
      const words = (t = "") => t.replace(/\b(?:credit|usdc|dollars|merchant)\b|\$/g, "").replace(/\s+/g, " ").trim();
      const clean = (t = "") => words(t.replace(/-?\d[\d,.]*/g, ""));
      const buyFrom = lower.match(/\b(?:buy|purchase|order|hire|pay for)\s+([a-z0-9_\- ]+?)\s+(?:from|at|by|with)\s+([a-z0-9_\- ]+)/);
      if (buyFrom) {
        serviceQuery = words(buyFrom[1]);
        merchantQuery = clean(buyFrom[2]);
      } else {
        const to = lower.match(/\b(?:from|at|by|with|to)\s+([a-z0-9_\- ]+)/)?.[1];
        if (to) {
          const [m, service] = to.split(/\s+for\s+/);
          merchantQuery = clean(m);
          serviceQuery = service ? words(service) : "";
        }
        const bought = lower.match(/\b(?:buy|purchase|order|hire|pay for)\s+([a-z0-9_\- ]+?)\s*$/)?.[1];
        if (bought && !serviceQuery) serviceQuery = words(bought);
        if (!merchantQuery) {
          const direct = lower.match(/\b(?:pay|send|transfer)\s+([a-z][a-z0-9_\- ]*?)\s+-?\$?\d/);
          if (direct) merchantQuery = clean(direct[1]);
          else if (!bought) merchantQuery = clean(lower.match(/\b(?:pay|send|transfer|spend)\s+([a-z][a-z0-9_\- ]*)$/)?.[1] ?? "");
        }
      }
      // A wallet address names the merchant exactly
      merchantQuery = lower.match(/0x[a-f0-9]{40}/)?.[0] ?? merchantQuery;
      return out({
        type: "SPEND_CREDIT",
        target: !amount && !merchantQuery && !serviceQuery ? "SERVICES" : "ALL",
        amount,
        merchantQuery,
        serviceQuery,
      });
    }

    return out({ type: "UNKNOWN" });
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

type InfoTopic = "HELP" | "NO_INTEREST" | "NO_CASHOUT" | "NO_USER_TRANSFER";

const INFO_TEXT: Record<InfoTopic, string> = {
  HELP:
    'Supported commands:\n• "What is my balance?"\n• "Show my loans"\n• "Show my transactions"\n• "What services can I buy?"\n• "Pay [merchant] [amount]"\n• "Buy [service] from [merchant]"\n• "Borrow [amount] USDC"\n• "Repay loan #[number]"\n• "Extend loan #[number]"\nTo add an asset, type "mint" and follow the upload card.',
  NO_INTEREST:
    "Indico charges no interest and no fees. You repay exactly what you borrowed, and payments to merchants have no fee. The only cost is the small network fee your wallet shows before you sign.",
  NO_CASHOUT:
    "Credit cannot be sold, withdrawn or converted to money in the app. You can spend it with approved merchants, or borrow USDC against it (up to 80%).",
  NO_USER_TRANSFER:
    'Credit can only be spent with approved merchants. It cannot be sent to another person. Ask "What services can I buy?" to see the merchants.',
};

const HISTORY_LABELS: Record<string, string> = {
  CreditMinted: "Credit added",
  CreditBurned: "Credit removed",
  Spent: "Paid a merchant",
  LoanOpened: "Borrowed",
  LoanRepaid: "Repaid a loan",
  LoanExtended: "Extended a loan",
  LoanDefaulted: "Loan defaulted",
  AssetRegistered: "Asset registered",
};

/**
 * Every amount in a message, in base form ("1,500.50" → "1500.50", "-50" kept negative), leaving out
 * durations ("90 days") and numbers that are part of a word or an address.
 */
function amountsIn(text: string): string[] {
  return [...text.matchAll(/(?<![\w.,])(-\s*)?\$?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\w.,])(?!\s*(?:days?|months?|weeks?|years?|%))/g)].map(
    (m) => `${m[1] ? "-" : ""}${(m[2] ?? "").replace(/,/g, "")}`
  );
}

/** Starter questions offered with the help reply and when a message is not understood. */
const STARTERS = ["What is my balance?", "Show my loans", "What services can I buy?", "Show my transactions"].map((prompt) => ({
  label: prompt,
  prompt,
}));

/** "9.500000" → "9.50", "1.234500" → "1.2345": amounts for button labels. */
function short(units: bigint): string {
  return formatAmount(units).replace(/(\.\d{2}\d*?)0+$/, "$1");
}

/** Inside the 30-day extension window, or past the due date (a late extension may still be allowed, D-58). */
function extensionOpen(loan: { dueDate: bigint | number }): boolean {
  return Date.now() / 1000 >= Number(loan.dueDate) - 30 * 86400;
}

function repaySuggestion(loan: { loanId: bigint | number; principalUnits: string }) {
  return { label: `Repay loan #${loan.loanId} (${short(BigInt(loan.principalUnits))} USDC)`, prompt: `Repay loan #${loan.loanId}` };
}

function extendSuggestion(loan: { loanId: bigint | number }) {
  return { label: `Extend loan #${loan.loanId}`, prompt: `Extend loan #${loan.loanId}` };
}
