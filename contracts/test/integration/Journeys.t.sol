// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {Fixture} from "../helpers/Fixture.sol";

/// @notice The five integration journeys (TS 2.5), on the mock token. Each runs a whole story
///         and asserts the end state of every actor, not just the last call: every credit, lock,
///         share, USDC balance and pool total. From `Fixture`: alice and bob approved users who
///         signed, merchantA and merchantB approved merchants who signed, each holding `FUND`.
contract JourneysTest is Fixture {
    /// @dev Every actor's USDC, credit and lock, and the pool's books, in one call.
    function _assertActor(address a, uint256 usdcBal, uint256 cred, uint256 locked, uint256 sh)
        internal
        view
    {
        assertEq(usdc.balanceOf(a), usdcBal, "usdc");
        assertEq(ledger.credit(a), cred, "credit");
        assertEq(ledger.lockedCredit(a), locked, "locked");
        assertEq(ledger.shares(a), sh, "shares");
    }

    function _assertPool(
        uint256 poolUsdc,
        uint256 lent,
        uint256 totalShares,
        uint256 totalCredit,
        uint256 poolCredit
    ) internal view {
        assertEq(ledger.poolUsdc(), poolUsdc, "poolUsdc");
        assertEq(ledger.totalLent(), lent, "totalLent");
        assertEq(ledger.totalShares(), totalShares, "totalShares");
        assertEq(ledger.totalCredit(), totalCredit, "totalCredit");
        assertEq(ledger.poolCredit(), poolCredit, "poolCredit");
        assertEq(usdc.balanceOf(address(ledger)), poolUsdc, "the books balance (I14)");
    }

    /// @notice 1. A merchant deposits; a user registers an asset, borrows, spends the rest of
    ///         the credit, repays; the merchant withdraws everything.
    function test_journey1_borrowSpendRepayWithdraw() public {
        _deposit(merchantA, 10_000e6);
        vm.prank(alice);
        ledger.registerAsset(keccak256("j1-doc"), 3, 2_000e6);
        vm.prank(alice);
        uint256 id = ledger.requestLoan(800e6); // locks 1,000
        vm.prank(alice);
        ledger.spend(merchantB, 1_000e6); // all that is not locked
        vm.warp(vm.getBlockTimestamp() + 45 days);
        vm.prank(alice);
        ledger.repay(id);
        vm.prank(merchantA);
        ledger.withdrawAll();

        _assertActor(alice, FUND, 1_000e6, 0, 0);
        _assertActor(merchantA, FUND, 0, 0, 0);
        _assertActor(merchantB, FUND, 1_000e6, 0, 0); // paid in credit, no fee
        _assertActor(bob, FUND, 0, 0, 0);
        _assertPool(0, 0, 0, 2_000e6, 0);
    }

    /// @notice 2. Two users, two merchants, overlapping loans, one default: both merchants
    ///         withdraw and share the loss in proportion to their deposits.
    function test_journey2_overlappingLoans_oneDefault_lossShared() public {
        _deposit(merchantA, 6_000e6);
        _deposit(merchantB, 4_000e6);
        _mintCredit(alice, 2_500e6);
        _mintCredit(bob, 1_250e6);
        vm.prank(alice);
        uint256 a = ledger.requestLoan(2_000e6); // locks 2,500
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.prank(bob);
        uint256 b = ledger.requestLoan(1_000e6); // locks 1,250, overlapping alice's

        vm.warp(vm.getBlockTimestamp() + 40 days);
        vm.prank(bob);
        ledger.repay(b);
        (, uint64 due,,,,) = ledger.loans(a);
        vm.warp(uint256(due) + 1);
        vm.prank(merchantB);
        ledger.liquidate(a); // anyone may (D-07)

        vm.prank(merchantA);
        ledger.withdrawAll();
        vm.prank(merchantB);
        ledger.withdrawAll();

        // 10,000 deposited, 2,000 lost: 8,000 left, split 60/40 rounded down (D-38).
        assertApproxEqAbs(usdc.balanceOf(merchantA), FUND - 6_000e6 + 4_800e6, 1, "merchantA");
        assertApproxEqAbs(usdc.balanceOf(merchantB), FUND - 4_000e6 + 3_200e6, 1, "merchantB");
        assertLe(usdc.balanceOf(merchantA) + usdc.balanceOf(merchantB), 2 * FUND - 2_000e6);
        _assertActor(alice, FUND + 2_000e6, 0, 0, 0); // kept the USDC, lost the collateral
        _assertActor(bob, FUND, 1_250e6, 0, 0);
        assertLe(ledger.poolUsdc(), 2, "only rounding dust can stay");
        assertEq(ledger.totalLent(), 0);
        assertEq(ledger.poolCredit(), 2_500e6);
        assertEq(ledger.totalCredit(), 1_250e6);
    }

    /// @notice 3. A user borrows the maximum, extends four times over a year, then repays.
    function test_journey3_borrowMax_extendFourTimes_repay() public {
        _deposit(merchantA, 10_000e6);
        _mintCredit(alice, 5_000e6);
        uint256 most = ledger.maxBorrow(alice);
        vm.prank(alice);
        uint256 id = ledger.requestLoan(most);
        (, uint64 first,,,,) = ledger.loans(id);
        for (uint256 i; i < 4; i++) {
            (, uint64 due,,,,) = ledger.loans(id);
            vm.warp(uint256(due) - 10 days); // inside the window
            vm.prank(alice);
            ledger.extend(id);
        }
        (, uint64 last, uint16 count,,,) = ledger.loans(id);
        assertEq(count, 4);
        assertEq(last, first + 4 * 90 days, "each extension adds 90 days to the due date");
        vm.warp(uint256(last) - 1 days); // repaid the day before the last due date: about a year
        assertEq(vm.getBlockTimestamp(), uint256(first) + 359 days, "449 days after borrowing");

        vm.prank(alice);
        ledger.repay(id);
        _assertActor(alice, FUND, 5_000e6, 0, 0);
        _assertActor(merchantA, FUND - 10_000e6, 0, 0, 10_000e6 * 1e6);
        _assertPool(10_000e6, 0, 10_000e6 * 1e6, 5_000e6, 0);
    }

    /// @notice 4. The admin issues credit for a direct payment, the user spends it, and the admin
    ///         records cash settlements by debiting the user and the paid merchant (D-63).
    function test_journey4_directPayment_spend_cashSettlement() public {
        vm.prank(admin);
        ledger.adminIssueCredit(alice, 3_000e6, keccak256("payment-ref-1"));
        vm.prank(alice);
        ledger.spend(merchantA, 1_200e6);
        vm.prank(admin);
        ledger.adminDebitCredit(alice, 500e6, keccak256("cash-ref-1"));
        vm.prank(admin);
        ledger.adminDebitCredit(merchantA, 1_200e6, keccak256("cash-ref-2"));

        _assertActor(alice, FUND, 1_300e6, 0, 0);
        _assertActor(merchantA, FUND, 0, 0, 0);
        _assertActor(bob, FUND, 0, 0, 0);
        _assertPool(0, 0, 0, 1_300e6, 0);
    }

    /// @notice 5. A pause mid-journey: every user action is refused, the admin's setters still
    ///         work, the guardian unpauses and the journey resumes; a loan due during the pause
    ///         is protected by the grace and can still be extended (D-54, D-58).
    function test_journey5_pauseMidJourney_resumes() public {
        _deposit(merchantA, 10_000e6);
        _mintCredit(alice, 2_000e6);
        vm.prank(alice);
        uint256 id = ledger.requestLoan(1_000e6);
        (, uint64 due,,,,) = ledger.loans(id);

        _pause();
        bytes memory paused = abi.encodeWithSelector(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        vm.expectRevert(paused);
        ledger.spend(merchantA, 1);
        vm.prank(alice);
        vm.expectRevert(paused);
        ledger.repay(id);
        vm.prank(merchantA);
        vm.expectRevert(paused);
        ledger.withdrawAll();
        vm.prank(alice);
        vm.expectRevert(paused);
        ledger.requestLoan(1);
        vm.prank(admin); // setters work while paused (D-24)
        ledger.setMerchantApproved(merchantB, false);

        vm.warp(uint256(due) + 3 days); // the loan falls due during the pause
        vm.prank(guardian);
        ledger.unpause();
        vm.expectRevert(
            abi.encodeWithSelector(
                IIndicoLedger.LiquidationGracePeriod.selector, vm.getBlockTimestamp() + 7 days
            )
        );
        ledger.liquidate(id);
        vm.prank(alice);
        ledger.extend(id); // late extension inside the grace (D-58)
        vm.prank(alice);
        ledger.repay(id);
        vm.prank(merchantA);
        ledger.withdrawAll();

        _assertActor(alice, FUND, 2_000e6, 0, 0);
        _assertActor(merchantA, FUND, 0, 0, 0);
        assertFalse(ledger.approvedMerchant(merchantB));
        _assertPool(0, 0, 0, 2_000e6, 0);
    }
}
