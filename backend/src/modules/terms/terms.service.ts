import { encodeFunctionData, type Hex, type Address } from "viem";
import { prisma } from "../../lib/prisma.js";
import {
  publicClient,
  INDICO_LEDGER_ABI,
  simulatePreparedTransaction,
  calculateGasShortfall,
} from "../../lib/viem.js";
import { env } from "../../config/env.js";
import {
  BadRequestError,
  ConflictError,
} from "../../lib/errors.js";
import type {
  CurrentTermsResponse,
  TermsStatusResponse,
  PrepareSignTermsResponse,
} from "./terms.schemas.js";

const DEFAULT_TERMS_TEXT = `
# INDICO ASSET LEDGER PARTICIPANT TERMS AND CONDITIONS
Version: 1.0.0
Effective Date: 2026-09-29

1. ACKNOWLEDGEMENT OF BLOCKCHAIN LEDGER
By signing this document with an authorized cryptographic wallet, the participant acknowledges and agrees that all asset registrations, credit issuances, spends, borrowings, extensions, and liquidations are permanently recorded on the Base blockchain.

2. OVER-COLLATERALISED BORROWING RULES
Borrowing USDC against asset-backed credit requires posting 125% collateral in credit (80% loan-to-value ratio). Collateral is locked until the loan principal is repaid in full.

3. LOAN EXTENSIONS AND ROLL-OVER WINDOW
A loan may only be extended during the 30-day window prior to its due date (dueDate - 30 days <= block.timestamp <= dueDate). Each extension pushes the due date out by 90 days.

4. DEFAULT AND LIQUIDATION
Loans that pass their due date without repayment or valid extension are subject to immediate liquidation.

5. ARBITRATION AND GOVERNING LAW
Any dispute arising from or in connection with this platform shall be settled under the arbitration framework specified in the Indico platform rules.
`.trim();

const DEFAULT_TERMS_HASH = "0x5b39922883ef59c037996c5e88863fc9f12d8a554a71879ec8217bb48ca4c820" as Hex;

export class TermsService {
  /**
   * Fetches the current platform terms text and on-chain termsHash (PRD §4.1 U-06).
   */
  static async getCurrentTerms(): Promise<CurrentTermsResponse> {
    let onChainHash: Hex = DEFAULT_TERMS_HASH;
    let isOnChainSet = false;

    try {
      const hash = await publicClient.readContract({
        address: env.INDICO_LEDGER_ADDRESS as Address,
        abi: INDICO_LEDGER_ABI,
        functionName: "termsHash",
      });

      if (hash && hash !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        onChainHash = hash as Hex;
        isOnChainSet = true;
      }
    } catch {
      // Use fallback if RPC read fails or contract is not yet initialized with termsHash
      onChainHash = DEFAULT_TERMS_HASH;
      isOnChainSet = false;
    }

    return {
      version: "1.0.0",
      termsHash: onChainHash,
      title: "Indico Asset Ledger Participant Terms and Conditions",
      content: DEFAULT_TERMS_TEXT,
      effectiveDate: "2026-09-29",
      isOnChainSet,
    };
  }

  /**
   * Checks whether the user's bound wallet has signed the current terms on-chain (PRD §4.1 U-08).
   */
  static async getTermsStatus(userId: string): Promise<TermsStatusResponse> {
    const binding = await prisma.walletBinding.findUnique({
      where: { userId },
    });

    if (!binding) {
      throw new BadRequestError(
        "User has not bound a wallet yet. Please connect and bind a wallet first (U-04)."
      );
    }

    const { termsHash } = await this.getCurrentTerms();

    let termsSigned = false;
    try {
      termsSigned = await publicClient.readContract({
        address: env.INDICO_LEDGER_ADDRESS as Address,
        abi: INDICO_LEDGER_ABI,
        functionName: "termsSigned",
        args: [binding.walletAddress as Address],
      });
    } catch {
      termsSigned = false;
    }

    return {
      hasBoundWallet: true,
      walletAddress: binding.walletAddress,
      termsSigned,
      termsHash,
      signedTermsHash: termsSigned ? termsHash : null,
    };
  }

  /**
   * Prepares calldata and gas shortfall analysis for signing terms on chain (PRD §4.1 U-07, U-11, U-12).
   */
  static async prepareSignTermsCalldata(userId: string): Promise<PrepareSignTermsResponse> {
    const binding = await prisma.walletBinding.findUnique({
      where: { userId },
    });

    if (!binding) {
      throw new BadRequestError(
        "User has not bound a wallet yet. Connect a wallet before signing terms."
      );
    }

    const walletAddress = binding.walletAddress as Address;
    const currentTerms = await this.getCurrentTerms();
    if (currentTerms.isOnChainSet === false) {
      throw new BadRequestError(
        "Platform terms have not been activated on the blockchain yet (termsHash is 0x0). Please activate terms via the Admin Portal before users can sign."
      );
    }
    const { termsHash } = currentTerms;

    // Check on chain if already signed
    let alreadySigned = false;
    try {
      alreadySigned = await publicClient.readContract({
        address: env.INDICO_LEDGER_ADDRESS as Address,
        abi: INDICO_LEDGER_ABI,
        functionName: "termsSigned",
        args: [walletAddress],
      });
    } catch {
      alreadySigned = false;
    }

    if (alreadySigned) {
      throw new ConflictError(
        "Your bound wallet has already signed the current terms version on-chain."
      );
    }

    const data = encodeFunctionData({
      abi: INDICO_LEDGER_ABI,
      functionName: "signTerms",
      args: [termsHash as Hex],
    });

    // Simulate contract call to detect reverts
    await simulatePreparedTransaction({
      to: env.INDICO_LEDGER_ADDRESS as Address,
      data,
      from: walletAddress,
    });

    // Estimate gas and compute shortfall against user's Base ETH balance (U-10, U-11)
    const shortfall = await calculateGasShortfall(walletAddress, {
      to: env.INDICO_LEDGER_ADDRESS as Address,
      data,
    });

    return {
      to: env.INDICO_LEDGER_ADDRESS,
      data,
      value: "0",
      estimatedGasUnits: shortfall.estimatedGasUnits,
      gasCostEth: shortfall.gasCostEth,
      gasCostUsd: shortfall.gasCostUsd,
      userEthBalance: shortfall.userEthBalance,
      ethShortfall: shortfall.ethShortfall,
      ethShortfallUnits: shortfall.ethShortfallUnits,
      canAfford: shortfall.canAfford,
      termsHash,
    };
  }
}
