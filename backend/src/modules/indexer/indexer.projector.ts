import { PrismaClient } from "@prisma/client";
import { DecodedChainLog } from "./indexer.schemas.js";

type PrismaTxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * Pure state projector: applies a single decoded on-chain log to PostgreSQL read models.
 * Executed inside an atomic database transaction.
 */
export async function projectChainLog(
  client: PrismaTxClient,
  log: DecodedChainLog
): Promise<{ processed: boolean; reason?: string }> {
  // 1. Idempotency check: verify if this exact log was already processed
  const existingEvent = await client.chainEvent.findUnique({
    where: {
      txHash_logIndex: {
        txHash: log.txHash,
        logIndex: log.logIndex,
      },
    },
  });

  if (existingEvent) {
    return { processed: false, reason: "Already indexed" };
  }

  const { eventName, blockNumber, args } = log;

  // 2. Project state mutation by event name
  switch (eventName) {
    case "CreditMinted": {
      const user = (args["user"] as string).toLowerCase();
      const amount = BigInt(args["amount"]);
      const existing = await client.creditBalance.findUnique({
        where: { walletAddress: user },
      });
      const currentCredit = existing ? BigInt(existing.creditUnits) : 0n;
      const newCredit = (currentCredit + amount).toString();

      await client.creditBalance.upsert({
        where: { walletAddress: user },
        create: {
          walletAddress: user,
          creditUnits: newCredit,
          lockedCreditUnits: "0",
          lastUpdatedBlock: blockNumber,
        },
        update: {
          creditUnits: newCredit,
          lastUpdatedBlock: blockNumber,
        },
      });
      break;
    }

    case "CreditBurned": {
      const user = (args["user"] as string).toLowerCase();
      const amount = BigInt(args["amount"]);
      const existing = await client.creditBalance.findUnique({
        where: { walletAddress: user },
      });
      const currentCredit = existing ? BigInt(existing.creditUnits) : 0n;
      const newCredit = currentCredit >= amount ? (currentCredit - amount).toString() : "0";

      await client.creditBalance.upsert({
        where: { walletAddress: user },
        create: {
          walletAddress: user,
          creditUnits: "0",
          lockedCreditUnits: "0",
          lastUpdatedBlock: blockNumber,
        },
        update: {
          creditUnits: newCredit,
          lastUpdatedBlock: blockNumber,
        },
      });
      break;
    }

    case "Spent": {
      const user = (args["user"] as string).toLowerCase();
      const merchant = (args["merchant"] as string).toLowerCase();
      const amount = BigInt(args["amount"]);

      // Deduct credit from user
      const existingUser = await client.creditBalance.findUnique({
        where: { walletAddress: user },
      });
      const currentUserCredit = existingUser ? BigInt(existingUser.creditUnits) : 0n;
      const newUserCredit =
        currentUserCredit >= amount ? (currentUserCredit - amount).toString() : "0";

      await client.creditBalance.upsert({
        where: { walletAddress: user },
        create: {
          walletAddress: user,
          creditUnits: "0",
          lockedCreditUnits: "0",
          lastUpdatedBlock: blockNumber,
        },
        update: {
          creditUnits: newUserCredit,
          lastUpdatedBlock: blockNumber,
        },
      });

      // Credit merchant
      const existingMerchant = await client.creditBalance.findUnique({
        where: { walletAddress: merchant },
      });
      const currentMerchantCredit = existingMerchant
        ? BigInt(existingMerchant.creditUnits)
        : 0n;
      const newMerchantCredit = (currentMerchantCredit + amount).toString();

      await client.creditBalance.upsert({
        where: { walletAddress: merchant },
        create: {
          walletAddress: merchant,
          creditUnits: newMerchantCredit,
          lockedCreditUnits: "0",
          lastUpdatedBlock: blockNumber,
        },
        update: {
          creditUnits: newMerchantCredit,
          lastUpdatedBlock: blockNumber,
        },
      });
      break;
    }

    case "LoanOpened": {
      const loanId = BigInt(args["loanId"]);
      const borrower = (args["borrower"] as string).toLowerCase();
      const principal = BigInt(args["principal"]).toString();
      const collateral = BigInt(args["collateral"]).toString();
      const dueDate = BigInt(args["dueDate"]);

      await client.loan.upsert({
        where: { loanId },
        create: {
          loanId,
          borrower,
          principalUnits: principal,
          collateralUnits: collateral,
          dueDate,
          extensionCount: 0,
          status: "ACTIVE",
          openedAtBlock: blockNumber,
        },
        update: {
          borrower,
          principalUnits: principal,
          collateralUnits: collateral,
          dueDate,
          status: "ACTIVE",
        },
      });

      // Increase borrower's locked credit
      const existing = await client.creditBalance.findUnique({
        where: { walletAddress: borrower },
      });
      const currentLocked = existing ? BigInt(existing.lockedCreditUnits) : 0n;
      const newLocked = (currentLocked + BigInt(collateral)).toString();

      await client.creditBalance.upsert({
        where: { walletAddress: borrower },
        create: {
          walletAddress: borrower,
          creditUnits: "0",
          lockedCreditUnits: newLocked,
          lastUpdatedBlock: blockNumber,
        },
        update: {
          lockedCreditUnits: newLocked,
          lastUpdatedBlock: blockNumber,
        },
      });
      break;
    }

    case "LoanExtended": {
      const loanId = BigInt(args["loanId"]);
      const newDueDate = BigInt(args["newDueDate"]);
      const extensionCount = Number(args["extensionCount"] || 1);

      await client.loan.update({
        where: { loanId },
        data: {
          dueDate: newDueDate,
          extensionCount,
        },
      });
      break;
    }

    case "LoanRepaid": {
      const loanId = BigInt(args["loanId"]);
      const borrower = (args["borrower"] as string).toLowerCase();
      const loan = await client.loan.findUnique({ where: { loanId } });
      const collateralToUnlock = loan ? BigInt(loan.collateralUnits) : 0n;

      await client.loan.update({
        where: { loanId },
        data: {
          status: "REPAID",
          repaidAtBlock: blockNumber,
        },
      });

      if (collateralToUnlock > 0n) {
        const existing = await client.creditBalance.findUnique({
          where: { walletAddress: borrower },
        });
        const currentLocked = existing ? BigInt(existing.lockedCreditUnits) : 0n;
        const newLocked =
          currentLocked >= collateralToUnlock
            ? (currentLocked - collateralToUnlock).toString()
            : "0";

        await client.creditBalance.upsert({
          where: { walletAddress: borrower },
          create: {
            walletAddress: borrower,
            creditUnits: "0",
            lockedCreditUnits: "0",
            lastUpdatedBlock: blockNumber,
          },
          update: {
            lockedCreditUnits: newLocked,
            lastUpdatedBlock: blockNumber,
          },
        });
      }
      break;
    }

    case "LoanDefaulted": {
      const loanId = BigInt(args["loanId"]);
      const borrower = (args["borrower"] as string).toLowerCase();
      const loan = await client.loan.findUnique({ where: { loanId } });
      const collateralWiped = loan ? BigInt(loan.collateralUnits) : 0n;

      await client.loan.update({
        where: { loanId },
        data: {
          status: "DEFAULTED",
          defaultedAtBlock: blockNumber,
        },
      });

      if (collateralWiped > 0n) {
        const existing = await client.creditBalance.findUnique({
          where: { walletAddress: borrower },
        });
        const currentLocked = existing ? BigInt(existing.lockedCreditUnits) : 0n;
        const currentCredit = existing ? BigInt(existing.creditUnits) : 0n;
        const newLocked =
          currentLocked >= collateralWiped
            ? (currentLocked - collateralWiped).toString()
            : "0";
        const newCredit =
          currentCredit >= collateralWiped
            ? (currentCredit - collateralWiped).toString()
            : "0";

        await client.creditBalance.upsert({
          where: { walletAddress: borrower },
          create: {
            walletAddress: borrower,
            creditUnits: "0",
            lockedCreditUnits: "0",
            lastUpdatedBlock: blockNumber,
          },
          update: {
            creditUnits: newCredit,
            lockedCreditUnits: newLocked,
            lastUpdatedBlock: blockNumber,
          },
        });
      }
      break;
    }

    case "Deposited": {
      const merchant = (args["merchant"] as string).toLowerCase();
      const shares = BigInt(args["shares"]);
      const existing = await client.poolDeposit.findUnique({ where: { merchant } });
      const currentShares = existing ? BigInt(existing.shares) : 0n;
      const newShares = (currentShares + shares).toString();

      await client.poolDeposit.upsert({
        where: { merchant },
        create: {
          merchant,
          shares: newShares,
          lastUpdatedBlock: blockNumber,
        },
        update: {
          shares: newShares,
          lastUpdatedBlock: blockNumber,
        },
      });
      break;
    }

    case "Withdrawn": {
      const merchant = (args["merchant"] as string).toLowerCase();
      const shares = BigInt(args["shares"]);
      const existing = await client.poolDeposit.findUnique({ where: { merchant } });
      const currentShares = existing ? BigInt(existing.shares) : 0n;
      const newShares =
        currentShares >= shares ? (currentShares - shares).toString() : "0";

      await client.poolDeposit.upsert({
        where: { merchant },
        create: {
          merchant,
          shares: "0",
          lastUpdatedBlock: blockNumber,
        },
        update: {
          shares: newShares,
          lastUpdatedBlock: blockNumber,
        },
      });
      break;
    }

    case "AccountMoved": {
      const oldWallet = (args["oldWallet"] as string).toLowerCase();
      const newWallet = (args["newWallet"] as string).toLowerCase();
      const creditMoved = BigInt(args["creditMoved"]).toString();

      // Zero out old wallet credit
      await client.creditBalance.upsert({
        where: { walletAddress: oldWallet },
        create: {
          walletAddress: oldWallet,
          creditUnits: "0",
          lockedCreditUnits: "0",
          lastUpdatedBlock: blockNumber,
        },
        update: {
          creditUnits: "0",
          lastUpdatedBlock: blockNumber,
        },
      });

      // Transfer full credit balance to new wallet
      await client.creditBalance.upsert({
        where: { walletAddress: newWallet },
        create: {
          walletAddress: newWallet,
          creditUnits: creditMoved,
          lockedCreditUnits: "0",
          lastUpdatedBlock: blockNumber,
        },
        update: {
          creditUnits: creditMoved,
          lastUpdatedBlock: blockNumber,
        },
      });
      break;
    }

    case "UserApprovalSet": {
      const user = (args["user"] as string).toLowerCase();
      const approved = Boolean(args["approved"]);
      const binding = await client.walletBinding.findUnique({
        where: { walletAddress: user },
      });

      if (binding) {
        await client.user.update({
          where: { id: binding.userId },
          data: { isApproved: approved },
        });
      }
      break;
    }

    default:
      // Other events (TermsHashSet, TermsSigned, Paused, etc.) are recorded in chain_events
      break;
  }

  // 3. Atomically record into immutable chain_events table
  await client.chainEvent.create({
    data: {
      txHash: log.txHash,
      logIndex: log.logIndex,
      eventName: log.eventName,
      blockNumber: log.blockNumber,
      blockTimestamp: log.blockTimestamp,
      data: log.args,
    },
  });

  return { processed: true };
}
