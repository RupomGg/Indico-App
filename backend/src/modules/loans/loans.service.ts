import {
  encodeFunctionData,
  type Address,
} from "viem";
import { prisma } from "../../lib/prisma.js";
import {
  publicClient,
  INDICO_LEDGER_ABI,
  ERC20_ABI,
  simulatePreparedTransaction,
  calculateGasShortfall,
} from "../../lib/viem.js";
import { env } from "../../config/env.js";
import { parseAmount, formatAmount } from "../../lib/amount.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../lib/errors.js";
import type {
  PrepareBorrowInput,
  PrepareBorrowResponse,
  PrepareRepayInput,
  PrepareRepayResponse,
  PrepareExtendInput,
  PrepareExtendResponse,
} from "./loans.schemas.js";

const EXTENSION_WINDOW = 30n * 86400n; // 30 days in seconds (D-13)
const TERM = 90n * 86400n; // 90 days in seconds

export class LoansService {
  /**
   * Prepares calldata and pre-flight simulation for requesting a loan (PRD §4.4 L-01 to L-10).
   * Over-collateralised borrowing: requires posting 125% collateral in credit (80% LTV).
   */
  static async prepareBorrowCalldata(
    userId: string,
    input: PrepareBorrowInput
  ): Promise<PrepareBorrowResponse> {
    const principalUnits = parseAmount(input.amount);
    if (principalUnits <= 0n) {
      throw new BadRequestError("Borrow principal must be greater than zero (ZeroAmount).");
    }

    const binding = await prisma.walletBinding.findUnique({
      where: { userId },
    });

    if (!binding) {
      throw new BadRequestError(
        "User has not bound a wallet yet. Please connect and bind a wallet first (U-04)."
      );
    }

    const walletAddress = binding.walletAddress as Address;

    // Check on-chain participant approvals and terms
    const [isApproved, hasSignedTerms, availableCredit, poolCash] = await Promise.all([
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
        functionName: "available",
        args: [walletAddress],
      }),
      publicClient.readContract({
        address: env.INDICO_LEDGER_ADDRESS as Address,
        abi: INDICO_LEDGER_ABI,
        functionName: "poolAvailable",
      }),
    ]);

    if (!isApproved) {
      throw new ForbiddenError(
        "User wallet is not approved on-chain. Contact administrator for approval (U-02)."
      );
    }

    if (!hasSignedTerms) {
      throw new BadRequestError(
        "Platform terms have not been signed by this wallet on-chain. Please sign terms first (U-08)."
      );
    }

    // Collateral calculation: ceilDiv(principal * 10_000, 8_000) = principal * 1.25 rounded up
    const requiredCollateralUnits = (principalUnits * 10000n - 1n) / 8000n + 1n;

    if (requiredCollateralUnits > availableCredit) {
      throw new BadRequestError(
        `Insufficient available credit: required collateral (${formatAmount(
          requiredCollateralUnits
        )}) exceeds your available credit (${formatAmount(availableCredit)}).`
      );
    }

    if (principalUnits > poolCash) {
      throw new BadRequestError(
        `Insufficient pool liquidity: requested loan (${formatAmount(
          principalUnits
        )} USDC) exceeds available pool liquidity (${formatAmount(poolCash)} USDC).`
      );
    }

    const data = encodeFunctionData({
      abi: INDICO_LEDGER_ABI,
      functionName: "requestLoan",
      args: [principalUnits],
    });

    // Pre-flight simulation to detect contract reverts
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
      principal: formatAmount(principalUnits),
      principalUnits: principalUnits.toString(),
      requiredCollateral: formatAmount(requiredCollateralUnits),
      requiredCollateralUnits: requiredCollateralUnits.toString(),
      estimatedGasUnits: gasShortfall.estimatedGasUnits,
      gasCostEth: gasShortfall.gasCostEth,
      gasCostUsd: gasShortfall.gasCostUsd,
      userEthBalance: gasShortfall.userEthBalance,
      ethShortfall: gasShortfall.ethShortfall,
      ethShortfallUnits: gasShortfall.ethShortfallUnits,
      canAfford: gasShortfall.canAfford,
    };
  }

  /**
   * Prepares calldata for loan repayment (PRD §4.5 R-01 to R-03).
   * Checks USDC balance and allowance, preparing a 2-step approval sequence if allowance < principal.
   */
  static async prepareRepayCalldata(
    userId: string,
    input: PrepareRepayInput
  ): Promise<PrepareRepayResponse> {
    const loanId = BigInt(input.loanId);
    if (loanId <= 0n) {
      throw new NotFoundError("Loan not found (loanId must be > 0)");
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

    // Fetch loan state on-chain
    let loanData: readonly [Address, bigint, number, number, bigint, bigint];
    try {
      loanData = await publicClient.readContract({
        address: env.INDICO_LEDGER_ADDRESS as Address,
        abi: INDICO_LEDGER_ABI,
        functionName: "loans",
        args: [loanId],
      });
    } catch {
      throw new NotFoundError(`Loan #${loanId} not found on ledger`);
    }

    const [borrower, dueDate, _extensionCount, status, principal, collateral] = loanData;

    if (!borrower || borrower === "0x0000000000000000000000000000000000000000") {
      throw new NotFoundError(`Loan #${loanId} not found on ledger`);
    }

    if (status !== 0) {
      const statusName = status === 1 ? "Repaid" : "Defaulted";
      throw new BadRequestError(`Loan #${loanId} is not active (status: ${statusName})`);
    }

    if (borrower.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new ForbiddenError("You are not the borrower for this loan (NotBorrower)");
    }

    // Check USDC balance and allowance
    const [usdcBalance, usdcAllowance] = await Promise.all([
      publicClient.readContract({
        address: env.USDC_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [walletAddress],
      }),
      publicClient.readContract({
        address: env.USDC_ADDRESS as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [walletAddress, env.INDICO_LEDGER_ADDRESS as Address],
      }),
    ]);

    if (usdcBalance < principal) {
      throw new BadRequestError(
        `Insufficient USDC balance to repay loan: balance (${formatAmount(
          usdcBalance
        )}) < principal (${formatAmount(principal)})`
      );
    }

    const repayData = encodeFunctionData({
      abi: INDICO_LEDGER_ABI,
      functionName: "repay",
      args: [loanId],
    });

    const requiresApproval = usdcAllowance < principal;

    let approvalTx = null;
    let repayGasShortfall;

    if (requiresApproval) {
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [env.INDICO_LEDGER_ADDRESS as Address, principal],
      });

      const approveGasShortfall = await calculateGasShortfall(walletAddress, {
        to: env.USDC_ADDRESS as Address,
        data: approveData,
      });

      approvalTx = {
        to: env.USDC_ADDRESS,
        data: approveData,
        value: "0",
        estimatedGasUnits: approveGasShortfall.estimatedGasUnits,
        gasCostEth: approveGasShortfall.gasCostEth,
        gasCostUsd: approveGasShortfall.gasCostUsd,
        canAfford: approveGasShortfall.canAfford,
      };

      repayGasShortfall = await calculateGasShortfall(walletAddress, {
        to: env.INDICO_LEDGER_ADDRESS as Address,
        data: repayData,
      });
    } else {
      // Simulate directly when allowance is sufficient
      await simulatePreparedTransaction({
        to: env.INDICO_LEDGER_ADDRESS as Address,
        data: repayData,
        from: walletAddress,
      });

      repayGasShortfall = await calculateGasShortfall(walletAddress, {
        to: env.INDICO_LEDGER_ADDRESS as Address,
        data: repayData,
      });
    }

    const repayTx = {
      to: env.INDICO_LEDGER_ADDRESS,
      data: repayData,
      value: "0",
      estimatedGasUnits: repayGasShortfall.estimatedGasUnits,
      gasCostEth: repayGasShortfall.gasCostEth,
      gasCostUsd: repayGasShortfall.gasCostUsd,
      canAfford: repayGasShortfall.canAfford,
    };

    const overallCanAfford = approvalTx
      ? approvalTx.canAfford && repayTx.canAfford
      : repayTx.canAfford;

    return {
      loanId: loanId.toString(),
      principal: formatAmount(principal),
      principalUnits: principal.toString(),
      collateral: formatAmount(collateral),
      collateralUnits: collateral.toString(),
      dueDate: Number(dueDate),
      requiresApproval,
      approvalTx,
      repayTx,
      userEthBalance: repayGasShortfall.userEthBalance,
      ethShortfall: repayGasShortfall.ethShortfall,
      canAfford: overallCanAfford,
    };
  }

  /**
   * Prepares calldata for extending a loan by 90 days (PRD §4.5 R-05, R-06).
   * Verifies borrower approval and the 30-day extension window (dueDate - 30 days <= now <= dueDate).
   */
  static async prepareExtendCalldata(
    userId: string,
    input: PrepareExtendInput
  ): Promise<PrepareExtendResponse> {
    const loanId = BigInt(input.loanId);
    if (loanId <= 0n) {
      throw new NotFoundError("Loan not found (loanId must be > 0)");
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

    let loanData: readonly [Address, bigint, number, number, bigint, bigint];
    try {
      loanData = await publicClient.readContract({
        address: env.INDICO_LEDGER_ADDRESS as Address,
        abi: INDICO_LEDGER_ABI,
        functionName: "loans",
        args: [loanId],
      });
    } catch {
      throw new NotFoundError(`Loan #${loanId} not found on ledger`);
    }

    const [borrower, dueDate, extensionCount, status] = loanData;

    if (!borrower || borrower === "0x0000000000000000000000000000000000000000") {
      throw new NotFoundError(`Loan #${loanId} not found on ledger`);
    }

    if (status !== 0) {
      const statusName = status === 1 ? "Repaid" : "Defaulted";
      throw new BadRequestError(`Loan #${loanId} is not active (status: ${statusName})`);
    }

    if (borrower.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new ForbiddenError("You are not the borrower for this loan (NotBorrower)");
    }

    // Revoked borrower cannot extend (D-50)
    const isApproved = await publicClient.readContract({
      address: env.INDICO_LEDGER_ADDRESS as Address,
      abi: INDICO_LEDGER_ABI,
      functionName: "approvedUser",
      args: [walletAddress],
    });

    if (!isApproved) {
      throw new ForbiddenError("Borrower is revoked and cannot extend loan (D-50)");
    }

    // Check extension window (dueDate - 30 days <= now <= dueDate)
    const block = await publicClient.getBlock();
    const now = block.timestamp;

    const opensAt = dueDate - EXTENSION_WINDOW;

    if (now < opensAt) {
      throw new BadRequestError(
        `Loan extension window is not open yet. It opens 30 days before due date (at timestamp ${opensAt}).`
      );
    }

    if (now > dueDate) {
      throw new BadRequestError(
        `Loan extension window has closed because the due date (${dueDate}) has passed.`
      );
    }

    const data = encodeFunctionData({
      abi: INDICO_LEDGER_ABI,
      functionName: "extend",
      args: [loanId],
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

    const newDueDate = dueDate + TERM;

    return {
      loanId: loanId.toString(),
      dueDate: Number(dueDate),
      newDueDate: Number(newDueDate),
      extensionCount: extensionCount + 1,
      to: env.INDICO_LEDGER_ADDRESS,
      data,
      value: "0",
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
