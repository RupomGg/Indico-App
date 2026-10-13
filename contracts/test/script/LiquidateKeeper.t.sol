// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fixture} from "../helpers/Fixture.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {IndicoLedger} from "../../src/IndicoLedger.sol";
import {LiquidateKeeper} from "../../script/LiquidateKeeper.s.sol";
import {TERM, LIQUIDATION_GRACE} from "../../src/lib/Constants.sol";

/// @notice Test suite for the Liquidation Keeper script (P3.2).
///         Tests loan inspection, grace periods, pause checks, idempotency,
///         concurrency safety, batch execution, and chain resolution.
contract LiquidateKeeperTest is Fixture {
    LiquidateKeeper internal keeper;

    uint256 internal constant BORROW_AMT = 800e6;

    function setUp() public virtual override {
        super.setUp();
        keeper = new LiquidateKeeper();
    }

    function _typedLedger() internal view returns (IndicoLedger) {
        return IndicoLedger(address(ledger));
    }

    function test_isLiquidatable_unopenedLoan_returnsFalse() public view {
        assertFalse(keeper.isLiquidatable(_typedLedger(), 0));
        assertFalse(keeper.isLiquidatable(_typedLedger(), 1));
        assertFalse(keeper.isLiquidatable(_typedLedger(), 999));
    }

    function test_isLiquidatable_activeNotDue_returnsFalse() public {
        uint256 loanId = _openLoan(alice, BORROW_AMT);
        assertFalse(keeper.isLiquidatable(_typedLedger(), loanId));

        (, uint64 dueDate,,,,) = ledger.loans(loanId);
        vm.warp(dueDate);
        assertFalse(keeper.isLiquidatable(_typedLedger(), loanId));
    }

    function test_isLiquidatable_activeOverdue_returnsTrue() public {
        uint256 loanId = _openLoan(alice, BORROW_AMT);
        (, uint64 dueDate,,,,) = ledger.loans(loanId);

        vm.warp(uint256(dueDate) + 1);
        assertTrue(keeper.isLiquidatable(_typedLedger(), loanId));
    }

    function test_isLiquidatable_duringGrace_returnsFalse() public {
        uint256 loanId = _openLoan(alice, BORROW_AMT);
        (, uint64 dueDate,,,,) = ledger.loans(loanId);

        // Pause then unpause to establish an active grace period
        vm.warp(uint256(dueDate) + 1);
        _pause();
        vm.prank(guardian);
        ledger.unpause();

        // Right now block.timestamp == lastUnpausedAt <= lastUnpausedAt + LIQUIDATION_GRACE
        assertFalse(keeper.isLiquidatable(_typedLedger(), loanId));

        // Advance past grace
        vm.warp(block.timestamp + LIQUIDATION_GRACE + 1);
        assertTrue(keeper.isLiquidatable(_typedLedger(), loanId));
    }

    function test_isLiquidatable_whilePaused_returnsFalse() public {
        uint256 loanId = _openLoan(alice, BORROW_AMT);
        (, uint64 dueDate,,,,) = ledger.loans(loanId);

        vm.warp(uint256(dueDate) + 10);
        assertTrue(keeper.isLiquidatable(_typedLedger(), loanId));

        _pause();
        assertFalse(keeper.isLiquidatable(_typedLedger(), loanId));
    }

    function test_isLiquidatable_repaidLoan_returnsFalse() public {
        uint256 loanId = _openLoan(alice, BORROW_AMT);
        (, uint64 dueDate,,,,) = ledger.loans(loanId);

        vm.prank(alice);
        ledger.repay(loanId);

        vm.warp(uint256(dueDate) + 1);
        assertFalse(keeper.isLiquidatable(_typedLedger(), loanId));
    }

    function test_isLiquidatable_defaultedLoan_returnsFalse() public {
        uint256 loanId = _openLoan(alice, BORROW_AMT);
        (, uint64 dueDate,,,,) = ledger.loans(loanId);

        vm.warp(uint256(dueDate) + 1);
        ledger.liquidate(loanId);

        assertFalse(keeper.isLiquidatable(_typedLedger(), loanId));
    }

    function test_findOverdueLoans_emptyLedger_returnsEmpty() public view {
        uint256[] memory overdue = keeper.findOverdueLoans(_typedLedger());
        assertEq(overdue.length, 0);
    }

    function test_findOverdueLoans_mixedLoans_returnsOnlyOverdue() public {
        // Loan 1: Alice, overdue
        uint256 id1 = _openLoan(alice, BORROW_AMT);
        // Loan 2: Bob, will be repaid
        uint256 id2 = _openLoan(bob, BORROW_AMT);

        (, uint64 due1,,,,) = ledger.loans(id1);

        // Warp halfway, open Loan 3 (Alice again, not yet due)
        vm.warp(uint256(due1) - 10 days);
        _openLoan(alice, BORROW_AMT);

        // Repay loan 2
        vm.prank(bob);
        ledger.repay(id2);

        // Warp past Loan 1 dueDate, but before Loan 3 dueDate
        vm.warp(uint256(due1) + 1);

        uint256[] memory overdue = keeper.findOverdueLoans(_typedLedger());
        assertEq(overdue.length, 1);
        assertEq(overdue[0], id1);
    }

    function test_findOverdueLoans_boundedRange() public {
        uint256 id1 = _openLoan(alice, BORROW_AMT);
        uint256 id2 = _openLoan(bob, BORROW_AMT);
        (, uint64 due,,,,) = ledger.loans(id1);

        vm.warp(uint256(due) + 1);

        // Range [1, 1]
        uint256[] memory overdue1 = keeper.findOverdueLoans(_typedLedger(), 1, 1);
        assertEq(overdue1.length, 1);
        assertEq(overdue1[0], id1);

        // Range [2, 2]
        uint256[] memory overdue2 = keeper.findOverdueLoans(_typedLedger(), 2, 2);
        assertEq(overdue2.length, 1);
        assertEq(overdue2[0], id2);

        // Range [1, 2]
        uint256[] memory overdueAll = keeper.findOverdueLoans(_typedLedger(), 1, 2);
        assertEq(overdueAll.length, 2);

        // Invalid or out-of-range bounds
        uint256[] memory empty1 = keeper.findOverdueLoans(_typedLedger(), 3, 5);
        assertEq(empty1.length, 0);
        uint256[] memory empty2 = keeper.findOverdueLoans(_typedLedger(), 2, 1);
        assertEq(empty2.length, 0);
    }

    function test_liquidateSafe_overdueLoan_succeeds() public {
        uint256 loanId = _openLoan(alice, BORROW_AMT);
        (, uint64 due,,,,) = ledger.loans(loanId);

        vm.warp(uint256(due) + 1);

        bool success = keeper.liquidateSafe(_typedLedger(), loanId);
        assertTrue(success);

        (,,, uint8 status,,) = ledger.loans(loanId);
        assertEq(status, uint8(IIndicoLedger.LoanStatus.Defaulted));
    }

    function test_liquidateSafe_alreadyLiquidated_idempotent() public {
        uint256 loanId = _openLoan(alice, BORROW_AMT);
        (, uint64 due,,,,) = ledger.loans(loanId);

        vm.warp(uint256(due) + 1);

        // First execution succeeds
        bool first = keeper.liquidateSafe(_typedLedger(), loanId);
        assertTrue(first);

        // Second execution returns false safely without reverting
        bool second = keeper.liquidateSafe(_typedLedger(), loanId);
        assertFalse(second);
    }

    function test_liquidateSafe_notDueOrRepaid_returnsFalse() public {
        uint256 loanId = _openLoan(alice, BORROW_AMT);
        // Not due yet
        assertFalse(keeper.liquidateSafe(_typedLedger(), loanId));

        // Repaid
        vm.prank(alice);
        ledger.repay(loanId);
        assertFalse(keeper.liquidateSafe(_typedLedger(), loanId));
    }

    function test_liquidateAll_liquidatesAllOverdue() public {
        uint256 id1 = _openLoan(alice, BORROW_AMT);
        uint256 id2 = _openLoan(bob, BORROW_AMT);
        (, uint64 due,,,,) = ledger.loans(id1);

        vm.warp(uint256(due) + 1);

        uint256 liquidated = keeper.liquidateAll(_typedLedger());
        assertEq(liquidated, 2);

        (,,, uint8 s1,,) = ledger.loans(id1);
        (,,, uint8 s2,,) = ledger.loans(id2);
        assertEq(s1, uint8(IIndicoLedger.LoanStatus.Defaulted));
        assertEq(s2, uint8(IIndicoLedger.LoanStatus.Defaulted));
    }

    function test_liquidateAll_idempotent_runsTwiceSafely() public {
        _openLoan(alice, BORROW_AMT);
        _openLoan(bob, BORROW_AMT);
        (, uint64 due,,,,) = ledger.loans(1);

        vm.warp(uint256(due) + 1);

        // First run liquidates 2
        uint256 first = keeper.liquidateAll(_typedLedger());
        assertEq(first, 2);

        // Immediate second run liquidates 0, exits cleanly
        uint256 second = keeper.liquidateAll(_typedLedger());
        assertEq(second, 0);
    }

    function test_liquidateBatch_liquidatesSelected() public {
        uint256 id1 = _openLoan(alice, BORROW_AMT);
        uint256 id2 = _openLoan(bob, BORROW_AMT);
        (, uint64 due,,,,) = ledger.loans(id1);

        vm.warp(uint256(due) + 1);

        uint256[] memory batch = new uint256[](1);
        batch[0] = id1;

        uint256 liquidated = keeper.liquidateBatch(_typedLedger(), batch);
        assertEq(liquidated, 1);

        (,,, uint8 s1,,) = ledger.loans(id1);
        (,,, uint8 s2,,) = ledger.loans(id2);
        assertEq(s1, uint8(IIndicoLedger.LoanStatus.Defaulted));
        assertEq(s2, uint8(IIndicoLedger.LoanStatus.Active));
    }

    function test_run_executesWithEnvLedger() public {
        uint256 loanId = _openLoan(alice, BORROW_AMT);
        (, uint64 due,,,,) = ledger.loans(loanId);

        vm.warp(uint256(due) + 1);

        vm.setEnv("LEDGER_ADDRESS", vm.toString(address(ledger)));
        uint256 liquidated = keeper.run();
        assertEq(liquidated, 1);

        (,,, uint8 s,,) = ledger.loans(loanId);
        assertEq(s, uint8(IIndicoLedger.LoanStatus.Defaulted));
        vm.setEnv("LEDGER_ADDRESS", vm.toString(address(0)));
    }

    function test_run_unknownChain_reverts() public {
        vm.setEnv("LEDGER_ADDRESS", vm.toString(address(0)));
        vm.chainId(1); // Mainnet without env
        vm.expectRevert(
            abi.encodeWithSelector(LiquidateKeeper.UnknownLedgerForChain.selector, uint256(1))
        );
        keeper.run();
    }
}
