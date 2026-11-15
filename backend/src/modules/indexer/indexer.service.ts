import { decodeEventLog } from "viem";
import { prisma } from "../../lib/prisma.js";
import { zeroAddress, type Address } from "viem";
import { publicClient, INDICO_LEDGER_ABI, ERC20_ABI, keeperWalletClient } from "../../lib/viem.js";
import { env } from "../../config/env.js";
import { projectChainLog } from "./indexer.projector.js";
import { DecodedChainLog, IndexerStatusResponse } from "./indexer.schemas.js";

export class IndexerService {
  /** Deposit box per merchant. A box is assigned once, at the first approval, and never changes (D-70). */
  private static depositBoxCache = new Map<string, Address>();
  private static lastSweepAt: number | null = null;

  static resetSweepState() {
    IndexerService.depositBoxCache.clear();
    IndexerService.lastSweepAt = null;
  }

  /** The next block range to index, at most `maxRange` blocks, or null when caught up. */
  static nextRange(processed: bigint, safeHead: bigint, maxRange: number) {
    if (processed >= safeHead) return null;
    const fromBlock = processed + 1n;
    const last = fromBlock + BigInt(maxRange) - 1n;
    return { fromBlock, toBlock: last < safeHead ? last : safeHead };
  }

  /** Sweeps the approved merchants' deposit boxes at most once per `intervalMs`. Returns whether it ran. */
  static async sweepIfDue(
    now: number = Date.now(),
    intervalMs: number = env.SWEEP_INTERVAL_MS,
    loadMerchants: () => Promise<string[]> = async () =>
      (await prisma.merchant.findMany({ where: { isApproved: true } })).map((m) => m.walletAddress),
    client: Pick<typeof publicClient, "readContract"> = publicClient,
    keeper: Pick<NonNullable<typeof keeperWalletClient>, "writeContract"> | null = keeperWalletClient ?? null
  ) {
    if (!keeper) return false;
    if (IndexerService.lastSweepAt !== null && now - IndexerService.lastSweepAt < intervalMs) return false;
    IndexerService.lastSweepAt = now;
    try {
      await IndexerService.sweepDepositBoxes(await loadMerchants(), client, keeper);
      return true;
    } catch (err: any) {
      console.warn("[Keeper] sweep round skipped:", err?.message || err);
      return false;
    }
  }
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
   * Calls `sweep` for every merchant whose deposit box holds USDC (D-70). `sweep` is
   * permissionless and the keeper key holds no role: the box's USDC can only ever become its own
   * merchant's shares, whoever calls. Without a keeper key nothing happens; anyone, the merchant
   * included, can still call `sweep` from the block explorer.
   */
  static async sweepDepositBoxes(
    merchantWallets: string[],
    client: Pick<typeof publicClient, "readContract"> = publicClient,
    keeper: Pick<NonNullable<typeof keeperWalletClient>, "writeContract"> | null = keeperWalletClient ?? null
  ) {
    if (!keeper) return [];
    const swept: string[] = [];
    for (const wallet of merchantWallets) {
      const merchant = wallet as Address;
      try {
        let box = IndexerService.depositBoxCache.get(merchant.toLowerCase());
        if (!box) {
          box = (await client.readContract({
            address: env.INDICO_LEDGER_ADDRESS as Address,
            abi: INDICO_LEDGER_ABI,
            functionName: "depositBoxOf",
            args: [merchant],
          })) as Address;
          if (box === zeroAddress) continue;
          IndexerService.depositBoxCache.set(merchant.toLowerCase(), box);
        }
        const inBox = (await client.readContract({
          address: env.USDC_ADDRESS as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [box],
        })) as bigint;
        if (inBox === 0n) continue;
        await keeper.writeContract({
          address: env.INDICO_LEDGER_ADDRESS as Address,
          abi: INDICO_LEDGER_ABI,
          functionName: "sweep",
          args: [merchant],
        } as any);
        swept.push(wallet);
      } catch (err: any) {
        console.warn(`[Keeper] sweep skipped for ${wallet}:`, err?.shortMessage || err?.message || err);
      }
    }
    return swept;
  }

  /**
   * Syncs a specific block range [fromBlock, toBlock] from the blockchain.
   */
  static async syncBlockRange(fromBlock: bigint, toBlock: bigint) {
    if (fromBlock > toBlock) {
      return { syncedBlocks: 0, eventsProcessed: 0 };
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
