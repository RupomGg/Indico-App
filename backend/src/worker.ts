import { publicClient } from "./lib/viem.js";
import { prisma } from "./lib/prisma.js";
import { env } from "./config/env.js";
import { IndexerService } from "./modules/indexer/indexer.service.js";

const CONFIRMATIONS = 2n;

let isRunning = true;

export async function runIndexerLoop() {
  console.log("⚙️  [Worker] Starting Indico Background Event Indexer & Keeper...");
  console.log(`📡 [Worker] Monitoring IndicoLedger contract at ${env.INDICO_LEDGER_ADDRESS}`);
  console.log(`⛓️  [Worker] Connected to RPC: ${env.RPC_URL} (Chain ID: ${env.CHAIN_ID})`);

  while (isRunning) {
    let caughtUp = true;
    try {
      // 1. Fetch latest on-chain head block
      const latestBlock = await publicClient.getBlockNumber();
      const safeHead = latestBlock > CONFIRMATIONS ? latestBlock - CONFIRMATIONS : latestBlock;

      // 2. Determine current checkpoint
      const checkpoint = await prisma.indexerCheckpoint.findUnique({
        where: { id: "singleton" },
      });

      // If no checkpoint exists, start from recent safeHead - 50n blocks
      const currentProcessed = checkpoint
        ? checkpoint.lastProcessedBlock
        : (safeHead > 50n ? safeHead - 50n : 0n);

      const range = IndexerService.nextRange(currentProcessed, safeHead, env.LOG_BLOCK_RANGE);
      if (range) {
        const { fromBlock, toBlock } = range;
        const result = await IndexerService.syncBlockRange(fromBlock, toBlock);
        console.log(
          `📦 [Indexer] Synced blocks [${fromBlock} -> ${toBlock}] (${safeHead - toBlock} behind, head: ${latestBlock}). Processed ${result.eventsProcessed} event(s).`
        );
        caughtUp = toBlock >= safeHead;
      }

      // 3. Move merchant deposits into the pool, on its own slower timer (D-70)
      await IndexerService.sweepIfDue();

      // 4. Periodic Overdue Loan Check (Liquidation Keeper Alert)
      const nowSeconds = Math.floor(Date.now() / 1000);
      const overdueLoans = await prisma.loan.findMany({
        where: {
          status: "ACTIVE",
          dueDate: { lt: BigInt(nowSeconds) },
        },
      });

      if (overdueLoans.length > 0) {
        console.warn(
          `⚠️  [Keeper] Detected ${overdueLoans.length} overdue loan(s) eligible for liquidation: ${overdueLoans.map((l) => l.loanId).join(", ")}`
        );
      }
    } catch (err: any) {
      console.error("❌ [Worker] Error during sync loop:", err?.message || err);
    }

    // Catching up: short pause between ranges; caught up: wait for the next check.
    await new Promise((resolve) => setTimeout(resolve, caughtUp ? env.POLL_INTERVAL_MS : 500));
  }
}

// Graceful termination
process.on("SIGINT", () => {
  console.log("\n🛑 [Worker] Shutting down background worker gracefully...");
  isRunning = false;
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 [Worker] Terminating background worker...");
  isRunning = false;
  process.exit(0);
});

// Run directly when executed as standalone script (npm run worker)
const isDirectEntry = process.argv[1]?.replace(/\\/g, "/").endsWith("worker.ts") || process.argv[1]?.replace(/\\/g, "/").endsWith("worker.js");
if (isDirectEntry) {
  runIndexerLoop();
}
