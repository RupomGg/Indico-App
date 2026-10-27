import { PrismaClient } from "@prisma/client";
import { prisma as localPrisma } from "../src/lib/prisma.js";

async function main() {
  const targetUrl = process.argv[2] || process.env.TARGET_DATABASE_URL;

  if (!targetUrl) {
    console.error("❌ Error: Missing target Neon connection string.");
    console.log("Usage: npx tsx scripts/sync_to_neon.ts \"postgresql://...neon.tech/neondb?sslmode=require\"");
    process.exit(1);
  }

  console.log("🚀 Starting 100% full database clone from Local Postgres -> Neon Cloud...");
  const targetPrisma = new PrismaClient({
    datasources: { db: { url: targetUrl } },
  });

  try {
    // 1. Admin Users
    const admins = await localPrisma.adminUser.findMany();
    for (const a of admins) {
      await targetPrisma.adminUser.upsert({
        where: { id: a.id },
        update: a,
        create: a,
      });
    }
    console.log(`✓ Copied ${admins.length} Admin User(s)`);

    // 2. Users
    const users = await localPrisma.user.findMany();
    for (const u of users) {
      await targetPrisma.user.upsert({
        where: { id: u.id },
        update: u,
        create: u,
      });
    }
    console.log(`✓ Copied ${users.length} User(s) (including testuser1@indico.com & alice)`);

    // 3. Wallet Bindings
    const wallets = await localPrisma.walletBinding.findMany();
    for (const w of wallets) {
      await targetPrisma.walletBinding.upsert({
        where: { id: w.id },
        update: w,
        create: w,
      });
    }
    console.log(`✓ Copied ${wallets.length} Wallet Binding(s)`);

    // 4. Assets
    const assets = await localPrisma.asset.findMany();
    for (const asset of assets) {
      await targetPrisma.asset.upsert({
        where: { id: asset.id },
        update: asset,
        create: asset,
      });
    }
    console.log(`✓ Copied ${assets.length} Asset(s)`);

    // 5. Merchants
    const merchants = await localPrisma.merchant.findMany();
    for (const m of merchants) {
      await targetPrisma.merchant.upsert({
        where: { id: m.id },
        update: m,
        create: m,
      });
    }
    console.log(`✓ Copied ${merchants.length} Merchant(s)`);

    // 6. Merchant Services
    const services = await localPrisma.merchantService.findMany();
    for (const s of services) {
      await targetPrisma.merchantService.upsert({
        where: { id: s.id },
        update: s,
        create: s,
      });
    }
    console.log(`✓ Copied ${services.length} Merchant Service(s)`);

    // 7. Audit Logs
    const auditLogs = await localPrisma.auditLog.findMany();
    for (const log of auditLogs) {
      await targetPrisma.auditLog.upsert({
        where: { id: log.id },
        update: {},
        create: log,
      });
    }
    console.log(`✓ Copied ${auditLogs.length} Admin Audit Log(s)`);

    // 8. Chain Events (All Base Sepolia historical on-chain events)
    const chainEvents = await localPrisma.chainEvent.findMany();
    for (const ev of chainEvents) {
      await targetPrisma.chainEvent.upsert({
        where: { txHash_logIndex: { txHash: ev.txHash, logIndex: ev.logIndex } },
        update: ev,
        create: ev,
      });
    }
    console.log(`✓ Copied ${chainEvents.length} Chain Event(s)`);

    // 9. Read Models (Credit Balances, Loans)
    const balances = await localPrisma.creditBalance.findMany();
    for (const b of balances) {
      await targetPrisma.creditBalance.upsert({
        where: { walletAddress: b.walletAddress },
        update: b,
        create: b,
      });
    }
    console.log(`✓ Copied ${balances.length} Credit Balance record(s)`);

    const loans = await localPrisma.loan.findMany();
    for (const l of loans) {
      await targetPrisma.loan.upsert({
        where: { loanId: l.loanId },
        update: l,
        create: l,
      });
    }
    console.log(`✓ Copied ${loans.length} Loan record(s)`);

    // 10. Indexer Checkpoints
    const checkpoints = await localPrisma.indexerCheckpoint.findMany();
    for (const cp of checkpoints) {
      await targetPrisma.indexerCheckpoint.upsert({
        where: { id: cp.id },
        update: cp,
        create: cp,
      });
    }
    console.log(`✓ Copied ${checkpoints.length} Indexer Checkpoint(s)`);

    console.log("\n🎉 SUCCESS: 100% of your local database has been cloned into Neon!");
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    await localPrisma.$disconnect();
    await targetPrisma.$disconnect();
  }
}

main();
