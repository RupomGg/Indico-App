// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {TERM, EXTENSION_WINDOW} from "../../src/lib/Constants.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice `extend`, contract-spec 6.6; PRD R-04 to R-06; D-13 (the window), D-49 (check order),
///         D-50 (a revoked borrower cannot extend), D-51 (SafeCast, never a panic), D-52 (any
///         signed terms version).
///
/// time t against the loan's due date d (window opens at o = d - EXTENSION_WINDOW)
/// | Class                    | Expected                                             |
/// |--------------------------|------------------------------------------------------|
/// | t = o - 1                | ExtensionWindowNotOpen(o)                            |
/// | t = o (window opens)     | extended: d + TERM (never t + TERM)                  |
/// | o < t < d                | extended                                             |
/// | t = d                    | extended                                             |
/// | t = d + 1                | ExtensionWindowClosed                                |
/// | twice in one block       | second ExtensionWindowNotOpen(d + TERM - WINDOW)     |
/// | 100 in one block         | every call after the first reverts the same          |
/// loanId: 0, one past the end, uint256 max -> LoanNotFound; repaid -> LoanNotActive;
/// defaulted -> LoanNotActive, needs `liquidate`: in the P1.11 loan matrix.
/// caller: the approved borrower extends; any other address -> NotBorrower; the borrower revoked
/// -> NotApprovedUser (D-50), repay still works, re-approval restores extend; paused ->
/// EnforcedPause. Terms: a borrower on an older signed version or on the current one extends.
/// Effects: only loan slot 0 changes (dueDate += TERM, extensionCount += 1); nothing else in the
/// ledger or the token; `LoanExtended(id, newDue, countAfter)` and nothing else.
/// Overflow (D-51): count 65,535 or a due date near 2^64 -> SafeCastOverflowedUintDowncast.
/// Order: EnforcedPause, LoanNotFound, LoanNotActive, NotBorrower, NotApprovedUser, window.
/// Every revert: `_revertsUnchanged` (state diff, D-43).
contract ExtendTest is Actors {
    uint256 internal constant CREDIT = 1_000e6;
    uint256 internal constant POOL = 10_000e6;
    uint256 internal constant P = 800e6;
    uint64 internal constant START = 1_800_000_000;

    uint64 internal due; // loan 1's due date at open

    function setUp() public override {
        super.setUp();
        vm.warp(START);
        _mintCredit(alice, CREDIT);
        _fundPool(POOL);
        vm.prank(alice);
        ledger.requestLoan(P);
        due = START + TERM;
    }

    function _extend(address who, uint256 id) internal {
        vm.prank(who);
        ledger.extend(id);
    }

    function _call(uint256 id) internal pure returns (bytes memory) {
        return abi.encodeCall(IIndicoLedger.extend, (id));
    }

    function _opens(uint64 d) internal pure returns (uint64) {
        return d - EXTENSION_WINDOW;
    }

    function _notOpen(uint64 d) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IIndicoLedger.ExtensionWindowNotOpen.selector, _opens(d));
    }

    function _closed() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IIndicoLedger.ExtensionWindowClosed.selector);
    }

    function _loanSlot(uint256 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(id, SLOT_LOANS));
    }

    /// @dev Loan slot 0 of an Active loan: borrower, due date, count, status 0.
    function _slot0(address b, uint64 d, uint16 n) internal pure returns (uint256) {
        return uint256(uint160(b)) | (uint256(d) << 160) | (uint256(n) << 224);
    }

    function _dueAndCount(uint256 id) internal view returns (uint64 d, uint16 n) {
        (, d, n,,,) = ledger.loans(id);
    }

    function _ledgerLogs(Vm.Log[] memory logs) internal view returns (uint256 k) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(ledger)) ++k;
        }
    }

    // ================================================================== happy path

    function test_extend_atWindowOpening_fromDueDateNotNow_emits() public {
        vm.warp(_opens(due));
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.LoanExtended(1, due + TERM, 1);
        _extend(alice, 1);
        (uint64 d, uint16 n) = _dueAndCount(1);
        assertEq(d, due + TERM, "old due + TERM");
        assertTrue(d != _opens(due) + TERM, "never now + TERM");
        assertEq(n, 1);
        (address b,,, uint8 st, uint128 p, uint128 k) = ledger.loans(1);
        assertEq(b, alice);
        assertEq(st, uint8(IIndicoLedger.LoanStatus.Active));
        assertEq(p, P);
        assertEq(k, CREDIT);
    }

    function test_extend_emitsOnlyOne() public {
        vm.warp(due);
        vm.recordLogs();
        _extend(alice, 1);
        assertEq(_ledgerLogs(vm.getRecordedLogs()), 1);
    }

    /// @dev Exactly one net write: loan slot 0. Nothing else moves, USDC included.
    function test_extend_exactWrites_onlyLoanSlot0() public {
        vm.warp(due - EXTENSION_WINDOW / 2);
        _startDiff();
        _extend(alice, 1);
        Write[] memory w = new Write[](1);
        w[0] = _w(address(ledger), _loanSlot(1), _slot0(alice, due + TERM, 1));
        _assertWrites(w);
    }

    function test_extend_exactlyAtDueDate() public {
        vm.warp(due);
        _extend(alice, 1);
        (uint64 d,) = _dueAndCount(1);
        assertEq(d, due + TERM);
    }

    // ================================================================== window edges (D-13)

    function test_extend_oneSecondBeforeWindow_revertsNotOpen() public {
        vm.warp(_opens(due) - 1);
        _revertsUnchanged(alice, _call(1), _notOpen(due));
    }

    function test_extend_oneSecondAfterDue_revertsClosed() public {
        vm.warp(uint256(due) + 1);
        _revertsUnchanged(alice, _call(1), _closed());
    }

    function test_extend_atOpen_revertsNotOpen() public {
        // straight after the loan opens: the window is two months away
        _revertsUnchanged(alice, _call(1), _notOpen(due));
    }

    function test_extend_twiceInOneBlock_secondRevertsNotOpen() public {
        vm.warp(due);
        _extend(alice, 1);
        _revertsUnchanged(alice, _call(1), _notOpen(due + TERM));
    }

    /// @dev D-13: a loop of 100 in one block; only the first goes through.
    function test_extend_loopOf100InOneBlock_revertsFromTheSecond() public {
        vm.warp(due);
        _extend(alice, 1);
        bytes memory expected = _notOpen(due + TERM);
        for (uint256 i = 1; i < 100; ++i) {
            vm.prank(alice);
            (bool ok, bytes memory ret) = address(ledger).call(_call(1));
            assertFalse(ok, "a later extend in the same block went through");
            assertEq(ret, expected);
        }
        (uint64 d, uint16 n) = _dueAndCount(1);
        assertEq(n, 1);
        assertEq(d, due + TERM);
    }

    /// @dev TS 2.2: 40 extensions, each at its window's opening; no overflow, exact count,
    ///      still the one loan.
    function test_extend_fortyTimes_countAndDueExact() public {
        uint64 d = due;
        for (uint16 i = 1; i <= 40; ++i) {
            vm.warp(_opens(d));
            _extend(alice, 1);
            d += TERM;
            (uint64 got, uint16 n) = _dueAndCount(1);
            assertEq(got, d);
            assertEq(n, i);
        }
        assertEq(d, START + 41 * uint64(TERM));
        assertEq(ledger.nextLoanId(), 1, "still one loan");
        assertEq(ledger.lockedCredit(alice), CREDIT);
        assertEq(ledger.totalLent(), P);
    }

    /// @dev After an extension the loan repays as normal, at its new due date too.
    function test_extend_thenRepayAtNewDueDate() public {
        vm.warp(due);
        _extend(alice, 1);
        vm.warp(due + TERM);
        vm.prank(alice);
        ledger.repay(1);
        assertEq(ledger.lockedCredit(alice), 0);
        assertEq(ledger.poolUsdc(), POOL);
    }

    // ================================================================== loanId

    function test_loanId_zero_revertsLoanNotFound() public {
        vm.warp(due);
        _revertsUnchanged(
            alice, _call(0), abi.encodeWithSelector(IIndicoLedger.LoanNotFound.selector)
        );
    }

    function test_loanId_onePastTheEnd_revertsLoanNotFound() public {
        vm.warp(due);
        _revertsUnchanged(
            alice, _call(2), abi.encodeWithSelector(IIndicoLedger.LoanNotFound.selector)
        );
    }

    function test_loanId_uint256Max_revertsLoanNotFound() public {
        vm.warp(due);
        _revertsUnchanged(
            alice,
            _call(type(uint256).max),
            abi.encodeWithSelector(IIndicoLedger.LoanNotFound.selector)
        );
    }

    function test_repaidLoan_revertsLoanNotActive() public {
        vm.prank(alice);
        ledger.repay(1);
        vm.warp(due);
        _revertsUnchanged(
            alice, _call(1), abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector)
        );
    }

    // ================================================================== caller

    function test_caller_notBorrower_revertsNotBorrower() public {
        vm.warp(due);
        address stranger = makeAddr("stranger");
        address[6] memory who = [bob, merchantA, merchantB, admin, guardian, stranger];
        for (uint256 i; i < who.length; ++i) {
            _revertsUnchanged(
                who[i], _call(1), abi.encodeWithSelector(IIndicoLedger.NotBorrower.selector)
            );
        }
    }

    /// @dev D-50: revoked, the borrower cannot extend, and can still repay.
    function test_revokedBorrower_cannotExtend_canRepay() public {
        _revokeUser(alice);
        vm.warp(due);
        _revertsUnchanged(
            alice, _call(1), abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
        );
        vm.prank(alice);
        ledger.repay(1);
        assertEq(ledger.lockedCredit(alice), 0);
    }

    /// @dev D-50: re-approval restores extend inside the window.
    function test_revokedThenReapproved_extendsAgain() public {
        _revokeUser(alice);
        _approveUser(alice);
        vm.warp(due);
        _extend(alice, 1);
        (uint64 d, uint16 n) = _dueAndCount(1);
        assertEq(d, due + TERM);
        assertEq(n, 1);
    }

    /// @dev D-50 with D-09: past its due date a revoked borrower's loan stays repayable until
    ///      liquidated.
    function test_revokedBorrower_pastDue_stillRepays() public {
        _revokeUser(alice);
        vm.warp(uint256(due) + 1000 days);
        vm.prank(alice);
        ledger.repay(1);
        (,,, uint8 st,,) = ledger.loans(1);
        assertEq(st, uint8(IIndicoLedger.LoanStatus.Repaid));
    }

    /// @dev D-52: a borrower whose last signature is an older terms version extends.
    function test_terms_borrowerOnOldVersion_extends() public {
        vm.prank(admin);
        ledger.setTermsHash(keccak256("terms-v2"));
        assertEq(ledger.signedTermsHash(alice), TERMS, "alice signed only v1");
        vm.warp(due);
        _extend(alice, 1);
        (, uint16 n) = _dueAndCount(1);
        assertEq(n, 1);
    }

    /// @dev D-52: a borrower who signed the current version extends too.
    function test_terms_borrowerOnCurrentVersion_extends() public {
        bytes32 v2 = keccak256("terms-v2");
        vm.prank(admin);
        ledger.setTermsHash(v2);
        vm.prank(alice);
        ledger.signTerms(v2);
        vm.warp(due);
        _extend(alice, 1);
        (, uint16 n) = _dueAndCount(1);
        assertEq(n, 1);
    }

    function test_paused_revertsEnforcedPause() public {
        vm.warp(due);
        _pause();
        _revertsUnchanged(alice, _call(1), abi.encodeWithSelector(Pausable.EnforcedPause.selector));
    }

    // ================================================================== overflow (D-51)

    /// @dev The count at 65,535 (unreachable by D-13, written here): a named SafeCast revert.
    function test_countAtMax_revertsSafeCastNamed() public {
        vm.store(address(ledger), _loanSlot(1), bytes32(_slot0(alice, due, type(uint16).max)));
        vm.warp(due);
        _revertsUnchanged(
            alice,
            _call(1),
            abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 16, 65_536)
        );
    }

    /// @dev A due date so late that `+ TERM` passes 2^64 - 1: a named SafeCast revert.
    function test_dueNearUint64Max_revertsSafeCastNamed() public {
        uint64 late = type(uint64).max - 1 days;
        vm.store(address(ledger), _loanSlot(1), bytes32(_slot0(alice, late, 0)));
        vm.warp(late);
        _revertsUnchanged(
            alice,
            _call(1),
            abi.encodeWithSelector(
                SafeCast.SafeCastOverflowedUintDowncast.selector, 64, uint256(late) + TERM
            )
        );
    }

    // ================================================================== check order (D-49)

    function test_order_pausedFirst() public {
        _pause();
        _revertsUnchanged(
            makeAddr("stranger"), _call(0), abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    function test_order_notActiveBeforeNotBorrower() public {
        vm.prank(alice);
        ledger.repay(1);
        _revertsUnchanged(
            bob, _call(1), abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector)
        );
    }

    /// @dev A revoked address that is not the borrower: NotBorrower first.
    function test_order_notBorrowerBeforeNotApproved() public {
        _revokeUser(bob);
        vm.warp(due);
        _revertsUnchanged(bob, _call(1), abi.encodeWithSelector(IIndicoLedger.NotBorrower.selector));
    }

    /// @dev D-50, as the owner asked: revoked and outside the window, NotApprovedUser first.
    function test_order_notApprovedBeforeWindow() public {
        _revokeUser(alice);
        _revertsUnchanged(
            alice, _call(1), abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
        );
        vm.warp(uint256(due) + 1);
        _revertsUnchanged(
            alice, _call(1), abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
        );
    }

    // ================================================================== properties (IT 3.2)

    /// @dev For any n from 1 to 10, extending n times, each at a fuzzed moment inside that
    ///      extension's window, gives due = start + (n + 1) * TERM and count n; the last call
    ///      writes exactly loan slot 0.
    function testFuzz_extend_nTimes_dueAndCountExact(uint256 n, uint256 seed) public {
        n = bound(n, 1, 10);
        uint64 d = due;
        for (uint256 i = 1; i <= n; ++i) {
            uint256 offset = uint256(keccak256(abi.encode(seed, i))) % (EXTENSION_WINDOW + 1);
            vm.warp(_opens(d) + offset);
            if (i == n) _startDiff();
            _extend(alice, 1);
            d += TERM;
        }
        Write[] memory w = new Write[](1);
        w[0] = _w(address(ledger), _loanSlot(1), _slot0(alice, d, uint16(n)));
        _assertWrites(w);
        assertEq(d, START + uint64(n + 1) * TERM);
    }

    /// @dev Any moment outside [due - WINDOW, due] reverts with the matching named error and
    ///      changes nothing. A moment inside the window is remapped to one second before it.
    function testFuzz_extend_outsideWindow_namedRevertNothingChanged(uint256 t) public {
        t = bound(t, START, type(uint64).max);
        if (t >= _opens(due) && t <= due) t = _opens(due) - 1;
        vm.warp(t);
        _revertsUnchanged(alice, _call(1), t < _opens(due) ? _notOpen(due) : _closed());
    }

    /// @dev Any address but the borrower is refused inside the window, and nothing changes.
    function testFuzz_extend_anyOtherCaller_revertsNotBorrower(address who) public {
        who = _remapForgeAddress(who);
        if (who == alice) who = bob;
        vm.warp(due);
        _revertsUnchanged(who, _call(1), abi.encodeWithSelector(IIndicoLedger.NotBorrower.selector));
    }
}
