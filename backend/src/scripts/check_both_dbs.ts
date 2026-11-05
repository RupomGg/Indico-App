import { PrismaClient } from "@prisma/client";

async function check() {
  console.log("=== LOCAL POSTGRES ===");
  const local = new PrismaClient({
    datasources: { db: { url: "postgresql://postgres:123456@localhost:5432/indico_db?schema=public" } },
  });
  try {
    const localUsers = await local.user.findMany({
      select: { id: true, email: true, isEmailVerified: true, isApproved: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    console.log("Local Users count:", localUsers.length);
    console.table(localUsers);

    const localAdmins = await local.adminUser.findMany({
      select: { id: true, email: true, role: true },
    });
    console.log("Local Admins count:", localAdmins.length);
    console.table(localAdmins);
  } catch (e: any) {
    console.error("Local error:", e.message);
  } finally {
    await local.$disconnect();
  }

  console.log("\n=== NEON CLOUD ===");
  const neon = new PrismaClient({
    datasources: { db: { url: "postgresql://neondb_owner:npg_DgtXkH5dKFC8@ep-damp-resonance-b5mlqi7h.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require" } },
  });
  try {
    const neonUsers = await neon.user.findMany({
      select: { id: true, email: true, isEmailVerified: true, isApproved: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    console.log("Neon Users count:", neonUsers.length);
    console.table(neonUsers);

    const neonAdmins = await neon.adminUser.findMany({
      select: { id: true, email: true, role: true },
    });
    console.log("Neon Admins count:", neonAdmins.length);
    console.table(neonAdmins);
  } catch (e: any) {
    console.error("Neon error:", e.message);
  } finally {
    await neon.$disconnect();
  }
}

check();
