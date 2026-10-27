import process from "node:process";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/crypto.js";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...");

  // 1. Apply Audit Log Triggers individually
  try {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
      RETURNS TRIGGER AS $$
      BEGIN
          RAISE EXCEPTION 'AuditLog is append-only: updates and deletes are strictly prohibited.';
      END;
      $$ LANGUAGE plpgsql;
    `);

    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit_log_prevent_update ON audit_logs;`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER audit_log_prevent_update
      BEFORE UPDATE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();
    `);

    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit_log_prevent_delete ON audit_logs;`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER audit_log_prevent_delete
      BEFORE DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();
    `);
    console.log("✓ Audit log append-only triggers installed");
  } catch (err) {
    console.warn("⚠️ Warning installing audit log triggers:", err);
  }

  // 2. Seed Default Admin Users
  const adminEmails = ["admin@indico.example", "admin@indico.io"];
  const passwordHash = await hashPassword("IndicoAdmin2026!");

  for (const email of adminEmails) {
    const existingAdmin = await prisma.adminUser.findUnique({ where: { email } });
    if (!existingAdmin) {
      await prisma.adminUser.create({
        data: {
          email,
          passwordHash,
          role: "ADMIN",
        },
      });
      console.log(`✓ Admin created: ${email} (Password: IndicoAdmin2026!)`);
    } else {
      console.log(`✓ Admin already exists: ${email}`);
    }
  }

  // 3. Optional Mock Data (Only seeded if SEED_MOCK_DATA="true")
  if (process.env.SEED_MOCK_DATA === "true") {
    console.log("🌱 Seeding optional mock user and merchant data...");

    const userEmail = "alice@indico.example";
    const existingUser = await prisma.user.findUnique({ where: { email: userEmail } });
    if (!existingUser) {
      const userPasswordHash = await hashPassword("UserPass2026!");
      await prisma.user.create({
        data: {
          email: userEmail,
          passwordHash: userPasswordHash,
          isEmailVerified: true,
          isApproved: true,
          walletBinding: {
            create: {
              walletAddress: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
              accountRef: "INDICO-ALICE-001",
            },
          },
        },
      });

      await prisma.creditBalance.upsert({
        where: { walletAddress: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" },
        update: {},
        create: {
          walletAddress: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
          creditUnits: "100000000000",
          lockedCreditUnits: "0",
        },
      });
      console.log(`✓ Approved user created: ${userEmail} (Password: UserPass2026!)`);
    }

    const testuser1Email = "testuser1@indico.com";
    const existingTestUser = await prisma.user.findUnique({ where: { email: testuser1Email } });
    if (!existingTestUser) {
      const testUserPasswordHash = await hashPassword("12345678");
      await prisma.user.create({
        data: {
          email: testuser1Email,
          passwordHash: testUserPasswordHash,
          isEmailVerified: true,
          isApproved: true,
          walletBinding: {
            create: {
              walletAddress: "0xd785f1668d59710199d8b9af37ed31883621aa65",
              accountRef: "INDICO-TESTUSER1-001",
            },
          },
        },
      });
      console.log(`✓ Approved user created: ${testuser1Email} (Password: 12345678)`);
    }

    const merchant1Addr = "0x90F79bf6EB2c4f870365E785982E1f101E93b906".toLowerCase();
    const existingM1 = await prisma.merchant.findUnique({ where: { walletAddress: merchant1Addr } });
    if (!existingM1) {
      await prisma.merchant.create({
        data: {
          name: "Apex Arbitration Chambers",
          contactEmail: "intake@apexarbitration.example",
          walletAddress: merchant1Addr,
          isApproved: true,
          agreementStatus: "SIGNED",
          agreementSentAt: new Date(Date.now() - 86400000 * 5),
          agreementSignedAt: new Date(Date.now() - 86400000 * 2),
          agreementStorageKey: "signed-agreements/apex-arbitration-2026.pdf",
          services: {
            create: [
              {
                name: "ICC Emergency Arbitrator Filing",
                priceUnits: "5000000000",
                description: "Full filing and emergency tribunal representation",
              },
              {
                name: "Merits Award Enforcement Advisory",
                priceUnits: "2500000000",
                description: "Cross-border asset recovery & enforcement memorandum",
              },
            ],
          },
        },
      });
      console.log("✓ Merchant 1 created: Apex Arbitration Chambers");
    }

    const merchant2Addr = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65".toLowerCase();
    const existingM2 = await prisma.merchant.findUnique({ where: { walletAddress: merchant2Addr } });
    if (!existingM2) {
      await prisma.merchant.create({
        data: {
          name: "Meridian Trade Verification Corp",
          contactEmail: "compliance@meridiantrade.example",
          walletAddress: merchant2Addr,
          isApproved: true,
          agreementStatus: "SENT",
          agreementSentAt: new Date(),
          services: {
            create: [
              {
                name: "Bill of Exchange Forensic Audit",
                priceUnits: "1200000000",
                description: "Cryptographic signature and endorsement chain verification",
              },
              {
                name: "Promissory Note Custodial Verification",
                priceUnits: "800000000",
                description: "Physical vault custody certificate registration",
              },
            ],
          },
        },
      });
      console.log("✓ Merchant 2 created: Meridian Trade Verification Corp");
    }

    await prisma.poolDeposit.upsert({
      where: { merchant: merchant1Addr },
      update: {},
      create: {
        merchant: merchant1Addr,
        shares: "250000000000",
      },
    });
  } else {
    console.log("ℹ️  Point 0 Clean Slate: Skipping mock users, mock merchants, and sample deposits.");
  }

  console.log("✅ Database seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
