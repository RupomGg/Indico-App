import { describe, it, expect, beforeEach, vi } from "vitest";
import { projectChainLog } from "../../src/modules/indexer/indexer.projector.js";
import { IndexerService } from "../../src/modules/indexer/indexer.service.ts";
import { DecodedChainLog } from "../../src/modules/indexer/indexer.schemas.js";

/**
 * ============================================================================
 * PARAMETER PARTITION TABLE: Real-Time On-Chain Event Indexer & State Replay
 * ============================================================================
 * Event Types & State Transitions:
 * ----------------------------------------------------------------------------
 * Event Name     | Input Arguments                    | Projected DB State
 * ----------------+------------------------------------+----------------------
 * CreditMinted   | user, amount, reason               | credit[user] += amount
 * CreditBurned   | user, amount, reason               | credit[user] -= amount
 * Spent          | user, merchant, amount             | user -= amount, merchant += amount
 * LoanOpened     | loanId, borrower, principal,       | loan.status = ACTIVE,
 *                | collateral, dueDate                | borrower.lockedCredit += collateral
 * LoanExtended   | loanId, newDueDate, extensionCount | loan.dueDate = newDueDate, extended = true
 * LoanRepaid     | loanId, borrower, principal        | loan.status = REPAID,
 *                |                                    | borrower.lockedCredit -= collateral
 * LoanDefaulted  | loanId, borrower, principal,       | loan.status = DEFAULTED,
 *                | collateral, caller                 | borrower.lockedCredit -= collateral,
 *                |                                    | borrower.credit -= collateral
 * Deposited      | merchant, assets, shares           | poolDeposit[merchant].shares += shares
 * Withdrawn      | merchant, assets, shares           | poolDeposit[merchant].shares -= shares
 * AccountMoved   | oldWallet, newWallet, ref, amount  | credit[new] = amount, credit[old] = 0
 * UserApprovalSet| user, approved, accountRef         | user.isApproved = approved
 * ----------------------------------------------------------------------------
 * Invariant Asserts:
 * 1. Idempotency: Duplicate (txHash, logIndex) events rejected without double counting.
 * 2. Determinism (PRD §2): Wiping and replaying all events from chain_events recreates
 *    the exact identical balances, loans, and pool deposits.
 * 3. Exact Math: Zero float operations; all calculations done with strict BigInt.
 * ============================================================================
 */

