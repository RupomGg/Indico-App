import { describe, it, expect, vi, beforeEach } from "vitest";
import { AdminOperationsService } from "../../src/modules/admin/admin.operations.service.js";
import { prisma } from "../../src/lib/prisma.js";
import { NotFoundError, BadRequestError, PayloadTooLargeError, ConflictError } from "../../src/lib/errors.js";
import { publicClient, INDICO_LEDGER_ABI } from "../../src/lib/viem.js";
import { env } from "../../src/config/env.js";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { StorageService } from "../../src/lib/storage.js";
import { computeFileSha256 } from "../../src/lib/crypto.js";

/**
 * =======================================================================================
 * INPUT PARTITION TABLE: Admin Operations (PRD §4.7 AD-01 to AD-22; docs/input-testing.md)
 * =======================================================================================
 * 
 * Operation: User Approval & Rejection (AD-02, O-024)
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Non-existent user   | "u-ghost"        | Reject 404 NotFoundError                               |
 * | Pending user        | "u-pending"      | Marks isApproved: true, logs USER_APPROVED              |
 * | Revoke user         | "u-active"       | Marks isApproved: false, logs USER_REJECTED             |
 * 
 * Operation: Merchant & Service Management (AD-04, AD-05)
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Create merchant     | valid name/email | Creates merchant record, logs MERCHANT_CREATED          |
 * | Add service         | 100 USDC service | Creates service, logs SERVICE_ADDED                     |
 * | Update service      | new price        | Updates service, logs SERVICE_UPDATED                   |
 * | Delete service      | existing service | Deletes service, logs SERVICE_DELETED                   |
 * 
 * Operation: Agreement Workflow (AD-06, AD-07, AD-08)
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Send agreement      | merchant ID      | Sets agreementStatus="SENT", logs AGREEMENT_SENT        |
 * | Sign agreement      | signed storageKey| Sets agreementStatus="SIGNED", logs AGREEMENT_SIGNED     |
 * 
 * Operation: Pool & Safe Status (AD-13, AD-22)
 * | Class               | Value            | Expected Result                                         |
 * |---------------------|------------------|---------------------------------------------------------|
 * | Pool dashboard      | mock pool state  | Returns cash, totalDeposited, totalLent, shares         |
 * | Safe gas status     | 0.05 ETH balance | Returns safe balance, isLow: false                      |
 * | Safe gas status     | 0.001 ETH balance| Returns safe balance, isLow: true (warning triggered)   |
 * =======================================================================================
 */

