import {
  createPublicClient,
  http,
  parseAbi,
  decodeErrorResult,
  formatEther,
  type Hex,
  type Address,
} from "viem";
import { baseSepolia, base } from "viem/chains";
import { env } from "../config/env.js";

// Minimal ABI containing all client-touching external functions and custom errors
export const INDICO_LEDGER_ABI = parseAbi([
  // Functions
  "function signTerms(bytes32 acceptedHash) external",
  "function registerAsset(bytes32 docHash, uint8 assetType, uint256 value) external",
  "function spend(address merchant, uint256 amount) external",
  "function requestLoan(uint256 principal) external returns (uint256 loanId)",
  "function repay(uint256 loanId) external",
  "function extend(uint256 loanId) external",
  "function liquidate(uint256 loanId) external",
  "function deposit(uint256 amount) external",
  "function withdraw(uint256 assets) external",
  "function withdrawAll() external",
  "function setUserApproved(address user, bool approved, bytes32 accountRef) external",
  "function setMerchantApproved(address m, bool approved) external",
  "function setTermsHash(bytes32 newHash) external",
  "function pause() external",
  "function unpause() external",

  // Views
  "function credit(address user) external view returns (uint256)",
  "function lockedCredit(address user) external view returns (uint256)",
  "function available(address user) external view returns (uint256)",
  "function maxBorrow(address user) external view returns (uint256)",
  "function collateralFor(uint256 principal) external pure returns (uint256)",
  "function poolUsdc() external view returns (uint256)",
  "function totalLent() external view returns (uint256)",
  "function termsHash() external view returns (bytes32)",
  "function termsSigned(address user) external view returns (bool)",
  "function approvedUser(address user) external view returns (bool)",
  "function approvedMerchant(address merchant) external view returns (bool)",
  "function assetRegistered(bytes32 docHash) external view returns (bool)",
  "function poolAvailable() external view returns (uint256)",
  "function nextLoanId() external view returns (uint256)",
  "function loans(uint256 loanId) external view returns (address borrower, uint64 dueDate, uint16 extensionCount, uint8 status, uint128 principal, uint128 collateral)",

  // Custom Errors
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error ZeroTermsHash()",
  "error ZeroAccountRef()",
  "error ZeroDocHash()",
  "error TermsNotSet()",
  "error WrongTermsHash()",
  "error AlreadySigned()",
  "error TermsNotSigned()",
  "error MerchantTermsNotSigned(address merchant)",
  "error NotApprovedUser()",
  "error NotApprovedMerchant()",
  "error InvalidParticipant(address account)",
  "error ParticipantRoleConflict(address account)",
  "error WalletAlreadyLinked(address wallet, bytes32 accountRef)",
  "error AccountAlreadyLinked(bytes32 accountRef, address wallet)",
  "error AccountRefMismatch(address wallet, bytes32 accountRef)",
  "error AccountHasLockedCredit(address wallet, uint256 locked)",
  "error WalletNotFresh(address wallet)",
  "error NotAUser(address account)",
  "error InvalidAssetType(uint8 assetType)",
  "error AssetAlreadyRegistered()",
  "error InsufficientAvailableCredit(uint256 needed, uint256 available)",
  "error InsufficientLiquidity(uint256 needed, uint256 available)",
  "error LoanNotFound()",
  "error LoanNotActive()",
  "error NotBorrower()",
  "error ExtensionWindowNotOpen(uint64 opensAt)",
  "error ExtensionWindowClosed()",
  "error LiquidationGracePeriod(uint256 graceEndsAt)",
  "error NotYetDue(uint64 dueDate)",
  "error RepaymentShort(uint256 expected, uint256 received)",
  "error CreditCapExceeded(uint256 amount, uint256 room)",
  "error ZeroShares()",
  "error InsufficientShares(uint256 needed, uint256 held)",
  "error EnforcedPause()",
  "error ExpectedPause()",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
]);

const chain = env.CHAIN_ID === 8453 ? base : baseSepolia;

export const publicClient = createPublicClient({
  chain,
  transport: http(env.RPC_URL),
});

export interface PreparedTransaction {
  to: Address;
  data: Hex;
  value: string;
  estimatedGas: string;
  estimatedFeeEth: string;
  userEthBalance: string;
  gasShortfallEth: string | null;
}

