import { formatEther, type Address } from "viem";
import { prisma } from "../../lib/prisma.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from "../../lib/errors.js";
import { verifyPassword, hashPassword, verifyWalletSignature } from "../../lib/crypto.js";
import { publicClient, INDICO_LEDGER_ABI } from "../../lib/viem.js";
import { env } from "../../config/env.js";

export class ProfileService {
  /**
   * Fetches user profile and connected wallet details (PRD §4.1 U-09).
   */
  static async getProfile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { walletBinding: true },
    });

    if (!user) {
      throw new NotFoundError("User not found");
    }

    return {
      id: user.id,
      email: user.email,
      isEmailVerified: user.isEmailVerified,
      isApproved: user.isApproved,
      walletAddress: user.walletBinding ? user.walletBinding.walletAddress : null,
      accountRef: user.walletBinding ? user.walletBinding.accountRef : null,
      createdAt: user.createdAt.toISOString(),
    };
  }

  /**
   * Fetches wallet connection status, Base ETH balance, and on-chain contract state (PRD §4.1 U-10).
   */
  static async getWalletStatus(userId: string) {
    const binding = await prisma.walletBinding.findUnique({
      where: { userId },
    });

    if (!binding) {
      return {
        isBound: false,
        walletAddress: null,
        accountRef: null,
        boundAt: null,
        isTermsSignedOnChain: false,
        isUserApprovedOnChain: false,
      };
    }

    const wallet = binding.walletAddress as Address;

    // Concurrently fetch Base ETH balance and contract state from IndicoLedger
    const [balanceWei, isTermsSigned, isApprovedUser] = await Promise.all([
      publicClient.getBalance({ address: wallet }).catch(() => 0n),
      publicClient
        .readContract({
          address: env.INDICO_LEDGER_ADDRESS as Address,
          abi: INDICO_LEDGER_ABI,
          functionName: "termsSigned",
          args: [wallet],
        })
        .catch(() => false),
      publicClient
        .readContract({
          address: env.INDICO_LEDGER_ADDRESS as Address,
          abi: INDICO_LEDGER_ABI,
          functionName: "approvedUser",
          args: [wallet],
        })
        .catch(() => false),
    ]);

    return {
      isBound: true,
      walletAddress: binding.walletAddress,
      accountRef: binding.accountRef,
      boundAt: binding.boundAt.toISOString(),
      ethBalance: formatEther(balanceWei),
      isTermsSignedOnChain: Boolean(isTermsSigned),
      isUserApprovedOnChain: Boolean(isApprovedUser),
    };
  }

  /**
   * Binds an external wallet to an account using a cryptographic signature proof (PRD §4.1 U-04, U-05).
   * One wallet per account; changing it requires admin action.
   */
  static async bindWallet(
    userId: string,
    walletAddress: string,
    accountRef: string,
    signature: `0x${string}`,
    message: string
  ) {
    // 1. Verify EIP-191 signature proving ownership of walletAddress
    const isValidSignature = await verifyWalletSignature(
      walletAddress as `0x${string}`,
      message,
      signature
    );

    if (!isValidSignature) {
      throw new BadRequestError(
        "Cryptographic signature verification failed for this wallet address"
      );
    }

    // 2. Check U-05 constraint: One wallet per account
    const existingUserBinding = await prisma.walletBinding.findUnique({
      where: { userId },
    });

    if (existingUserBinding) {
      throw new ConflictError(
        "A wallet is already bound to your account. Changing wallet requires admin action (PRD §4.1 U-05)."
      );
    }

    // 3. Check uniqueness of wallet address across all users
    const existingWallet = await prisma.walletBinding.findUnique({
      where: { walletAddress },
    });

    if (existingWallet) {
      throw new ConflictError(
        "This wallet address is already linked to another account."
      );
    }

    // 4. Check uniqueness of account reference
    const existingRef = await prisma.walletBinding.findUnique({
      where: { accountRef },
    });

    if (existingRef) {
      throw new ConflictError(
        "This account reference is already registered."
      );
    }

    const binding = await prisma.walletBinding.create({
      data: {
        userId,
        walletAddress,
        accountRef,
      },
    });

    return {
      message: "Wallet successfully verified and bound to account",
      walletAddress: binding.walletAddress,
      accountRef: binding.accountRef,
      boundAt: binding.boundAt.toISOString(),
    };
  }

  /**
   * Updates user credentials/password (PRD §4.1 U-09).
   */
  static async updateProfile(
    userId: string,
    currentPassword: string,
    newPassword: string
  ) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundError("User not found");
    }

    const isValid = await verifyPassword(currentPassword, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedError("Incorrect current password");
    }

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash },
    });

    return {
      message: "Profile password updated successfully",
    };
  }
}