describe("Real-Time On-Chain Event Indexer & State Projector (PRD §2, §5)", () => {
  // In-memory mock DB stores to verify projections deterministically
  let creditBalances: Map<string, { creditUnits: string; lockedCreditUnits: string; lastUpdatedBlock: bigint }>;
  let loans: Map<string, any>;
  let poolDeposits: Map<string, { shares: string; lastUpdatedBlock: bigint }>;
  let chainEvents: Map<string, any>;
  let users: Map<string, any>;
  let walletBindings: Map<string, any>;
  let checkpointBlock: bigint;

  let mockClient: any;

  beforeEach(() => {
    creditBalances = new Map();
    loans = new Map();
    poolDeposits = new Map();
    chainEvents = new Map();
    users = new Map();
    walletBindings = new Map();
    checkpointBlock = 0n;

    mockClient = {
      creditBalance: {
        findUnique: vi.fn(async ({ where }) => creditBalances.get(where.walletAddress) || null),
        upsert: vi.fn(async ({ where, create, update }) => {
          const existing = creditBalances.get(where.walletAddress);
          if (existing) {
            const updated = { ...existing, ...update };
            creditBalances.set(where.walletAddress, updated);
            return updated;
          } else {
            creditBalances.set(where.walletAddress, create);
            return create;
          }
        }),
        deleteMany: vi.fn(async () => creditBalances.clear()),
      },
      loan: {
        findUnique: vi.fn(async ({ where }) => loans.get(where.loanId.toString()) || null),
        upsert: vi.fn(async ({ where, create, update }) => {
          const key = where.loanId.toString();
          const existing = loans.get(key);
          if (existing) {
            const updated = { ...existing, ...update };
            loans.set(key, updated);
            return updated;
          } else {
            loans.set(key, create);
            return create;
          }
        }),
        update: vi.fn(async ({ where, data }) => {
          const key = where.loanId.toString();
          const existing = loans.get(key);
          const updated = { ...existing, ...data };
          loans.set(key, updated);
          return updated;
        }),
        deleteMany: vi.fn(async () => loans.clear()),
      },
      poolDeposit: {
        findUnique: vi.fn(async ({ where }) => poolDeposits.get(where.merchant) || null),
        upsert: vi.fn(async ({ where, create, update }) => {
          const existing = poolDeposits.get(where.merchant);
          if (existing) {
            const updated = { ...existing, ...update };
            poolDeposits.set(where.merchant, updated);
            return updated;
          } else {
            poolDeposits.set(where.merchant, create);
            return create;
          }
        }),
        deleteMany: vi.fn(async () => poolDeposits.clear()),
      },
      chainEvent: {
        findUnique: vi.fn(async ({ where }) => {
          const key = `${where.txHash_logIndex.txHash}_${where.txHash_logIndex.logIndex}`;
          return chainEvents.get(key) || null;
        }),
        create: vi.fn(async ({ data }) => {
          const key = `${data.txHash}_${data.logIndex}`;
          chainEvents.set(key, data);
          return data;
        }),
        findMany: vi.fn(async () => Array.from(chainEvents.values())),
        deleteMany: vi.fn(async () => chainEvents.clear()),
        count: vi.fn(async () => chainEvents.size),
      },
      walletBinding: {
        findUnique: vi.fn(async ({ where }) => walletBindings.get(where.walletAddress) || null),
      },
      user: {
        update: vi.fn(async ({ where, data }) => {
          const existing = users.get(where.id);
          const updated = { ...existing, ...data };
          users.set(where.id, updated);
          return updated;
        }),
      },
      indexerCheckpoint: {
        findUnique: vi.fn(async () => ({ id: "singleton", lastProcessedBlock: checkpointBlock, updatedAt: new Date() })),
        upsert: vi.fn(async ({ create, update }) => {
          checkpointBlock = update?.lastProcessedBlock || create?.lastProcessedBlock;
          return { id: "singleton", lastProcessedBlock: checkpointBlock, updatedAt: new Date() };
        }),
      },
    };
  });

  describe("Single Event State Projections", () => {
    it("CreditMinted: increments borrower creditUnits by exact amount", async () => {
      const log: DecodedChainLog = {
        txHash: "0x1111",
        logIndex: 0,
        eventName: "CreditMinted",
        blockNumber: 100n,
        blockTimestamp: 1700000000n,
        args: {
          user: "0xUser1",
          amount: 1000000000n, // 1,000 USDC
          reason: "0x00",
        },
      };

      const result = await projectChainLog(mockClient, log);
      expect(result.processed).toBe(true);

      const balance = creditBalances.get("0xuser1");
      expect(balance).toBeDefined();
      expect(balance?.creditUnits).toBe("1000000000");
      expect(balance?.lockedCreditUnits).toBe("0");
    });

    it("CreditBurned: decrements user creditUnits safely without touching locked credit", async () => {
      // Set initial credit of 1,000
      creditBalances.set("0xuser1", { creditUnits: "1000000000", lockedCreditUnits: "200000000", lastUpdatedBlock: 50n });

      const log: DecodedChainLog = {
        txHash: "0x2222",
        logIndex: 0,
        eventName: "CreditBurned",
        blockNumber: 101n,
        blockTimestamp: 1700000100n,
        args: {
          user: "0xUser1",
          amount: 400000000n, // Debit 400 USDC
          reason: "0x00",
        },
      };

      await projectChainLog(mockClient, log);

      const balance = creditBalances.get("0xuser1");
      expect(balance?.creditUnits).toBe("600000000"); // 1,000 - 400 = 600
      expect(balance?.lockedCreditUnits).toBe("200000000"); // Unaltered
    });

    it("Spent: atomically transfers credit from buyer to merchant", async () => {
      creditBalances.set("0xuser1", { creditUnits: "500000000", lockedCreditUnits: "0", lastUpdatedBlock: 50n });
      creditBalances.set("0xmerchant1", { creditUnits: "100000000", lockedCreditUnits: "0", lastUpdatedBlock: 50n });

      const log: DecodedChainLog = {
        txHash: "0x3333",
        logIndex: 1,
        eventName: "Spent",
        blockNumber: 102n,
        blockTimestamp: 1700000200n,
        args: {
          user: "0xUser1",
          merchant: "0xMerchant1",
          amount: 250000000n, // 250 USDC
        },
      };

      await projectChainLog(mockClient, log);

      expect(creditBalances.get("0xuser1")?.creditUnits).toBe("250000000"); // 500 - 250
      expect(creditBalances.get("0xmerchant1")?.creditUnits).toBe("350000000"); // 100 + 250
    });

    it("LoanOpened: registers active loan and locks exact collateral", async () => {
      creditBalances.set("0xborrower1", { creditUnits: "1250000000", lockedCreditUnits: "0", lastUpdatedBlock: 50n });

      const log: DecodedChainLog = {
        txHash: "0x4444",
        logIndex: 0,
        eventName: "LoanOpened",
        blockNumber: 103n,
        blockTimestamp: 1700000300n,
        args: {
          loanId: 1n,
          borrower: "0xBorrower1",
          principal: 1000000000n, // 1,000 USDC principal
          collateral: 1250000000n, // 1,250 USDC collateral (1.25x)
          dueDate: 1700604800n,
        },
      };

      await projectChainLog(mockClient, log);

      const loan = loans.get("1");
      expect(loan).toBeDefined();
      expect(loan.status).toBe("ACTIVE");
      expect(loan.principalUnits).toBe("1000000000");
      expect(loan.collateralUnits).toBe("1250000000");
      expect(loan.extensionCount).toBe(0);

      const borrowerBalance = creditBalances.get("0xborrower1");
      expect(borrowerBalance?.lockedCreditUnits).toBe("1250000000");
    });

    it("LoanExtended: updates loan due date and marks extensionCount", async () => {
      loans.set("1", {
        loanId: 1n,
        borrower: "0xborrower1",
        principalUnits: "1000000000",
        collateralUnits: "1250000000",
        dueDate: 1700604800n,
        status: "ACTIVE",
        extensionCount: 0,
      });

      const log: DecodedChainLog = {
        txHash: "0x5555",
        logIndex: 0,
        eventName: "LoanExtended",
        blockNumber: 104n,
        blockTimestamp: 1700000400n,
        args: {
          loanId: 1n,
          newDueDate: 1701209600n,
          extensionCount: 1,
        },
      };

      await projectChainLog(mockClient, log);

      const loan = loans.get("1");
      expect(loan.extensionCount).toBe(1);
      expect(loan.dueDate).toBe(1701209600n);
    });

    it("LoanRepaid: marks loan REPAID and unlocks collateral", async () => {
      loans.set("1", {
        loanId: 1n,
        borrower: "0xborrower1",
        principalUnits: "1000000000",
        collateralUnits: "1250000000",
        dueDate: 1701209600n,
        status: "ACTIVE",
        extensionCount: 1,
      });
      creditBalances.set("0xborrower1", { creditUnits: "1250000000", lockedCreditUnits: "1250000000", lastUpdatedBlock: 50n });

      const log: DecodedChainLog = {
        txHash: "0x6666",
        logIndex: 0,
        eventName: "LoanRepaid",
        blockNumber: 105n,
        blockTimestamp: 1700000500n,
        args: {
          loanId: 1n,
          borrower: "0xBorrower1",
          principal: 1000000000n,
        },
      };

      await projectChainLog(mockClient, log);

      expect(loans.get("1").status).toBe("REPAID");
      expect(creditBalances.get("0xborrower1")?.lockedCreditUnits).toBe("0"); // Collateral released
    });

    it("LoanDefaulted: marks loan DEFAULTED, releases locked credit and burns credit", async () => {
      loans.set("2", {
        loanId: 2n,
        borrower: "0xborrower2",
        principalUnits: "800000000",
        collateralUnits: "1000000000",
        dueDate: 1700000000n,
        status: "ACTIVE",
        extensionCount: 0,
      });
      creditBalances.set("0xborrower2", { creditUnits: "1000000000", lockedCreditUnits: "1000000000", lastUpdatedBlock: 50n });

      const log: DecodedChainLog = {
        txHash: "0x7777",
        logIndex: 0,
        eventName: "LoanDefaulted",
        blockNumber: 106n,
        blockTimestamp: 1700000600n,
        args: {
          loanId: 2n,
          borrower: "0xBorrower2",
          principal: 800000000n,
          collateral: 1000000000n,
          caller: "0xKeeper",
        },
      };

      await projectChainLog(mockClient, log);

      expect(loans.get("2").status).toBe("DEFAULTED");
      expect(creditBalances.get("0xborrower2")?.lockedCreditUnits).toBe("0");
      expect(creditBalances.get("0xborrower2")?.creditUnits).toBe("0"); // Collateral forfeited
    });

    it("Deposited & Withdrawn: tracks pool merchant shares accurately", async () => {
      // 1. Deposit
      const depositLog: DecodedChainLog = {
        txHash: "0x8888",
        logIndex: 0,
        eventName: "Deposited",
        blockNumber: 107n,
        blockTimestamp: 1700000700n,
        args: {
          merchant: "0xMerchantPool",
          assets: 5000000000n,
          shares: 5000000000n,
        },
      };

      await projectChainLog(mockClient, depositLog);
      expect(poolDeposits.get("0xmerchantpool")?.shares).toBe("5000000000");

      // 2. Partial Withdraw
      const withdrawLog: DecodedChainLog = {
        txHash: "0x9999",
        logIndex: 0,
        eventName: "Withdrawn",
        blockNumber: 108n,
        blockTimestamp: 1700000800n,
        args: {
          merchant: "0xMerchantPool",
          assets: 2000000000n,
          shares: 2000000000n,
        },
      };

      await projectChainLog(mockClient, withdrawLog);
      expect(poolDeposits.get("0xmerchantpool")?.shares).toBe("3000000000"); // 5,000 - 2,000
    });

    it("AccountMoved: moves entire credit to new wallet and zeroes old wallet (D-64)", async () => {
      creditBalances.set("0xoldwallet", { creditUnits: "750000000", lockedCreditUnits: "0", lastUpdatedBlock: 50n });

      const log: DecodedChainLog = {
        txHash: "0xaaaa",
        logIndex: 0,
        eventName: "AccountMoved",
        blockNumber: 109n,
        blockTimestamp: 1700000900n,
        args: {
          oldWallet: "0xOldWallet",
          newWallet: "0xNewWallet",
          accountRef: "0x00",
          creditMoved: 750000000n,
        },
      };

      await projectChainLog(mockClient, log);

      expect(creditBalances.get("0xoldwallet")?.creditUnits).toBe("0");
      expect(creditBalances.get("0xnewwallet")?.creditUnits).toBe("750000000");
    });
  });

  describe("Idempotency & Replay Invariants (PRD §2)", () => {
    it("rejects duplicate log execution without altering state", async () => {
      const log: DecodedChainLog = {
        txHash: "0xbbbb",
        logIndex: 0,
        eventName: "CreditMinted",
        blockNumber: 110n,
        blockTimestamp: 1700001000n,
        args: {
          user: "0xUserDup",
          amount: 500000000n,
          reason: "0x00",
        },
      };

      // First execution
      const first = await projectChainLog(mockClient, log);
      expect(first.processed).toBe(true);
      expect(creditBalances.get("0xuserdup")?.creditUnits).toBe("500000000");

      // Duplicate execution of exact same txHash and logIndex
      const second = await projectChainLog(mockClient, log);
      expect(second.processed).toBe(false);
      expect(second.reason).toBe("Already indexed");

      // Balance remains strictly 500,000,000 (never double-minted)
      expect(creditBalances.get("0xuserdup")?.creditUnits).toBe("500000000");
    });

    it("replayAllEvents produces identical state from raw chain_events (PRD §2)", async () => {
      // Simulate historical sequence of transactions
      const sequence: DecodedChainLog[] = [
        {
          txHash: "0xseq1",
          logIndex: 0,
          eventName: "CreditMinted",
          blockNumber: 200n,
          blockTimestamp: 1700000000n,
          args: { user: "0xAlice", amount: 2000000000n, reason: "0x01" },
        },
        {
          txHash: "0xseq2",
          logIndex: 0,
          eventName: "Spent",
          blockNumber: 201n,
          blockTimestamp: 1700000010n,
          args: { user: "0xAlice", merchant: "0xBobMerchant", amount: 500000000n },
        },
        {
          txHash: "0xseq3",
          logIndex: 0,
          eventName: "LoanOpened",
          blockNumber: 202n,
          blockTimestamp: 1700000020n,
          args: { loanId: 10n, borrower: "0xAlice", principal: 800000000n, collateral: 1000000000n, dueDate: 1700600000n },
        },
        {
          txHash: "0xseq4",
          logIndex: 0,
          eventName: "Deposited",
          blockNumber: 203n,
          blockTimestamp: 1700000030n,
          args: { merchant: "0xBobMerchant", assets: 500000000n, shares: 500000000n },
        },
      ];

      // Run sequence through projector
      for (const log of sequence) {
        await projectChainLog(mockClient, log);
      }

      // Snapshot projected state
      const preReplayAlice = { ...creditBalances.get("0xalice") };
      const preReplayBob = { ...creditBalances.get("0xbobmerchant") };
      const preReplayLoan = { ...loans.get("10") };
      const preReplayBobShares = { ...poolDeposits.get("0xbobmerchant") };

      expect(preReplayAlice.creditUnits).toBe("1500000000"); // 2,000 - 500
      expect(preReplayAlice.lockedCreditUnits).toBe("1000000000"); // 1,000 locked
      expect(preReplayBob.creditUnits).toBe("500000000");
      expect(preReplayLoan.status).toBe("ACTIVE");
      expect(preReplayBobShares.shares).toBe("500000000");

      // WIPE read models completely
      creditBalances.clear();
      loans.clear();
      poolDeposits.clear();

      expect(creditBalances.size).toBe(0);
      expect(loans.size).toBe(0);
      expect(poolDeposits.size).toBe(0);

      // Replay all events from chain_events
      const eventsToReplay = Array.from(chainEvents.values()).map((e) => ({
        txHash: e.txHash,
        logIndex: e.logIndex,
        eventName: e.eventName,
        blockNumber: e.blockNumber,
        blockTimestamp: e.blockTimestamp,
        args: e.data,
      }));

      // Clear chain_events for clean re-insertion
      chainEvents.clear();

      for (const log of eventsToReplay) {
        await projectChainLog(mockClient, log);
      }

      // Post-replay assertions: exact match with pre-replay state
      expect(creditBalances.get("0xalice")?.creditUnits).toBe(preReplayAlice.creditUnits);
      expect(creditBalances.get("0xalice")?.lockedCreditUnits).toBe(preReplayAlice.lockedCreditUnits);
      expect(creditBalances.get("0xbobmerchant")?.creditUnits).toBe(preReplayBob.creditUnits);
      expect(loans.get("10")?.status).toBe(preReplayLoan.status);
      expect(loans.get("10")?.principalUnits).toBe(preReplayLoan.principalUnits);
      expect(loans.get("10")?.collateralUnits).toBe(preReplayLoan.collateralUnits);
      expect(poolDeposits.get("0xbobmerchant")?.shares).toBe(preReplayBobShares.shares);
    });
  });
});