/**
 * Simulates an on-chain transaction via `eth_call`, estimates gas,
 * and checks the user's ETH balance for network fees (PRD §4.1 U-11).
 */
export async function prepareTransaction(params: {
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
}): Promise<PreparedTransaction> {
  const { from, to, data, value = 0n } = params;

  // 1. Simulate call to catch any on-chain reverts before wallet prompt
  try {
    await publicClient.call({
      account: from,
      to,
      data,
      value,
    });
  } catch (err: any) {
    // Attempt to decode custom error from revert data
    let decodedReason = "Transaction would revert on-chain";
    if (err.data) {
      try {
        const decoded = decodeErrorResult({
          abi: INDICO_LEDGER_ABI,
          data: err.data,
        });
        decodedReason = `Contract error: ${decoded.errorName}`;
      } catch {
        // Fallback to error message
      }
    }
    throw new Error(decodedReason);
  }

  // 2. Estimate gas and fetch current gas price
  const [estimatedGas, gasPrice, userBalance] = await Promise.all([
    publicClient.estimateGas({
      account: from,
      to,
      data,
      value,
    }).catch(() => 200_000n), // safe fallback gas limit
    publicClient.getGasPrice(),
    publicClient.getBalance({ address: from }),
  ]);

  // Buffer gas estimate by 20%
  const gasLimit = (estimatedGas * 120n) / 100n;
  const totalCostWei = gasLimit * gasPrice + value;

  const shortfallWei = userBalance < totalCostWei ? totalCostWei - userBalance : 0n;

  return {
    to,
    data,
    value: value.toString(),
    estimatedGas: gasLimit.toString(),
    estimatedFeeEth: formatEther(gasLimit * gasPrice),
    userEthBalance: formatEther(userBalance),
    gasShortfallEth: shortfallWei > 0n ? formatEther(shortfallWei) : null,
  };
}

export interface GasShortfallResult {
  estimatedGasUnits: string;
  gasCostEth: string;
  gasCostUsd: string;
  userEthBalance: string;
  ethShortfall: string;
  ethShortfallUnits: string;
  canAfford: boolean;
}

/**
 * Simulates transaction execution via eth_call to detect reverts before broadcasting.
 */
export async function simulatePreparedTransaction(params: {
  to: Address;
  data: Hex;
  from?: Address;
  value?: bigint;
}): Promise<void> {
  const { to, data, from, value = 0n } = params;
  try {
    await publicClient.call({
      account: from,
      to,
      data,
      value,
    });
  } catch (err: any) {
    let decodedReason = "Transaction would revert on-chain";
    if (err.data) {
      try {
        const decoded = decodeErrorResult({
          abi: INDICO_LEDGER_ABI,
          data: err.data,
        });
        decodedReason = `Contract error: ${decoded.errorName}`;
      } catch {
        // Fallback
      }
    }
    throw new Error(decodedReason);
  }
}

/**
 * Calculates gas fees and checks whether the user has sufficient Base ETH balance.
 */
export async function calculateGasShortfall(
  from: Address,
  tx: { to: Address; data: Hex; value?: bigint }
): Promise<GasShortfallResult> {
  const { to, data, value = 0n } = tx;
  const [estimatedGas, gasPrice, userBalance] = await Promise.all([
    publicClient
      .estimateGas({
        account: from,
        to,
        data,
        value,
      })
      .catch(() => 100_000n),
    publicClient.getGasPrice().catch(() => 1_000_000_000n),
    publicClient.getBalance({ address: from }).catch(() => 0n),
  ]);

  const gasLimit = (estimatedGas * 120n) / 100n;
  const totalCostWei = gasLimit * gasPrice + value;
  const shortfallWei = userBalance < totalCostWei ? totalCostWei - userBalance : 0n;

  const ethCostFloat = Number(formatEther(totalCostWei));
  const gasCostUsd = (ethCostFloat * 2500).toFixed(4);

  return {
    estimatedGasUnits: gasLimit.toString(),
    gasCostEth: formatEther(totalCostWei),
    gasCostUsd: `$${gasCostUsd}`,
    userEthBalance: formatEther(userBalance),
    ethShortfall: formatEther(shortfallWei),
    ethShortfallUnits: shortfallWei.toString(),
    canAfford: shortfallWei === 0n,
  };
}

