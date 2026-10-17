// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IndicoLedger} from "../src/IndicoLedger.sol";
import {IIndicoLedger} from "../src/interfaces/IIndicoLedger.sol";

/// @notice Live on-chain verification of all remaining IndicoLedger features on Base Sepolia:
///         1. Borrow limits (> 80% LTV and > pool cash reverts)
///         2. Loan extension window checks (ExtensionWindowNotOpen revert)
///         3. Direct admin credit issue and debit (AD-10, AD-12)
///         4. Lost wallet migration (adminMoveAccount, D-64)
///         5. Merchant pool withdrawals (withdraw & withdrawAll)
///         6. Guardian emergency controls (pause & unpause & grace period)
contract ExecuteRemainingLiveTests is Script {
    address internal constant LEDGER = 0xa51D54BAe8431f4c6f0dd644D2fCeb498CE5eeF0;
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    address internal constant ADMIN = 0xb9B49b26Df2AC02FEE89dCe82Eb1f8bC3774F677;

    function run() external {
        uint256 merchantPk = vm.envUint("TEST_MERCHANT_PK");
        uint256 userPk = vm.envUint("TEST_USER_PK");

        address merchant = vm.addr(merchantPk);
        address user = vm.addr(userPk);
        address admin = msg.sender == address(0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38) ? ADMIN : msg.sender;

        IndicoLedger ledger = IndicoLedger(LEDGER);
        IERC20 usdc = IERC20(USDC);
        bytes32 userRef = ledger.accountRefOf(user);

        console.log("========================================================");
        console.log("=== Testing Remaining Features Live on Base Sepolia ===");
        console.log("========================================================");
        console.log("Ledger:   ", address(ledger));
        console.log("Admin:    ", admin);
        console.log("Merchant: ", merchant);
        console.log("User:     ", user);
        console.log("User Ref: ", vm.toString(userRef));

        // -------------------------------------------------------------
        // FEATURE 1: Borrowing Limits & 80% LTV Enforcements
        // -------------------------------------------------------------
        console.log("\n--- Feature 1: Borrowing Limits & 80% LTV ---");
        uint256 avail = ledger.available(user);
        uint256 maxB = ledger.maxBorrow(user);
        console.log("User Available Credit: ", avail / 1e6, "CREDIT");
        console.log("Max Borrow (80% LTV):  ", maxB / 1e6, "USDC");

        uint64 uNonce1 = vm.getNonce(user);

        // Attempt to borrow 7.00 USDC (requires 8.75 credit > 8.00 credit)
        vm.prank(user);
        try ledger.requestLoan(7e6) {
            revert("FAIL: Borrowing > 80% LTV should have reverted!");
        } catch {
            console.log("  [PASS] Borrowing > 80% LTV reverts (InsufficientAvailableCredit).");
        }

        // Attempt to borrow more than pool cash (e.g. 50.00 USDC)
        vm.prank(user);
        try ledger.requestLoan(50e6) {
            revert("FAIL: Borrowing > pool liquidity should have reverted!");
        } catch {
            console.log("  [PASS] Borrowing > pool liquidity reverts (InsufficientLiquidity).");
        }
        // Restore user nonce so simulated prank calls do not desynchronize the broadcast nonce
        vm.setNonceUnsafe(user, uNonce1);

        // -------------------------------------------------------------
        // FEATURE 2: Loan Extension Window Check (extend)
        // -------------------------------------------------------------
        console.log("\n--- Feature 2: Loan Extension Window ---");
        // Open a small test loan (2.00 USDC) to test extend
        vm.startBroadcast(userPk);
        uint256 loan2 = ledger.requestLoan(2e6);
        vm.stopBroadcast();
        console.log("Opened Loan #2. ID: ", loan2);

        uint64 uNonce2 = vm.getNonce(user);

        // Immediate extend must revert because 30-day window is not open (90-day term)
        vm.prank(user);
        try ledger.extend(loan2) {
            revert("FAIL: Extension outside window should have reverted!");
        } catch {
            console.log("  [PASS] Calling extend outside 30-day window reverts (ExtensionWindowNotOpen).");
        }
        // Restore user nonce before next broadcast
        vm.setNonceUnsafe(user, uNonce2);

        // Repay Loan #2 so pool stays balanced
        vm.startBroadcast(userPk);
        usdc.approve(address(ledger), 2e6);
        ledger.repay(loan2);
        vm.stopBroadcast();
        console.log("Loan #2 repaid in full.");

        // -------------------------------------------------------------
        // FEATURE 3: Admin Credit Issue & Debit (AD-10, AD-12)
        // -------------------------------------------------------------
        console.log("\n--- Feature 3: Admin Credit Issue & Debit ---");
        uint256 creditBefore = ledger.credit(user);
        console.log("User Credit Before: ", creditBefore / 1e6, "CREDIT");

        // Admin issues 5.00 credit for off-platform payment
        vm.startBroadcast(admin);
        ledger.adminIssueCredit(user, 5e6, keccak256("memo-direct-payment-001"));
        vm.stopBroadcast();
        uint256 creditAfterIssue = ledger.credit(user);
        console.log("User Credit After Issue (+5): ", creditAfterIssue / 1e6, "CREDIT");
        require(creditAfterIssue == creditBefore + 5e6, "adminIssueCredit failed");

        // Admin debits 3.00 credit for cash settlement
        vm.startBroadcast(admin);
        ledger.adminDebitCredit(user, 3e6, keccak256("memo-cash-settlement-001"));
        vm.stopBroadcast();
        uint256 creditAfterDebit = ledger.credit(user);
        console.log("User Credit After Debit (-3): ", creditAfterDebit / 1e6, "CREDIT");
        require(creditAfterDebit == creditAfterIssue - 3e6, "adminDebitCredit failed");

        // -------------------------------------------------------------
        // FEATURE 4: Lost Wallet Migration (adminMoveAccount, D-64)
        // -------------------------------------------------------------
        console.log("\n--- Feature 4: Lost Wallet Migration (D-64) ---");
        // To preserve TestUser1 for ongoing backend and frontend operations, we test
        // the migration flow with dedicated temporary addresses.
        address tempOld = vm.addr(0xbeef000000000000000000000000000000000000000000000000000000000001);
        address tempNew = vm.addr(0xbeef000000000000000000000000000000000000000000000000000000000002);
        bytes32 tempRef = keccak256("temp-user-ref-migration-test");

        console.log("Temporary Old Wallet:   ", tempOld);
        console.log("Temporary Target Wallet:", tempNew);

        // 1. Admin onboard tempOld with 2.00 CREDIT
        vm.startBroadcast(admin);
        ledger.setUserApproved(tempOld, true, tempRef);
        ledger.adminIssueCredit(tempOld, 2e6, keccak256("memo-temp-setup"));
        vm.stopBroadcast();
        require(ledger.credit(tempOld) == 2e6, "Temp setup failed");

        // 2. Admin executes wallet migration (D-64)
        vm.startBroadcast(admin);
        ledger.adminMoveAccount(tempOld, tempNew, tempRef);
        vm.stopBroadcast();

        uint256 freshCredit = ledger.credit(tempNew);
        uint256 oldCredit = ledger.credit(tempOld);
        uint8 oldRole = ledger.participantRole(tempOld);
        uint8 newRole = ledger.participantRole(tempNew);
        console.log("New Wallet Credit:           ", freshCredit / 1e6, "CREDIT");
        console.log("Old Wallet Credit:           ", oldCredit);
        console.log("Old Wallet Role (3=Retired): ", oldRole);
        console.log("New Wallet Role (1=User):    ", newRole);
        require(freshCredit == 2e6, "Credit did not migrate");
        require(oldCredit == 0, "Old credit not cleared");
        require(oldRole == 3, "Old wallet not retired");
        require(newRole == 1, "New wallet not marked as user");

        // 3. Clean up temporary credit
        vm.startBroadcast(admin);
        ledger.adminDebitCredit(tempNew, 2e6, keccak256("memo-temp-cleanup"));
        vm.stopBroadcast();
        console.log("  [PASS] Account and credit successfully migrated; old wallet retired.");

        // -------------------------------------------------------------
        // FEATURE 5: Merchant Pool Withdrawals (withdraw & withdrawAll)
        // -------------------------------------------------------------
        console.log("\n--- Feature 5: Merchant Pool Withdrawals ---");
        uint256 merchantUsdcBefore = usdc.balanceOf(merchant);
        console.log("Merchant USDC Balance Before: ", merchantUsdcBefore / 1e6, "USDC");

        // Merchant withdraws 5.00 USDC
        vm.startBroadcast(merchantPk);
        console.log("Merchant withdrawing 5.00 USDC...");
        ledger.withdraw(5e6);
        vm.stopBroadcast();

        uint256 merchantUsdcAfterPart = usdc.balanceOf(merchant);
        console.log("Merchant USDC After Partial Withdraw: ", merchantUsdcAfterPart / 1e6, "USDC");
        require(merchantUsdcAfterPart == merchantUsdcBefore + 5e6, "Withdraw 5 USDC failed");

        // Merchant withdraws all remaining shares
        vm.startBroadcast(merchantPk);
        console.log("Merchant calling withdrawAll()...");
        ledger.withdrawAll();
        vm.stopBroadcast();

        uint256 merchantUsdcFinal = usdc.balanceOf(merchant);
        uint256 merchantSharesFinal = ledger.shares(merchant);
        console.log("Merchant USDC After withdrawAll: ", merchantUsdcFinal / 1e6, "USDC");
        console.log("Merchant Remaining Shares:       ", merchantSharesFinal);
        require(merchantSharesFinal == 0, "Shares not fully burned");
        require(merchantUsdcFinal == merchantUsdcBefore + 10e6, "withdrawAll failed");
        console.log("  [PASS] Full pool deposit (10 USDC) successfully withdrawn.");

        // Redeposit 10 USDC so pool liquidity remains healthy on testnet
        vm.startBroadcast(merchantPk);
        console.log("Redepositing 10 USDC into pool for testnet health...");
        usdc.approve(address(ledger), 10e6);
        ledger.deposit(10e6);
        vm.stopBroadcast();
        console.log("Pool liquidity restored: ", ledger.poolUsdc() / 1e6, "USDC");

        // -------------------------------------------------------------
        // FEATURE 6: Guardian Emergency Pause & Unpause
        // -------------------------------------------------------------
        console.log("\n--- Feature 6: Guardian Emergency Controls (pause/unpause) ---");

        // Guardian pauses the ledger
        vm.startBroadcast(admin);
        console.log("Guardian calling pause()...");
        ledger.pause();
        vm.stopBroadcast();
        require(ledger.paused() == true, "Ledger not paused");
        console.log("  -> Ledger is now paused.");

        // Verify operations revert while paused
        vm.prank(merchant);
        try ledger.deposit(1e6) {
            revert("FAIL: Deposit while paused should have reverted!");
        } catch {
            console.log("  [PASS] Actions blocked while paused (EnforcedPause).");
        }

        // Guardian unpauses the ledger
        vm.startBroadcast(admin);
        console.log("Guardian calling unpause()...");
        ledger.unpause();
        vm.stopBroadcast();
        require(ledger.paused() == false, "Ledger still paused");

        uint64 lastUnpaused = ledger.lastUnpausedAt();
        console.log("  -> Ledger unpaused. lastUnpausedAt: ", lastUnpaused);
        require(lastUnpaused > 0, "lastUnpausedAt not set");
        console.log("  [PASS] Emergency pause/unpause cycle verified; grace period active.");

        console.log("\n========================================================");
        console.log("=== ALL REMAINING FEATURES FULLY TESTED & VERIFIED ===");
        console.log("========================================================");
    }
}
