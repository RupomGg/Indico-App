import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/crypto.js";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...");

  // 1. Seed Default Admin User (AD-01)
  const adminEmail = "admin@indico.example";
  const existingAdmin = await prisma.adminUser.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    const passwordHash = await hashPassword("IndicoAdmin2026!");
    await prisma.adminUser.create({
      data: {
        email: adminEmail,
        passwordHash,
        role: "ADMIN",
      },
    });
    console.log(`✓ Admin created: ${adminEmail} (Password: IndicoAdmin2026!)`);
  }

  // 2. Seed Approved Test User
  const userEmail = "alice@indico.example";
  const existingUser = await prisma.user.findUnique({ where: { email: userEmail } });
  if (!existingUser) {
    const passwordHash = await hashPassword("UserPass2026!");
    const user = await prisma.user.create({
      data: {
        email: userEmail,
        passwordHash,
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

    // Seed mock credit balance
    await prisma.creditBalance.upsert({
      where: { walletAddress: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" },
      update: {},
      create: {
        walletAddress: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        creditUnits: "100000000000", // 100,000.000000 USDC
        lockedCreditUnits: "0",
      },
    });
    console.log(`✓ Approved user created: ${userEmail} (Password: UserPass2026!) with 100,000 USDC credit`);
  }

  // 3. Seed Sample Merchants & Services (AD-04, AD-05, C-03)
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
              priceUnits: "5000000000", // 5000.000000 USDC
              description: "Full filing and emergency tribunal representation",
            },
            {
              name: "Merits Award Enforcement Advisory",
              priceUnits: "2500000000", // 2500.000000 USDC
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
              priceUnits: "1200000000", // 1200.000000 USDC
              description: "Cryptographic signature and endorsement chain verification",
            },
            {
              name: "Promissory Note Custodial Verification",
              priceUnits: "800000000", // 800.000000 USDC
              description: "Physical vault custody certificate registration",
            },
          ],
        },
      },
    });
    console.log("✓ Merchant 2 created: Meridian Trade Verification Corp");
  }

  // 4. Seed Pool Deposits (AD-13)
  await prisma.poolDeposit.upsert({
    where: { merchant: merchant1Addr },
    update: {},
    create: {
      merchant: merchant1Addr,
      shares: "250000000000", // 250,000 USDC deposit
    },
  });

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