describe("Admin Operations (PRD §4.7 AD-02 to AD-22)", () => {
  const mockAdminId = "admin-1";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("User Management (AD-02, AD-03)", () => {
    it("throws NotFoundError when approving non-existent user", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null);

      await expect(
        AdminOperationsService.approveUser(mockAdminId, "user-ghost")
      ).rejects.toThrow(NotFoundError);
    });

    /**
     * One-step approval: the backend prepares setUserApproved(wallet, true, accountRef) for the
     * admin wallet to sign; the database follows from the UserApprovalSet event (indexer).
     * | Class                                   | Expected                                     |
     * |-----------------------------------------|----------------------------------------------|
     * | no wallet bound                         | 400, nothing read, nothing written           |
     * | fresh wallet (role 0, no link)          | tx to the ledger, DB not approved, audit row |
     * | revoked user, same link                 | tx (re-approval)                             |
     * | already approved on-chain               | 409                                          |
     * | wallet is a merchant (role 2)           | 409                                          |
     * | wallet retired by an account move (3)   | 409                                          |
     * | wallet linked to another account ref    | 409                                          |
     * | ledger unreadable                       | 503, no tx                                   |
     */
    describe("approveUser prepares the on-chain approval", () => {
      const wallet = "0x1111111111111111111111111111111111111111";
      const ref = "0x" + "ab".repeat(32);
      const zeroRef = "0x" + "00".repeat(32);
      const bound = {
        id: "u-1",
        email: "user@test.com",
        isEmailVerified: true,
        isApproved: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        walletBinding: { walletAddress: wallet, accountRef: ref },
      };

      const chain = (role: number, approved: boolean, linked: string) =>
        vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
          if (functionName === "participantRole") return role;
          if (functionName === "approvedUser") return approved;
          if (functionName === "accountRefOf") return linked;
          throw new Error(`unexpected read ${functionName}`);
        });

      it("refuses a user with no wallet, before reading the chain or writing", async () => {
        vi.spyOn(prisma.user, "findUnique").mockResolvedValue({ ...bound, walletBinding: null } as any);
        const read = vi.spyOn(publicClient, "readContract");
        const audit = vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);
        await expect(AdminOperationsService.approveUser(mockAdminId, "u-1")).rejects.toThrow(
          /not connected a wallet/
        );
        expect(read).not.toHaveBeenCalled();
        expect(audit).not.toHaveBeenCalled();
      });

      it("returns the setUserApproved transaction and leaves the database to the indexer", async () => {
        vi.spyOn(prisma.user, "findUnique").mockResolvedValue(bound as any);
        chain(0, false, zeroRef);
        const update = vi.spyOn(prisma.user, "update");
        const audit = vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

        const res = await AdminOperationsService.approveUser(mockAdminId, "u-1");

        expect(res.approvalTx.to.toLowerCase()).toBe(env.INDICO_LEDGER_ADDRESS.toLowerCase());
        expect(res.approvalTx.value).toBe("0");
        const call = decodeFunctionData({ abi: INDICO_LEDGER_ABI, data: res.approvalTx.data as Hex });
        expect(call.functionName).toBe("setUserApproved");
        expect(call.args).toEqual([getAddress(wallet), true, ref]);
        expect(res.walletAddress).toBe(wallet);
        expect(res.accountRef).toBe(ref);
        expect(res.user.isApproved).toBe(false);
        expect(res.rolePermanentWarning).toMatch(/permanent/);
        expect(update).not.toHaveBeenCalled();
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              actorType: "ADMIN",
              actorId: mockAdminId,
              action: "USER_APPROVAL_PREPARED",
              resource: "User",
              resourceId: "u-1",
              payload: expect.objectContaining({ walletAddress: wallet, accountRef: ref }),
            }),
          })
        );
      });

      it("re-approves a revoked user whose wallet is linked to the same reference", async () => {
        vi.spyOn(prisma.user, "findUnique").mockResolvedValue(bound as any);
        chain(1, false, ref);
        vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);
        const res = await AdminOperationsService.approveUser(mockAdminId, "u-1");
        expect(decodeFunctionData({ abi: INDICO_LEDGER_ABI, data: res.approvalTx.data as Hex }).args).toEqual([
          getAddress(wallet),
          true,
          ref,
        ]);
      });

      it.each([
        ["already approved on-chain", 1, true, ref, /already approved/],
        ["a merchant wallet", 2, false, zeroRef, /merchant/],
        ["a retired wallet", 3, false, zeroRef, /retired/],
        ["linked to another account", 0, false, "0x" + "cd".repeat(32), /another account/],
      ])("refuses %s with 409 and writes nothing", async (_name, role, approved, linked, message) => {
        vi.spyOn(prisma.user, "findUnique").mockResolvedValue(bound as any);
        chain(role as number, approved as boolean, linked as string);
        const audit = vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);
        const err = await AdminOperationsService.approveUser(mockAdminId, "u-1").catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.message).toMatch(message as RegExp);
        expect(audit).not.toHaveBeenCalled();
      });

      it("answers 503 when the ledger cannot be read, with no transaction", async () => {
        vi.spyOn(prisma.user, "findUnique").mockResolvedValue(bound as any);
        vi.spyOn(publicClient, "readContract").mockRejectedValue(new Error("rpc down"));
        const audit = vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);
        const err = await AdminOperationsService.approveUser(mockAdminId, "u-1").catch((e) => e);
        expect(err.statusCode).toBe(503);
        expect(audit).not.toHaveBeenCalled();
      });
    });

    it("rejects / revokes user and creates audit log", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "u-1",
        email: "user@test.com",
        isApproved: true,
      } as any);

      vi.spyOn(prisma.user, "update").mockResolvedValue({
        id: "u-1",
        email: "user@test.com",
        isApproved: false,
      } as any);

      vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const res = await AdminOperationsService.rejectUser(mockAdminId, "u-1");
      expect(res.isApproved).toBe(false);
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorType: "ADMIN",
            actorId: mockAdminId,
            action: "USER_REJECTED",
            resource: "User",
            resourceId: "u-1",
          }),
        })
      );
    });

    it("retrieves full user detail including wallet, assets, and balance (AD-03)", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "u-1",
        email: "user@test.com",
        isApproved: true,
        walletBinding: {
          walletAddress: "0x1111111111111111111111111111111111111111",
          boundAt: new Date(),
        },
        assets: [
          {
            id: "a-1",
            docHash: "0xhash",
            assetType: 1,
            declaredValue: "500.000000",
            status: "REGISTERED",
          },
        ],
      } as any);

      vi.spyOn(prisma.creditBalance, "findUnique").mockResolvedValue({
        creditUnits: "500000000",
        lockedCreditUnits: "0",
      } as any);

      const userDetail = await AdminOperationsService.getUserDetail("u-1");
      expect(userDetail.id).toBe("u-1");
      expect(userDetail.walletAddress).toBe("0x1111111111111111111111111111111111111111");
      expect(userDetail.credit).toBe("500.000000");
      expect(userDetail.assets.length).toBe(1);
    });
  });

  describe("Merchant & Services Management (AD-04, AD-05)", () => {
    it("creates merchant and logs audit event", async () => {
      vi.spyOn(prisma.merchant, "create").mockResolvedValue({
        id: "m-new",
        name: "New Merchant",
        contactEmail: "new@merchant.com",
        walletAddress: "0x3333333333333333333333333333333333333333",
        isApproved: true,
        agreementStatus: "NOT_SENT",
      } as any);

      vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const res = await AdminOperationsService.createMerchant(mockAdminId, {
        name: "New Merchant",
        contactEmail: "new@merchant.com",
        walletAddress: "0x3333333333333333333333333333333333333333",
        isApproved: true,
      });

      expect(res.id).toBe("m-new");
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorType: "ADMIN",
            action: "MERCHANT_CREATED",
          }),
        })
      );
    });

    it("adds a service to merchant (AD-05)", async () => {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue({ id: "m-1" } as any);
      vi.spyOn(prisma.merchantService, "create").mockResolvedValue({
        id: "s-1",
        merchantId: "m-1",
        name: "Legal Retainer",
        priceUnits: "250000000",
        description: "Monthly retainer",
      } as any);

      vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const res = await AdminOperationsService.addMerchantService(mockAdminId, "m-1", {
        name: "Legal Retainer",
        price: "250.000000",
        description: "Monthly retainer",
      });

      expect(res.id).toBe("s-1");
      expect(res.price).toBe("250.000000");
    });
  });

  describe("Merchant Agreement Workflow (AD-06, AD-07, AD-08)", () => {
    it("marks agreement sent and updates timestamp", async () => {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue({ id: "m-1" } as any);
      vi.spyOn(prisma.merchant, "update").mockResolvedValue({
        id: "m-1",
        agreementStatus: "SENT",
        agreementSentAt: new Date(),
      } as any);
      vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const res = await AdminOperationsService.sendMerchantAgreement(mockAdminId, "m-1");
      expect(res.agreementStatus).toBe("SENT");
    });

    it("refuses to mark a signed agreement as sent again (D3)", async () => {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue({ id: "m-1", agreementStatus: "SIGNED" } as any);
      const update = vi.spyOn(prisma.merchant, "update").mockResolvedValue({} as any);

      await expect(AdminOperationsService.sendMerchantAgreement(mockAdminId, "m-1")).rejects.toBeInstanceOf(
        ConflictError
      );
      expect(update).not.toHaveBeenCalled();
    });

    it("marks agreement signed and records agreement document", async () => {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue({ id: "m-1" } as any);
      vi.spyOn(prisma.merchant, "update").mockResolvedValue({
        id: "m-1",
        agreementStatus: "SIGNED",
        agreementSignedAt: new Date(),
      } as any);
      vi.spyOn(prisma.merchantAgreement, "create").mockResolvedValue({} as any);
      vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const res = await AdminOperationsService.signMerchantAgreement(
        mockAdminId,
        "m-1",
        "agreements/m-1-signed.pdf"
      );
      expect(res.agreementStatus).toBe("SIGNED");
    });

    it("creating a SIGNED merchant invents no storage key and no agreement row (D3)", async () => {
      const create = vi.spyOn(prisma.merchant, "create").mockResolvedValue({ id: "m-new", name: "M" } as any);
      const agreementRow = vi.spyOn(prisma.merchantAgreement, "create").mockResolvedValue({} as any);
      vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      await AdminOperationsService.createMerchant(mockAdminId, {
        name: "M",
        contactEmail: "m@merchant.com",
        walletAddress: "0x3333333333333333333333333333333333333333",
        isApproved: false,
        agreementStatus: "SIGNED",
      });

      expect(create.mock.calls[0]![0].data.agreementStorageKey).toBeNull();
      expect(agreementRow).not.toHaveBeenCalled();
    });
  });

  /**
   * Signed agreement file (AD-07, D-69). Partition table:
   * | Input                        | Expected                                                   |
   * |------------------------------|------------------------------------------------------------|
   * | unknown merchant             | 404 NotFoundError                                          |
   * | empty file                   | 400 BadRequestError                                        |
   * | not PDF, PNG or JPEG         | 400 BadRequestError (checked by content, not by name)      |
   * | 20 MB + 1 byte               | 413 PayloadTooLargeError                                   |
   * | PDF, PNG, JPEG               | stored encrypted under its SHA-256, SIGNED, row and audit  |
   * | on-chain hash equal          | matchesOnChain true                                        |
   * | on-chain hash different      | matchesOnChain false                                       |
   * | not recorded on-chain (0x0)  | matchesOnChain null, onChainAgreementHash null             |
   * | RPC failure                  | matchesOnChain null, upload still stored                   |
   * | download, no file stored     | 404 NotFoundError                                          |
   * | download, file stored        | decrypted bytes and their SHA-256                          |
   */
  describe("Signed Agreement File (AD-07, D-69)", () => {
    const merchant = {
      id: "m-1",
      walletAddress: "0x3333333333333333333333333333333333333333",
      agreementSentAt: null,
      agreementStorageKey: null,
    };
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("signed agreement body")]);
    const pdfHash = computeFileSha256(pdf);
    const ZERO = `0x${"0".repeat(64)}`;

    function mockWrites() {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue(merchant as any);
      const update = vi.spyOn(prisma.merchant, "update").mockResolvedValue({} as any);
      const row = vi.spyOn(prisma.merchantAgreement, "create").mockResolvedValue({} as any);
      const audit = vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);
      vi.spyOn(prisma, "$transaction").mockImplementation(async (ops: any) => Promise.all(ops));
      const save = vi.spyOn(StorageService, "saveEncryptedAt").mockResolvedValue();
      return { update, row, audit, save };
    }

    it("rejects an unknown merchant", async () => {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue(null);
      await expect(
        AdminOperationsService.uploadMerchantAgreementFile(mockAdminId, "m-ghost", pdf)
      ).rejects.toThrow(NotFoundError);
    });

    it("rejects an empty file", async () => {
      const { save } = mockWrites();
      await expect(
        AdminOperationsService.uploadMerchantAgreementFile(mockAdminId, "m-1", Buffer.alloc(0))
      ).rejects.toThrow(BadRequestError);
      expect(save).not.toHaveBeenCalled();
    });

    it("rejects a file that is not a PDF, PNG or JPEG", async () => {
      const { save } = mockWrites();
      await expect(
        AdminOperationsService.uploadMerchantAgreementFile(mockAdminId, "m-1", Buffer.from("MZ not a pdf"))
      ).rejects.toThrow(/PDF, PNG or JPEG/);
      expect(save).not.toHaveBeenCalled();
    });

    it("rejects a file over 20 MB", async () => {
      const { save } = mockWrites();
      const big = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(20 * 1024 * 1024 - 4)]);
      await expect(
        AdminOperationsService.uploadMerchantAgreementFile(mockAdminId, "m-1", big)
      ).rejects.toThrow(PayloadTooLargeError);
      expect(save).not.toHaveBeenCalled();
    });

    it("stores the PDF encrypted under its SHA-256 and records it as signed", async () => {
      const { update, row, audit, save } = mockWrites();
      vi.spyOn(publicClient, "readContract").mockResolvedValue(pdfHash as any);

      const res = await AdminOperationsService.uploadMerchantAgreementFile(mockAdminId, "m-1", pdf);

      const key = `agreements/m-1/${pdfHash.slice(2)}.enc`;
      expect(save).toHaveBeenCalledWith(key, pdf);
      expect(res).toEqual({
        storageKey: key,
        sha256: pdfHash,
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
        onChainAgreementHash: pdfHash,
        matchesOnChain: true,
      });
      const data = update.mock.calls[0]![0].data as any;
      expect(data.agreementStatus).toBe("SIGNED");
      expect(data.agreementStorageKey).toBe(key);
      expect(data.agreementSentAt).toBeInstanceOf(Date);
      expect(row.mock.calls[0]![0].data).toMatchObject({ merchantId: "m-1", storageKey: key, status: "SIGNED" });
      expect(audit.mock.calls[0]![0].data).toMatchObject({
        action: "AGREEMENT_FILE_UPLOADED",
        payload: { storageKey: key, sha256: pdfHash },
      });
    });

    it("accepts PNG and JPEG by content", async () => {
      mockWrites();
      vi.spyOn(publicClient, "readContract").mockResolvedValue(ZERO as any);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const jpg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
      expect((await AdminOperationsService.uploadMerchantAgreementFile(mockAdminId, "m-1", png)).mimeType).toBe("image/png");
      expect((await AdminOperationsService.uploadMerchantAgreementFile(mockAdminId, "m-1", jpg)).mimeType).toBe("image/jpeg");
    });

    it("reports a mismatch with the hash recorded on-chain", async () => {
      mockWrites();
      const other = `0x${"ab".repeat(32)}`;
      vi.spyOn(publicClient, "readContract").mockResolvedValue(other as any);
      const res = await AdminOperationsService.uploadMerchantAgreementFile(mockAdminId, "m-1", pdf);
      expect(res.onChainAgreementHash).toBe(other);
      expect(res.matchesOnChain).toBe(false);
    });

    it("reports nothing to compare when no agreement is recorded on-chain", async () => {
      mockWrites();
      vi.spyOn(publicClient, "readContract").mockResolvedValue(ZERO as any);
      const res = await AdminOperationsService.uploadMerchantAgreementFile(mockAdminId, "m-1", pdf);
      expect(res.onChainAgreementHash).toBeNull();
      expect(res.matchesOnChain).toBeNull();
    });

    it("still stores the file when the RPC fails", async () => {
      const { save } = mockWrites();
      vi.spyOn(publicClient, "readContract").mockRejectedValue(new Error("rpc down"));
      const res = await AdminOperationsService.uploadMerchantAgreementFile(mockAdminId, "m-1", pdf);
      expect(save).toHaveBeenCalled();
      expect(res.matchesOnChain).toBeNull();
    });

    it("download: 404 when no file is stored", async () => {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue(merchant as any);
      await expect(AdminOperationsService.getMerchantAgreementFile("m-1")).rejects.toThrow(NotFoundError);
    });

    it("download: returns the decrypted file and its SHA-256", async () => {
      vi.spyOn(prisma.merchant, "findUnique").mockResolvedValue({ ...merchant, agreementStorageKey: "agreements/m-1/x.enc" } as any);
      const read = vi.spyOn(StorageService, "readDecryptedFile").mockResolvedValue(pdf);
      const res = await AdminOperationsService.getMerchantAgreementFile("m-1");
      expect(read).toHaveBeenCalledWith("agreements/m-1/x.enc");
      expect(res).toEqual({ buffer: pdf, sha256: pdfHash, mimeType: "application/pdf", ext: "pdf" });
    });
  });

  describe("Pool, Loans & Safe Dashboard (AD-13, AD-15, AD-22)", () => {
    it("retrieves pool metrics (AD-13)", async () => {
      vi.spyOn(prisma.poolDeposit, "findMany").mockResolvedValue([
        { merchant: "0x1", shares: "1000000" },
        { merchant: "0x2", shares: "2000000" },
      ] as any);
      vi.spyOn(publicClient, "readContract").mockImplementation(async ({ functionName }: any) => {
        if (functionName === "poolAvailable") return 50_000_000_000n; // 50,000 USDC
        if (functionName === "totalLent") return 10_000_000_000n; // 10,000 USDC
        return 0n;
      });

      const pool = await AdminOperationsService.getPoolDashboard();
      expect(pool.poolCash).toBe("50000.000000");
      expect(pool.totalLent).toBe("10000.000000");
      expect(pool.depositorCount).toBe(2);
    });

    it("retrieves platform loan list with overdue liquidation status (AD-15, AD-21)", async () => {
      const pastDueDate = BigInt(Math.floor(Date.now() / 1000) - 3600); // 1 hour overdue
      vi.spyOn(prisma.loan, "findMany").mockResolvedValue([
        {
          loanId: 101n,
          borrower: "0xborrower",
          principalUnits: "1000000000",
          collateralUnits: "1250000000",
          dueDate: pastDueDate,
          extensionCount: 0,
          status: "ACTIVE",
          openedAtBlock: 1000n,
        },
      ] as any);
      vi.spyOn(prisma.loan, "count").mockResolvedValue(1);

      const loansRes = await AdminOperationsService.getLoansDashboard({ page: 1, limit: 10 });
      expect(loansRes.items.length).toBe(1);
      const loan = loansRes.items[0]!;
      expect(loan.isOverdue).toBe(true);
      expect(loan.canLiquidate).toBe(true);
    });

    it("checks Safe Base ETH balance and triggers low-balance alert if balance < 0.01 ETH (AD-22)", async () => {
      // 0.005 ETH (low)
      vi.spyOn(publicClient, "getBalance").mockResolvedValue(5_000_000_000_000_000n);

      const status = await AdminOperationsService.getSafeStatus();
      expect(status.balanceEth).toBe("0.005");
      expect(status.isLow).toBe(true);
      expect(status.warning).toBeDefined();
    });
  });
});
