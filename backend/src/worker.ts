import { publicClient } from "./lib/viem.js";
import { prisma } from "./lib/prisma.js";
import { env } from "./config/env.js";
import { IndexerService } from "./modules/indexer/indexer.service.js";

const CONFIRMATIONS = 2n;
const POLL_INTERVAL_MS = 3000; // 3 seconds when caught up

let isRunning = true;

async function runIndexerLoop() {
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

      if (currentProcessed < safeHead) {
        const remaining = safeHead - currentProcessed;
        const batchSize = remaining > 2000n ? 2000n : (remaining > 500n ? 500n : remaining);
        const fromBlock = currentProcessed + 1n;
        const toBlock =
          fromBlock + batchSize - 1n < safeHead
            ? fromBlock + batchSize - 1n
            : safeHead;

        const result = await IndexerService.syncBlockRange(fromBlock, toBlock);
        console.log(
          `📦 [Indexer] Synced blocks [${fromBlock} -> ${toBlock}] (${safeHead - toBlock} behind, head: ${latestBlock}). Processed ${result.eventsProcessed} event(s).`
        );
        caughtUp = toBlock >= safeHead;
      }

      // 3. Periodic Overdue Loan Check (Liquidation Keeper Alert)
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

    // If still catching up, wait 500ms to avoid Infura 429
    if (!caughtUp) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
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

runIndexerLoop();
