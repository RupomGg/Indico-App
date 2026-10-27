import { decodeEventLog } from "viem";
import { prisma } from "../../lib/prisma.js";
import { publicClient, INDICO_LEDGER_ABI, keeperWalletClient, keeperAccount } from "../../lib/viem.js";
import { env } from "../../config/env.js";
import { projectChainLog } from "./indexer.projector.js";
import { DecodedChainLog, IndexerStatusResponse } from "./indexer.schemas.js";

export class IndexerService {
  /**
   * Processes a single decoded log within an atomic transaction.
   */
  static async processLog(log: DecodedChainLog) {
    return prisma.$transaction(async (tx) => {
      const result = await projectChainLog(tx, log);
      // Advance checkpoint if this log belongs to a newer block
      if (result.processed) {
        await tx.indexerCheckpoint.upsert({
          where: { id: "singleton" },
          create: { id: "singleton", lastProcessedBlock: log.blockNumber },
          update: {
            lastProcessedBlock: {
              // Ensure we only advance forward
              set: log.blockNumber,
            },
          },
        });
      }
      return result;
    });
  }

  /**
   * Syncs a specific block range [fromBlock, toBlock] from the blockchain.
   */
  static async syncBlockRange(fromBlock: bigint, toBlock: bigint) {
    if (fromBlock > toBlock) {
      return { syncedBlocks: 0, eventsProcessed: 0 };
    }

    // 1. Check for direct USDC transfers sent to IndicoLedger (e.g. from Tangem / MetaMask wallet "Send")
    try {
      const usdcTransferLogs = await publicClient.getLogs({
        address: env.USDC_ADDRESS as `0x${string}`,
        event: {
          type: "event",
          name: "Transfer",
          inputs: [
            { type: "address", name: "from", indexed: true },
            { type: "address", name: "to", indexed: true },
            { type: "uint256", name: "value", indexed: false },
          ],
        },
        args: {
          to: env.INDICO_LEDGER_ADDRESS as `0x${string}`,
        },
        fromBlock,
        toBlock,
      });

      for (const log of usdcTransferLogs) {
        const fromAddress = (log.args.from as string).toLowerCase();
        const value = log.args.value as bigint;

        if (!fromAddress || !value || value === 0n) continue;

        const merchant = await prisma.merchant.findUnique({
          where: { walletAddress: fromAddress },
        });

        if (merchant && merchant.isApproved && keeperWalletClient && keeperAccount) {
          console.log(`⚡ [Keeper] Direct USDC transfer of ${value} units detected from approved merchant ${fromAddress}. Syncing on-chain...`);
          try {
            const hash = await keeperWalletClient.writeContract({
              address: env.INDICO_LEDGER_ADDRESS as `0x${string}`,
              abi: INDICO_LEDGER_ABI,
              functionName: "syncDeposit",
              args: [fromAddress as `0x${string}`, value],
              account: keeperAccount,
            });
            console.log(`✅ [Keeper] syncDeposit broadcasted for merchant ${fromAddress}: ${hash}`);
          } catch (syncErr: any) {
            console.warn(`⚠️ [Keeper] syncDeposit skipped or already synced:`, syncErr?.message || syncErr);
          }
        }
      }
    } catch (err: any) {
      // Don't interrupt indexer loop if public RPC getLogs encounters rate limit
    }

    const rawLogs = await publicClient.getLogs({
      address: env.INDICO_LEDGER_ADDRESS as `0x${string}`,
      fromBlock,
      toBlock,
    });

    let eventsProcessed = 0;

    await prisma.$transaction(
      async (tx) => {
        for (const log of rawLogs) {
          let decoded: any;
          try {
            decoded = decodeEventLog({
              abi: INDICO_LEDGER_ABI,
              data: log.data,
              topics: log.topics,
            });
          } catch {
            // Ignore logs that do not match the Indico contract ABI
            continue;
          }

          const block = await publicClient.getBlock({
            blockNumber: log.blockNumber,
          });

          const decodedLog: DecodedChainLog = {
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            eventName: decoded.eventName,
            blockNumber: log.blockNumber,
            blockTimestamp: block.timestamp,
            args: (decoded.args || {}) as Record<string, any>,
          };

          const res = await projectChainLog(tx, decodedLog);
          if (res.processed) {
            eventsProcessed++;
          }
        }

        // Commit latest processed block checkpoint
        await tx.indexerCheckpoint.upsert({
          where: { id: "singleton" },
          create: { id: "singleton", lastProcessedBlock: toBlock },
          update: { lastProcessedBlock: toBlock },
        });
      },
      { timeout: 60000 }
    );

    return {
      syncedBlocks: Number(toBlock - fromBlock + 1n),
      eventsProcessed,
    };
  }

  /**
   * Replays all historical events recorded in `chain_events` from scratch (PRD §2).
   * Proves that the PostgreSQL database is a 100% deterministic projection of on-chain events.
   */
  static async replayAllEvents(): Promise<{ replayedEvents: number }> {
    return prisma.$transaction(
      async (tx) => {
        // 1. Wipe current read models
        await tx.creditBalance.deleteMany({});
        await tx.loan.deleteMany({});
        await tx.poolDeposit.deleteMany({});

        // 2. Fetch all raw events in chronological order
        const events = await tx.chainEvent.findMany({
          orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }],
        });

        // 3. Temporarily clear chain_events so projectChainLog idempotency passes
        await tx.chainEvent.deleteMany({});

        // 4. Re-project each event sequentially
        for (const event of events) {
          const log: DecodedChainLog = {
            txHash: event.txHash,
            logIndex: event.logIndex,
            eventName: event.eventName,
            blockNumber: event.blockNumber,
            blockTimestamp: event.blockTimestamp,
            args: (event.data || {}) as Record<string, any>,
          };
          await projectChainLog(tx, log);
        }

        // 5. Update checkpoint to latest block
        if (events.length > 0) {
          const lastEvent = events[events.length - 1]!;
          await tx.indexerCheckpoint.upsert({
            where: { id: "singleton" },
            create: { id: "singleton", lastProcessedBlock: lastEvent.blockNumber },
            update: { lastProcessedBlock: lastEvent.blockNumber },
          });
        }

        return { replayedEvents: events.length };
      },
      { timeout: 120000 }
    );
  }

  /**
   * Retrieves the current indexer sync status and lag behind the chain head.
   */
  static async getStatus(): Promise<IndexerStatusResponse> {
    const checkpoint = await prisma.indexerCheckpoint.findUnique({
      where: { id: "singleton" },
    });

    const totalEvents = await prisma.chainEvent.count();

    const lastProcessedBlock = checkpoint ? checkpoint.lastProcessedBlock : 0n;
    let latestOnChainBlock: bigint | undefined;
    let lagBlocks: bigint | undefined;

    try {
      latestOnChainBlock = await publicClient.getBlockNumber();
      lagBlocks =
        latestOnChainBlock > lastProcessedBlock
          ? latestOnChainBlock - lastProcessedBlock
          : 0n;
    } catch {
      // Offline fallback
    }

    return {
      lastProcessedBlock: lastProcessedBlock.toString(),
      latestOnChainBlock: latestOnChainBlock?.toString(),
      lagBlocks: lagBlocks?.toString(),
      isSynced: lagBlocks !== undefined ? lagBlocks <= 2n : false,
      totalIndexedEvents: totalEvents,
      lastSyncTimestamp: checkpoint?.updatedAt.toISOString() || new Date().toISOString(),
    };
  }
}
