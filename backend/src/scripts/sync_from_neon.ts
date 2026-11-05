import process from "node:process";
import { PrismaClient } from "@prisma/client";
import { prisma as localPrisma } from "../lib/prisma.js";

const DEFAULT_NEON_URL =
  process.env.TARGET_DATABASE_URL ||
  "postgresql://neondb_owner:npg_DgtXkH5dKFC8@ep-damp-resonance-b5mlqi7h.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require";

async function main() {
  const neonUrl = process.argv[2] || DEFAULT_NEON_URL;

  console.log("🚀 Starting database pull: Neon Cloud -> Local Postgres...");
  const neonPrisma = new PrismaClient({
    datasources: { db: { url: neonUrl } },
  });

  try {
    // 1. Admin Users
    const admins = await neonPrisma.adminUser.findMany();
    for (const a of admins) {
      await localPrisma.adminUser.upsert({
        where: { id: a.id },
        update: a as any,
        create: a as any,
      });
    }
    console.log(`✓ Pulled ${admins.length} Admin User(s)`);

    // 2. Users
    const users = await neonPrisma.user.findMany();
    for (const u of users) {
      await localPrisma.user.upsert({
        where: { id: u.id },
        update: u as any,
        create: u as any,
      });
    }
    console.log(`✓ Pulled ${users.length} User(s)`);

    // 3. Wallet Bindings
    const wallets = await neonPrisma.walletBinding.findMany();
    for (const w of wallets) {
      await localPrisma.walletBinding.upsert({
        where: { id: w.id },
        update: w as any,
        create: w as any,
      });
    }
    console.log(`✓ Pulled ${wallets.length} Wallet Binding(s)`);

    // 4. Assets
    const assets = await neonPrisma.asset.findMany();
    for (const asset of assets) {
      await localPrisma.asset.upsert({
        where: { id: asset.id },
        update: asset as any,
        create: asset as any,
      });
    }
    console.log(`✓ Pulled ${assets.length} Asset(s)`);

    // 5. Merchants
    const merchants = await neonPrisma.merchant.findMany();
    for (const m of merchants) {
      await localPrisma.merchant.upsert({
        where: { id: m.id },
        update: m as any,
        create: m as any,
      });
    }
    console.log(`✓ Pulled ${merchants.length} Merchant(s)`);

    // 6. Merchant Services
    const services = await neonPrisma.merchantService.findMany();
    for (const s of services) {
      await localPrisma.merchantService.upsert({
        where: { id: s.id },
        update: s as any,
        create: s as any,
      });
    }
    console.log(`✓ Pulled ${services.length} Merchant Service(s)`);

    // 7. Audit Logs
    const auditLogs = await neonPrisma.auditLog.findMany();
    for (const log of auditLogs) {
      await localPrisma.auditLog.upsert({
        where: { id: log.id },
        update: {},
        create: log as any,
      });
    }
    console.log(`✓ Pulled ${auditLogs.length} Admin Audit Log(s)`);

    // 8. Chain Events
    const chainEvents = await neonPrisma.chainEvent.findMany();
    for (const ev of chainEvents) {
      await localPrisma.chainEvent.upsert({
        where: { txHash_logIndex: { txHash: ev.txHash, logIndex: ev.logIndex } },
        update: ev as any,
        create: ev as any,
      });
    }
    console.log(`✓ Pulled ${chainEvents.length} Chain Event(s)`);

    // 9. Read Models
    const balances = await neonPrisma.creditBalance.findMany();
    for (const b of balances) {
      await localPrisma.creditBalance.upsert({
        where: { walletAddress: b.walletAddress },
        update: b as any,
        create: b as any,
      });
    }
    console.log(`✓ Pulled ${balances.length} Credit Balance record(s)`);

    const loans = await neonPrisma.loan.findMany();
    for (const l of loans) {
      await localPrisma.loan.upsert({
        where: { loanId: l.loanId },
        update: l as any,
        create: l as any,
      });
    }
    console.log(`✓ Pulled ${loans.length} Loan record(s)`);

    // 10. Indexer Checkpoints
    const checkpoints = await neonPrisma.indexerCheckpoint.findMany();
    for (const cp of checkpoints) {
      await localPrisma.indexerCheckpoint.upsert({
        where: { id: cp.id },
        update: cp as any,
        create: cp as any,
      });
    }
    console.log(`✓ Pulled ${checkpoints.length} Indexer Checkpoint(s)`);

    console.log("\n🎉 SUCCESS: Local Postgres has been synced with Neon Cloud!");
  } catch (err) {
    console.error("❌ Sync failed:", err);
    process.exit(1);
  } finally {
    await localPrisma.$disconnect();
    await neonPrisma.$disconnect();
  }
}

main();
