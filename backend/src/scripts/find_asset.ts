import { PrismaClient } from "@prisma/client";

async function inspectAsset() {
  const local = new PrismaClient({ datasources: { db: { url: "postgresql://postgres:123456@localhost:5432/indico_db?schema=public" } } });
  const neon = new PrismaClient({ datasources: { db: { url: "postgresql://neondb_owner:npg_DgtXkH5dKFC8@ep-damp-resonance-b5mlqi7h.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require" } } });

  console.log("=== LOCAL DB ASSETS ===");
  const localAssets = await local.asset.findMany({ where: { referenceNumber: "so jjj" } });
  console.log(JSON.stringify(localAssets, null, 2));

  console.log("\n=== NEON DB ASSETS ===");
  const neonAssets = await neon.asset.findMany({ where: { referenceNumber: "so jjj" } });
  console.log(JSON.stringify(neonAssets, null, 2));

  await local.$disconnect();
  await neon.$disconnect();
}

inspectAsset();
