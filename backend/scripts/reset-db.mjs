// Empties the database for a fresh start on a new ledger deployment. Keeps admin_users (admin
// logins) and sets the indexer checkpoint so it replays from the ledger's deployment block.
//
//   node scripts/reset-db.mjs                 shows the target and row counts, deletes nothing
//   node scripts/reset-db.mjs --yes           deletes
//
// Uses DATABASE_URL from the environment (or backend/.env). START_BLOCK overrides the checkpoint.
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const KEEP = new Set(["admin_users", "_prisma_migrations"]);
const START_BLOCK = BigInt(process.env.START_BLOCK ?? "57981793"); // ledger 0xBB19…90D3 deployment

const url = process.env.DATABASE_URL ?? "";
const target = url.replace(/(:\/\/[^:]+:)[^@]*@/, "$1****@") || "(DATABASE_URL from backend/.env)";
const prisma = new PrismaClient();

const tables = (
  await prisma.$queryRawUnsafe(`select tablename from pg_tables where schemaname = 'public' order by tablename`)
).map((r) => r.tablename);

console.log(`Target: ${target}`);
for (const t of tables) {
  const [{ c }] = await prisma.$queryRawUnsafe(`select count(*)::int as c from "${t}"`);
  console.log(`  ${KEEP.has(t) ? "keep " : "EMPTY"} ${t}: ${c}`);
}

if (!process.argv.includes("--yes")) {
  console.log("Nothing deleted. Run again with --yes to empty the tables marked EMPTY.");
  await prisma.$disconnect();
  process.exit(0);
}

const wipe = tables.filter((t) => !KEEP.has(t)).map((t) => `"${t}"`).join(", ");
// TRUNCATE does not fire the row-level triggers that keep audit_logs append-only.
await prisma.$executeRawUnsafe(`TRUNCATE ${wipe} RESTART IDENTITY CASCADE`);
await prisma.indexerCheckpoint.create({ data: { id: "singleton", lastProcessedBlock: START_BLOCK - 1n } });
console.log(`Emptied ${tables.length - KEEP.size} tables; indexer starts at block ${START_BLOCK}.`);

const storage = path.resolve(process.cwd(), process.env.STORAGE_LOCAL_PATH ?? "./storage");
if (fs.existsSync(storage)) {
  fs.rmSync(storage, { recursive: true, force: true });
  console.log(`Deleted stored files under ${storage}.`);
}
await prisma.$disconnect();
