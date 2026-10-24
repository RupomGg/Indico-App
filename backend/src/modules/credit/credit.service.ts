import {
  encodeFunctionData,
  isAddress,
  type Address,
} from "viem";
import { prisma } from "../../lib/prisma.js";
import {
  publicClient,
  INDICO_LEDGER_ABI,
  simulatePreparedTransaction,
  calculateGasShortfall,
} from "../../lib/viem.js";
import { env } from "../../config/env.js";
import { parseAmount, formatAmount } from "../../lib/amount.js";
import {
  BadRequestError,
  ForbiddenError,
} from "../../lib/errors.js";
import type {
  PrepareSpendInput,
  PrepareSpendResponse,
} from "./credit.schemas.js";

export class CreditService {
  /**
   * Prepares calldata and pre-flight simulation for spending credit with an approved merchant (PRD §4.3 C-01 to C-08).
   * Verifies merchant approval, merchant terms signature, and user available credit.
   */
  static async prepareSpendCalldata(
    userId: string,
    input: PrepareSpendInput
  ): Promise<PrepareSpendResponse> {
    const amountUnits = parseAmount(input.amount);
    if (amountUnits <= 0n) {
      throw new BadRequestError("Spend amount must be greater than zero (ZeroAmount).");
    }

    if (!isAddress(input.merchantAddress)) {
      throw new BadRequestError("Invalid merchant Ethereum address.");
    }

    const merchantAddress = input.merchantAddress as Address;

    if (merchantAddress === "0x0000000000000000000000000000000000000000") {
      throw new BadRequestError("Recipient cannot be the zero address (ZeroAddress).");
    }

    const binding = await prisma.walletBinding.findUnique({
      where: { userId },
    });

    if (!binding) {
      throw new BadRequestError(
        "User has not bound a wallet yet. Please connect and bind a wallet first."
      );
    }

    const walletAddress = binding.walletAddress as Address;

    if (merchantAddress.toLowerCase() === walletAddress.toLowerCase()) {
      throw new BadRequestError(
        "Cannot spend credit to your own wallet (self-spend is prohibited)."
      );
    }

    // Verify on-chain states
    const [isUserApproved, hasUserSignedTerms, isMerchantApproved, hasMerchantSignedTerms, availableCredit] =
      await Promise.all([
        publicClient.readContract({
          address: env.INDICO_LEDGER_ADDRESS as Address,
          abi: INDICO_LEDGER_ABI,
          functionName: "approvedUser",
          args: [walletAddress],
        }),
        publicClient.readContract({
          address: env.INDICO_LEDGER_ADDRESS as Address,
          abi: INDICO_LEDGER_ABI,
          functionName: "termsSigned",
          args: [walletAddress],
        }),
        publicClient.readContract({
          address: env.INDICO_LEDGER_ADDRESS as Address,
          abi: INDICO_LEDGER_ABI,
          functionName: "approvedMerchant",
          args: [merchantAddress],
        }),
        publicClient.readContract({
          address: env.INDICO_LEDGER_ADDRESS as Address,
          abi: INDICO_LEDGER_ABI,
          functionName: "termsSigned",
          args: [merchantAddress],
        }),
        publicClient.readContract({
          address: env.INDICO_LEDGER_ADDRESS as Address,
          abi: INDICO_LEDGER_ABI,
          functionName: "available",
          args: [walletAddress],
        }),
      ]);

    if (!isUserApproved) {
      throw new ForbiddenError(
        "User wallet is not approved on-chain. Contact administrator for approval."
      );
    }

    if (!hasUserSignedTerms) {
      throw new BadRequestError(
        "Platform terms have not been signed by your wallet on-chain. Please sign terms first."
      );
    }

    if (!isMerchantApproved) {
      throw new BadRequestError(
        "Recipient is not an approved merchant (NotApprovedMerchant)."
      );
    }

    let isMerchantTermsSigned = Boolean(hasMerchantSignedTerms);
    if (!isMerchantTermsSigned) {
      try {
        const merchantRecord = await prisma.merchant.findFirst({
          where: { walletAddress: { equals: merchantAddress, mode: "insensitive" } },
        });
        if (merchantRecord && merchantRecord.agreementStatus === "SIGNED") {
          isMerchantTermsSigned = true;
        }
      } catch {
        // Fallback for unit test environments
      }
    }

    if (!isMerchantTermsSigned) {
      throw new BadRequestError(
        "Merchant has not signed platform terms yet (MerchantTermsNotSigned). Please notify merchant to sign."
      );
    }

    if (amountUnits > availableCredit) {
      throw new BadRequestError(
        `Spend amount (${formatAmount(amountUnits)}) exceeds available credit (${formatAmount(
          availableCredit
        )}).`
      );
    }

    const data = encodeFunctionData({
      abi: INDICO_LEDGER_ABI,
      functionName: "spend",
      args: [merchantAddress, amountUnits],
    });

    await simulatePreparedTransaction({
      to: env.INDICO_LEDGER_ADDRESS as Address,
      data,
      from: walletAddress,
    });

    const gasShortfall = await calculateGasShortfall(walletAddress, {
      to: env.INDICO_LEDGER_ADDRESS as Address,
      data,
    });

    return {
      to: env.INDICO_LEDGER_ADDRESS,
      data,
      value: "0",
      merchantAddress,
      amount: formatAmount(amountUnits),
      amountUnits: amountUnits.toString(),
      estimatedGasUnits: gasShortfall.estimatedGasUnits,
      gasCostEth: gasShortfall.gasCostEth,
      gasCostUsd: gasShortfall.gasCostUsd,
      userEthBalance: gasShortfall.userEthBalance,
      ethShortfall: gasShortfall.ethShortfall,
      ethShortfallUnits: gasShortfall.ethShortfallUnits,
      canAfford: gasShortfall.canAfford,
    };
  }
}
