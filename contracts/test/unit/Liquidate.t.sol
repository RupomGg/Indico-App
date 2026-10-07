// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {TERM, EXTENSION_WINDOW, LIQUIDATION_GRACE} from "../../src/lib/Constants.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice `liquidate`, contract-spec 6.6; PRD R-07, AD-21; D-07 (permissionless), D-54 (grace
///         after an unpause), D-55 (7 days), D-56 (the borrower may call it), D-57 (only
///         `LoanDefaulted`), D-58 (late extension during the grace).
///
/// time t against the loan's due date d, and the last unpause u (0 before any pause)
/// | Class                                | Expected                                       |
/// |--------------------------------------|------------------------------------------------|
/// | t <= d (at open, in the window, = d) | NotYetDue(d)                                   |
/// | t = d + 1, no recent unpause         | defaulted                                      |
/// | after n extensions: t = d_n, d_n + 1 | NotYetDue(d_n), defaulted                      |
/// | d < t <= u + GRACE                   | LiquidationGracePeriod(u + GRACE)              |
/// | t > d and t > u + GRACE              | defaulted                                      |
/// | t <= d and t <= u + GRACE            | NotYetDue(d) (checked first)                   |
/// loanId: 0, one past the end, uint256 max -> LoanNotFound; repaid or defaulted -> LoanNotActive.
/// caller: anyone: the borrower (D-56), another user, a merchant, the admin, the guardian, an
/// unknown address, the ledger and USDC addresses; a revoked borrower's loan too. Paused ->
/// EnforcedPause.
/// Effects: status Defaulted, lockedCredit[b] -= k, credit[b] -= k, totalCredit -= k,
/// poolCredit += k, totalLent -= p; poolUsdc and every USDC balance unchanged; the borrower's
/// available credit unchanged; share price down by exactly p; `LoanDefaulted(id, b, p, k,
/// caller)` and nothing else. After every liquidate, credit >= lockedCredit for every actor.
/// Order: EnforcedPause, LoanNotFound, LoanNotActive, NotYetDue, LiquidationGracePeriod.
/// Every revert: `_revertsUnchanged` (state diff, D-43).
contract LiquidateTest is Actors {
    uint256 internal constant CREDIT = 1_500e6;
    uint256 internal constant POOL = 10_000e6;
    uint256 internal constant P = 800e6;
    uint256 internal constant K = 1_000e6; // collateral of P
    uint64 internal constant START = 1_800_000_000;
    uint256 internal constant DEFAULTED = 2 << 240; // status byte in loan slot 0

    uint64 internal due;

    function setUp() public override {
        super.setUp();
        vm.warp(START);
        _mintCredit(alice, CREDIT);
        _fundPool(POOL);
        vm.prank(alice);
        ledger.requestLoan(P);
        due = START + TERM;
    }

    function _liquidate(address who, uint256 id) internal {
        vm.prank(who);
        ledger.liquidate(id);
    }

    function _call(uint256 id) internal pure returns (bytes memory) {
        return abi.encodeCall(IIndicoLedger.liquidate, (id));
    }

    function _notYetDue(uint64 d) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IIndicoLedger.NotYetDue.selector, d);
    }

    function _grace(uint256 endsAt) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IIndicoLedger.LiquidationGracePeriod.selector, endsAt);
    }

    function _loanSlot(uint256 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(id, SLOT_LOANS));
    }

    function _status(uint256 id) internal view returns (uint8 st) {
        (,,, st,,) = ledger.loans(id);
    }

    function _pauseFromTo(uint256 from, uint256 to) internal {
        vm.warp(from);
        _pause();
        vm.warp(to);
        vm.prank(guardian);
        ledger.unpause();
    }

    function _ledgerLogs(Vm.Log[] memory logs) internal view returns (uint256 k) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(ledger)) ++k;
        }
    }

    /// @dev Credit never falls below the lock, for any actor.
    function _assertCreditCoversLock() internal view {
        for (uint256 i; i < actors.length; ++i) {
            assertGe(ledger.credit(actors[i]), ledger.lockedCredit(actors[i]), "credit < locked");
        }
    }

    // ================================================================== happy path

    function test_liquidate_oneSecondAfterDue_exactEffectsAndEvent() public {
        vm.warp(uint256(due) + 1);
        uint256 aliceUsdc = usdc.balanceOf(alice);
        uint256 held = usdc.balanceOf(address(ledger));
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.LoanDefaulted(1, alice, P, K, bob);
        _liquidate(bob, 1);

        assertEq(_status(1), uint8(IIndicoLedger.LoanStatus.Defaulted));
        assertEq(ledger.lockedCredit(alice), 0, "lock gone");
        assertEq(ledger.credit(alice), CREDIT - K, "collateral burned from credit");
        assertEq(ledger.totalCredit(), CREDIT - K);
        assertEq(ledger.poolCredit(), K, "collateral recorded to the pool");
        assertEq(ledger.totalLent(), 0);
        assertEq(ledger.poolUsdc(), POOL - P, "no USDC comes back");
        assertEq(usdc.balanceOf(alice), aliceUsdc, "borrower keeps the USDC");
        assertEq(usdc.balanceOf(address(ledger)), held);
        assertEq(usdc.balanceOf(bob), FUND, "the caller is paid nothing");
        _assertCreditCoversLock();
    }

    function test_liquidate_emitsOnlyLoanDefaulted() public {
        vm.warp(uint256(due) + 1);
        vm.recordLogs();
        _liquidate(bob, 1);
        assertEq(_ledgerLogs(vm.getRecordedLogs()), 1);
    }

    /// @dev Exactly six net writes, all in the ledger; no USDC slot moves.
    function test_liquidate_exactWrites() public {
        vm.warp(uint256(due) + 1);
        uint256 slot0 = uint256(vm.load(address(ledger), _loanSlot(1)));
        _startDiff();
        _liquidate(bob, 1);
        Write[] memory w = new Write[](6);
        w[0] = _w(address(ledger), _loanSlot(1), slot0 | DEFAULTED);
        w[1] = _w(address(ledger), _key(alice, SLOT_LOCKED_CREDIT), 0);
        w[2] = _w(address(ledger), _key(alice, SLOT_CREDIT), CREDIT - K);
        w[3] = _w(address(ledger), bytes32(SLOT_TOTAL_CREDIT), CREDIT - K);
        w[4] = _w(address(ledger), bytes32(SLOT_POOL_CREDIT), K);
        w[5] = _w(address(ledger), bytes32(SLOT_TOTAL_LENT), 0);
        _assertWrites(w);
    }

    /// @dev The burn takes exactly the locked part: available credit is unchanged, and spending
    ///      afterwards works up to exactly the same amount.
    function test_availableUnchanged_spendExactlyAsBefore() public {
        uint256 availBefore = ledger.credit(alice) - ledger.lockedCredit(alice);
        vm.warp(uint256(due) + 1);
        _liquidate(bob, 1);
        assertEq(ledger.credit(alice) - ledger.lockedCredit(alice), availBefore);
        _revertsUnchanged(
            alice,
            abi.encodeCall(IIndicoLedger.spend, (merchantA, availBefore + 1)),
            abi.encodeWithSelector(
                IIndicoLedger.InsufficientAvailableCredit.selector, availBefore + 1, availBefore
            )
        );
        vm.prank(alice);
        ledger.spend(merchantA, availBefore);
        assertEq(ledger.credit(alice), 0);
        _assertCreditCoversLock();
    }

    /// @dev Every depositor's claim falls together: total assets drop by exactly the principal.
    function test_sharePrice_dropsByExactlyThePrincipal() public {
        uint256 assetsBefore = _modelAssets();
        uint256 sharesBefore = ledger.totalShares();
        vm.warp(uint256(due) + 1);
        _liquidate(bob, 1);
        assertEq(assetsBefore - _modelAssets(), P, "assets fell by other than the principal");
        assertEq(ledger.totalShares(), sharesBefore, "shares moved");
    }

    function test_otherLoansAndUsers_untouched() public {
        _mintCredit(bob, 500e6);
        vm.prank(bob);
        uint256 bobLoan = ledger.requestLoan(400e6);
        bytes32 b0 = vm.load(address(ledger), _loanSlot(bobLoan));
        bytes32 b1 = vm.load(address(ledger), bytes32(uint256(_loanSlot(bobLoan)) + 1));
        vm.warp(uint256(due) + 1);
        _liquidate(merchantA, 1);
        assertEq(vm.load(address(ledger), _loanSlot(bobLoan)), b0);
        assertEq(vm.load(address(ledger), bytes32(uint256(_loanSlot(bobLoan)) + 1)), b1);
        assertEq(ledger.lockedCredit(bob), 500e6);
        assertEq(ledger.credit(bob), 500e6);
        assertEq(ledger.totalLent(), 400e6);
        _assertCreditCoversLock();
    }

    // ================================================================== time

    function test_atDueDate_revertsNotYetDue() public {
        vm.warp(due);
        _revertsUnchanged(bob, _call(1), _notYetDue(due));
    }

    function test_rightAfterOpen_revertsNotYetDue() public {
        _revertsUnchanged(bob, _call(1), _notYetDue(due));
    }

    function test_insideExtensionWindow_revertsNotYetDue() public {
        vm.warp(due - EXTENSION_WINDOW / 2);
        _revertsUnchanged(bob, _call(1), _notYetDue(due));
    }

    /// @dev After n extensions the extended due date is the one that counts.
    function test_afterThreeExtensions_usesExtendedDueDate() public {
        uint64 d = due;
        for (uint256 i; i < 3; ++i) {
            vm.warp(d);
            vm.prank(alice);
            ledger.extend(1);
            d += TERM;
        }
        vm.warp(d);
        _revertsUnchanged(bob, _call(1), _notYetDue(d));
        vm.warp(uint256(d) + 1);
        _liquidate(bob, 1);
        assertEq(_status(1), uint8(IIndicoLedger.LoanStatus.Defaulted));
    }

    // ================================================================== same block, states, ids

    function test_sameBlock_repayThenLiquidate_revertsNotActive() public {
        vm.warp(uint256(due) + 1);
        vm.prank(alice);
        ledger.repay(1);
        _revertsUnchanged(
            bob, _call(1), abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector)
        );
        assertEq(ledger.poolCredit(), 0, "no default after a repayment");
    }

    function test_sameBlock_liquidateThenRepay_revertsNotActive() public {
        vm.warp(uint256(due) + 1);
        _liquidate(bob, 1);
        _revertsUnchanged(
            alice,
            abi.encodeCall(IIndicoLedger.repay, (1)),
            abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector)
        );
        assertEq(ledger.poolUsdc(), POOL - P, "no repayment after a default");
    }

    function test_liquidateTwice_revertsNotActive() public {
        vm.warp(uint256(due) + 1);
        _liquidate(bob, 1);
        _revertsUnchanged(
            bob, _call(1), abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector)
        );
    }

    function test_extendAfterLiquidate_revertsNotActive() public {
        vm.warp(uint256(due) + 1);
        _liquidate(bob, 1);
        _revertsUnchanged(
            alice,
            abi.encodeCall(IIndicoLedger.extend, (1)),
            abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector)
        );
    }

    function test_loanId_zero_onePastEnd_max_revertLoanNotFound() public {
        vm.warp(uint256(due) + 1);
        uint256[3] memory ids = [uint256(0), 2, type(uint256).max];
        for (uint256 i; i < ids.length; ++i) {
            _revertsUnchanged(
                bob, _call(ids[i]), abi.encodeWithSelector(IIndicoLedger.LoanNotFound.selector)
            );
        }
    }

    // ================================================================== caller

    /// @dev Permissionless (D-07), the borrower included (D-56); the event names the caller.
    function test_anyCaller_liquidates_eventNamesCaller() public {
        vm.warp(uint256(due) + 1);
        address[8] memory who = [
            alice,
            bob,
            merchantA,
            admin,
            guardian,
            makeAddr("stranger"),
            address(ledger),
            address(usdc)
        ];
        for (uint256 i; i < who.length; ++i) {
            uint256 snap = vm.snapshotState();
            vm.expectEmit(true, true, true, true, address(ledger));
            emit IIndicoLedger.LoanDefaulted(1, alice, P, K, who[i]);
            _liquidate(who[i], 1);
            assertEq(_status(1), uint8(IIndicoLedger.LoanStatus.Defaulted));
            vm.revertToState(snap);
        }
    }

    function test_revokedBorrowersLoan_canBeLiquidated() public {
        _revokeUser(alice);
        vm.warp(uint256(due) + 1);
        _liquidate(bob, 1);
        assertEq(ledger.poolCredit(), K);
        _assertCreditCoversLock();
    }

    function test_paused_revertsEnforcedPause() public {
        vm.warp(uint256(due) + 1);
        _pause();
        _revertsUnchanged(bob, _call(1), abi.encodeWithSelector(Pausable.EnforcedPause.selector));
    }

    // ================================================================== grace (D-54, D-55)

    /// @dev A pause covering the due date: no liquidation until 7 days after the unpause; at
    ///      the end exactly it still reverts, one second later it goes through.
    function test_grace_pauseCoveringDue_blocksSevenDays() public {
        uint256 u = uint256(due) + 10 days;
        _pauseFromTo(due - 1 days, u);
        _revertsUnchanged(bob, _call(1), _grace(u + LIQUIDATION_GRACE));
        vm.warp(u + LIQUIDATION_GRACE);
        _revertsUnchanged(bob, _call(1), _grace(u + LIQUIDATION_GRACE));
        vm.warp(u + LIQUIDATION_GRACE + 1);
        _liquidate(bob, 1);
        assertEq(_status(1), uint8(IIndicoLedger.LoanStatus.Defaulted));
    }

    function test_grace_repayWorksDuringGrace() public {
        uint256 u = uint256(due) + 10 days;
        _pauseFromTo(due - 1 days, u);
        vm.warp(u + 3 days);
        vm.prank(alice);
        ledger.repay(1);
        assertEq(_status(1), uint8(IIndicoLedger.LoanStatus.Repaid));
    }

    /// @dev D-54's accepted cost: a short pause long after the due date still gives an overdue
    ///      loan the full grace.
    function test_grace_shortPauseAfterDue_stillGraces() public {
        uint256 u = uint256(due) + 50 days + 1 minutes;
        _pauseFromTo(uint256(due) + 50 days, u);
        _revertsUnchanged(bob, _call(1), _grace(u + LIQUIDATION_GRACE));
    }

    /// @dev Before any pause `lastUnpausedAt` is 0: no grace at all.
    function test_grace_noneBeforeFirstUnpause() public {
        assertEq(ledger.lastUnpausedAt(), 0);
        vm.warp(uint256(due) + 1);
        _liquidate(bob, 1);
    }

    /// @dev D-58 with D-54: during the grace, in one block, liquidate is refused and the late
    ///      extension goes through.
    function test_grace_sameBlock_liquidateRefused_lateExtendWorks() public {
        uint256 u = uint256(due) + 5 days;
        _pauseFromTo(due - 1 days, u);
        _revertsUnchanged(bob, _call(1), _grace(u + LIQUIDATION_GRACE));
        vm.prank(alice);
        ledger.extend(1);
        (, uint64 d, uint16 n,,,) = ledger.loans(1);
        assertEq(d, due + TERM);
        assertEq(n, 1);
    }

    // ================================================================== the pool after a default

    /// @dev The last loan defaults with shares outstanding: no division by zero (D-38); a new
    ///      deposit is whole, and the old holder's shares are worth under 1 wei.
    function test_lastLoanDefaults_poolStillWorks() public {
        // alice repays loan 1, then borrows the whole pool and defaults.
        vm.prank(alice);
        ledger.repay(1);
        _mintCredit(alice, _collateralFor(POOL));
        vm.prank(alice);
        uint256 all = ledger.requestLoan(POOL);
        (, uint64 d,,,,) = ledger.loans(all);
        vm.warp(uint256(d) + 1);
        _liquidate(bob, all);
        assertEq(ledger.poolUsdc(), 0);
        assertEq(ledger.totalLent(), 0);
        assertGt(ledger.totalShares(), 0, "shares outstanding");

        _deposit(merchantB, 1e6);
        assertGt(ledger.shares(merchantB), 0);
        vm.prank(merchantB);
        ledger.withdrawAll();
        assertEq(usdc.balanceOf(merchantB), FUND, "new depositor not whole");
        _revertsUnchanged(
            merchantA,
            abi.encodeCall(IIndicoLedger.withdrawAll, ()),
            abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
        );
    }

    /// @dev O-021: the fixture's `_default` liquidates past the due date and puts the clock back
    ///      exactly where it was.
    function test_fixtureDefault_restoresClock() public {
        uint256 before = vm.getBlockTimestamp();
        _default(1);
        assertEq(vm.getBlockTimestamp(), before, "clock not restored");
        assertEq(_status(1), uint8(IIndicoLedger.LoanStatus.Defaulted));
    }

    // ================================================================== check order

    function test_order_pausedFirst() public {
        _pause();
        _revertsUnchanged(
            makeAddr("stranger"), _call(0), abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    function test_order_notFoundBeforeNotActive() public {
        _revertsUnchanged(
            bob, _call(7), abi.encodeWithSelector(IIndicoLedger.LoanNotFound.selector)
        );
    }

    function test_order_notActiveBeforeNotYetDue() public {
        vm.prank(alice);
        ledger.repay(1);
        _revertsUnchanged(
            bob, _call(1), abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector)
        );
    }

    /// @dev Not yet due and inside a grace: NotYetDue first.
    function test_order_notYetDueBeforeGrace() public {
        _pauseFromTo(due - 3 days, due - 1 days);
        _revertsUnchanged(bob, _call(1), _notYetDue(due));
    }

    // ================================================================== properties

    /// @dev Any moment, with or without a pause before it: liquidate succeeds exactly when
    ///      past the due date and past the grace, with exactly the default's writes, and
    ///      otherwise reverts with the matching error and changes nothing.
    function testFuzz_liquidate_iffPastDueAndGrace(uint256 t, uint256 u, bool paused) public {
        t = bound(t, START + 1, uint256(due) + 400 days);
        u = bound(u, START + 1, t);
        if (paused) _pauseFromTo(u - 1, u);
        vm.warp(t);
        uint256 graceEnd = paused ? u + LIQUIDATION_GRACE : LIQUIDATION_GRACE;
        if (t <= due) {
            _revertsUnchanged(bob, _call(1), _notYetDue(due));
        } else if (t <= graceEnd) {
            _revertsUnchanged(bob, _call(1), _grace(graceEnd));
        } else {
            uint256 slot0 = uint256(vm.load(address(ledger), _loanSlot(1)));
            _startDiff();
            _liquidate(bob, 1);
            Write[] memory w = new Write[](6);
            w[0] = _w(address(ledger), _loanSlot(1), slot0 | DEFAULTED);
            w[1] = _w(address(ledger), _key(alice, SLOT_LOCKED_CREDIT), 0);
            w[2] = _w(address(ledger), _key(alice, SLOT_CREDIT), CREDIT - K);
            w[3] = _w(address(ledger), bytes32(SLOT_TOTAL_CREDIT), CREDIT - K);
            w[4] = _w(address(ledger), bytes32(SLOT_POOL_CREDIT), K);
            w[5] = _w(address(ledger), bytes32(SLOT_TOTAL_LENT), 0);
            _assertWrites(w);
            _assertCreditCoversLock();
        }
    }

    /// @dev Any caller can liquidate an overdue loan; the event names them.
    function testFuzz_liquidate_anyCaller(address who) public {
        who = _remapForgeAddress(who);
        vm.warp(uint256(due) + 1);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.LoanDefaulted(1, alice, P, K, who);
        _liquidate(who, 1);
        _assertCreditCoversLock();
    }

    /// @dev For any principal: credit plus pool credit is conserved, available credit is
    ///      unchanged, and credit still covers the lock.
    function testFuzz_liquidate_conservesCredit_availableUnchanged(uint256 p, uint256 extra)
        public
    {
        p = bound(p, 1, POOL - P);
        extra = bound(extra, 0, 1_000_000e6);
        uint256 k = _collateralFor(p);
        _mintCredit(bob, k + extra);
        vm.prank(bob);
        uint256 id = ledger.requestLoan(p);
        uint256 conserved = ledger.totalCredit() + ledger.poolCredit();
        uint256 avail = ledger.credit(bob) - ledger.lockedCredit(bob);
        vm.warp(uint256(due) + 1);
        _liquidate(merchantB, id);
        assertEq(ledger.totalCredit() + ledger.poolCredit(), conserved, "credit not conserved");
        assertEq(ledger.credit(bob) - ledger.lockedCredit(bob), avail, "available changed");
        assertEq(ledger.credit(bob), extra);
        _assertCreditCoversLock();
    }
}
