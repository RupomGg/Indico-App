// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {TERM, LIQUIDATION_GRACE} from "../../src/lib/Constants.sol";
import {StateSnapshot} from "../helpers/StateSnapshot.sol";
import {Matrix} from "../helpers/Matrix.sol";

/// @notice `pause` and `unpause`, contract-spec 6.1. Neither takes a parameter, so the input
///         space is caller x current pause state.
///
/// | Caller                          | State    | pause()                     | unpause()                   |
/// |---------------------------------|----------|-----------------------------|-----------------------------|
/// | guardian                        | unpaused | pauses, emits Paused        | ExpectedPause               |
/// | guardian                        | paused   | EnforcedPause               | unpauses, emits Unpaused    |
/// | anyone without GUARDIAN_ROLE    | either   | AccessControlUnauthorized   | AccessControlUnauthorized   |
/// | admin (DEFAULT_ADMIN, ADMIN)    | either   | AccessControlUnauthorized   | AccessControlUnauthorized   |
/// | guardian after its role revoked | either   | AccessControlUnauthorized   | AccessControlUnauthorized   |
/// | address newly granted GUARDIAN  | unpaused | pauses                      | ExpectedPause               |
///
/// The role check runs before the state check: a non-guardian always gets the access error.
/// Every revert leaves the full state snapshot unchanged.
contract PauseTest is StateSnapshot, Matrix {
    function _paused() internal view returns (bool) {
        return Pausable(address(ledger)).paused();
    }

    function _accessError(address who) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, who, ledger.GUARDIAN_ROLE()
        );
    }

    // ------------------------------------------------------------------ guardian happy path

    function test_guardianPauses() public {
        Snapshot memory s = _snapshot();
        vm.expectEmit(true, true, true, true, address(ledger));
        emit Pausable.Paused(guardian);
        _pause();
        assertTrue(_paused());
        _expectPaused(s);
        _assertUnchanged(s);
    }

    function test_guardianUnpauses() public {
        _pause();
        Snapshot memory s = _snapshot();
        vm.expectEmit(true, true, true, true, address(ledger));
        emit Pausable.Unpaused(guardian);
        vm.prank(guardian);
        ledger.unpause();
        assertFalse(_paused());
        _expectUnpaused(s);
        _assertUnchanged(s);
    }

    /// @dev `Paused` and `PauseTimesSet` (D-59), nothing else.
    function test_pauseEmitsNothingElse() public {
        vm.recordLogs();
        _pause();
        assertEq(vm.getRecordedLogs().length, 2);
    }

    function test_unpauseEmitsNothingElse() public {
        _pause();
        vm.recordLogs();
        vm.prank(guardian);
        ledger.unpause();
        assertEq(vm.getRecordedLogs().length, 2);
    }

    // ------------------------------------------------------------------ wrong state

    function test_pauseWhilePaused_revertsEnforcedPause() public {
        _pause();
        Snapshot memory s = _snapshot();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(guardian);
        ledger.pause();
        _assertUnchanged(s);
    }

    function test_unpauseWhileUnpaused_revertsExpectedPause() public {
        Snapshot memory s = _snapshot();
        vm.expectRevert(Pausable.ExpectedPause.selector);
        vm.prank(guardian);
        ledger.unpause();
        _assertUnchanged(s);
    }

    // ------------------------------------------------------------------ access control

    /// @dev Every non-guardian x both functions x both pause states.
    function test_nonGuardians_cannotPauseOrUnpause_inEitherState() public {
        address[] memory who = _nonGuardians();
        for (uint256 state; state < 2; ++state) {
            if (state == 1) _pause();
            for (uint256 i; i < who.length; ++i) {
                _assertDenied(who[i], true);
                _assertDenied(who[i], false);
            }
        }
    }

    function test_revokedGuardian_cannotPause() public {
        bytes32 role = ledger.GUARDIAN_ROLE();
        vm.prank(admin);
        IAccessControl(address(ledger)).revokeRole(role, guardian);
        _assertDenied(guardian, true);
        _assertDenied(guardian, false);
    }

    function test_newlyGrantedGuardian_canPause() public {
        address second = makeAddr("secondGuardian");
        bytes32 role = ledger.GUARDIAN_ROLE();
        vm.prank(admin);
        IAccessControl(address(ledger)).grantRole(role, second);
        vm.prank(second);
        ledger.pause();
        assertTrue(_paused());
    }

    function testFuzz_randomCaller_cannotPause(address who) public {
        // Remapped, never discarded (INSTRUCTION 1.2).
        who = _remapForgeAddress(who);
        if (who == guardian) who = makeAddr("remapped-not-guardian");
        _assertDenied(who, true);
    }

    function _assertDenied(address who, bool isPause) internal {
        _revertsUnchanged(
            who,
            isPause
                ? abi.encodeCall(IIndicoLedger.pause, ())
                : abi.encodeCall(IIndicoLedger.unpause, ()),
            _accessError(who)
        );
    }

    function _nonGuardians() internal returns (address[] memory w) {
        w = new address[](10);
        (w[0], w[1], w[2], w[3]) = (admin, alice, bob, merchantA);
        (w[4], w[5], w[6]) = (merchantB, address(this), address(ledger));
        (w[7], w[8], w[9]) = (address(usdc), address(0), makeAddr("random"));
    }

    // ------------------------------------------------------------------ pause matrix, IT 2.3

    // ------------------------------------------------------------------ pause timestamps (D-54, D-58)

    uint64 internal constant T0 = 1_800_000_000;

    function _pauseAt(uint256 t) internal {
        vm.warp(t);
        _pause();
    }

    function _unpauseAt(uint256 t) internal {
        vm.warp(t);
        vm.prank(guardian);
        ledger.unpause();
    }

    /// @dev Both timestamps 0: the first pause ever records its start.
    function test_times_firstPauseEver_setsLastPausedAt() public {
        assertEq(ledger.lastPausedAt(), 0);
        assertEq(ledger.lastUnpausedAt(), 0);
        vm.warp(T0);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.PauseTimesSet(T0, 0);
        _pause();
        assertEq(ledger.lastPausedAt(), T0);
        assertEq(ledger.lastUnpausedAt(), 0, "a pause does not touch lastUnpausedAt");
    }

    function test_times_unpause_setsLastUnpausedAt_keepsStart() public {
        _pauseAt(T0);
        vm.warp(T0 + 5 days);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.PauseTimesSet(T0, T0 + 5 days);
        vm.prank(guardian);
        ledger.unpause();
        assertEq(ledger.lastUnpausedAt(), T0 + 5 days);
        assertEq(ledger.lastPausedAt(), T0);
    }

    /// @dev A pause starting inside the previous grace, up to its last second, keeps the start.
    function test_times_pauseInsideGrace_keepsStart() public {
        _pauseAt(T0);
        _unpauseAt(T0 + 1 days);
        vm.warp(T0 + 1 days + LIQUIDATION_GRACE);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.PauseTimesSet(T0, T0 + 1 days);
        _pause();
        assertEq(ledger.lastPausedAt(), T0, "merged with the first pause");
    }

    /// @dev One second after the grace, a pause starts a new disruption.
    function test_times_pauseAfterGrace_newStart() public {
        _pauseAt(T0);
        _unpauseAt(T0 + 1 days);
        _pauseAt(T0 + 1 days + LIQUIDATION_GRACE + 1);
        assertEq(ledger.lastPausedAt(), T0 + 1 days + LIQUIDATION_GRACE + 1);
    }

    /// @dev The exact writes of pause and unpause: the paused flag, and the one packed slot.
    function test_times_exactWrites() public {
        vm.warp(T0);
        _startDiff();
        _pause();
        Write[] memory w = new Write[](2);
        w[0] = _w(address(ledger), bytes32(SLOT_PAUSED), 1);
        w[1] = _w(address(ledger), bytes32(SLOT_PAUSE_TIMES), T0);
        _assertWrites(w);

        vm.warp(T0 + 1 days);
        _startDiff();
        vm.prank(guardian);
        ledger.unpause();
        w[0] = _w(address(ledger), bytes32(SLOT_PAUSED), 0);
        w[1] = _w(address(ledger), bytes32(SLOT_PAUSE_TIMES), T0 | (uint256(T0 + 1 days) << 64));
        _assertWrites(w);
    }

    /// @dev Rows: function. Columns: starting state (unpaused, paused, paused then unpaused);
    ///      the third column expects exactly what the first does, so every function, the pool
    ///      ones included (D-41), works again after an unpause. Each cell runs from a
    ///      clean deployment. Expected: 0 succeeds, 1 EnforcedPause, 2 ExpectedPause.
    ///
    /// | Function            | unpaused      | paused                      |
    /// |---------------------|---------------|-----------------------------|
    /// | pause               | succeeds      | EnforcedPause               |
    /// | unpause             | ExpectedPause | succeeds                    |
    /// | setTermsHash        | succeeds      | succeeds, works while paused (D-24) |
    /// | setUserApproved     | succeeds      | succeeds, works while paused (D-24) |
    /// | setMerchantApproved | succeeds      | succeeds, works while paused (D-24) |
    /// | registerAsset       | succeeds      | EnforcedPause               |
    /// | adminIssueCredit    | succeeds      | EnforcedPause               |
    /// | adminDebitCredit    | succeeds      | EnforcedPause               |
    /// | spend               | succeeds      | EnforcedPause               |
    /// | deposit             | succeeds      | EnforcedPause               |
    /// | withdraw            | succeeds      | EnforcedPause               |
    /// | withdrawAll         | succeeds      | EnforcedPause               |
    /// | requestLoan         | succeeds      | EnforcedPause               |
    /// | repay               | succeeds      | EnforcedPause               |
    /// | extend              | succeeds      | EnforcedPause               |
    /// | liquidate           | succeeds      | EnforcedPause               |
    /// Rows from registerAsset on onboard alice (terms set, approved, signed) before pausing; the
    /// debit and spend rows issue her credit first. The spend and pool rows approve and sign
    /// merchantA, and the two withdraw rows have merchantA deposit 2e6 first, so each paused cell
    /// fails for the pause alone. The repay and extend rows have alice borrow 1e6 (loan 1) before pausing; the extend row
    /// then moves to its due date, the liquidate row one second past it. In the liquidate row the
    /// paused-then-unpaused column is the one cell that differs from unpaused: the unpause just
    /// happened, so liquidate reverts LiquidationGracePeriod(now + 7 days) (D-54). The pool rows follow contract-spec 6: every 6.5 function is
    /// `whenNotPaused`, and none is stated otherwise (D-39).
    function test_pauseMatrix_everyCell() public {
        _crossProduct(_dims(16, 3), _pauseCell);
    }

    function _pauseCell(uint256[] memory c) internal {
        if (c[0] >= 5) {
            vm.prank(admin);
            ledger.setTermsHash(keccak256("matrix-terms-v1"));
            vm.prank(admin);
            ledger.setUserApproved(alice, true);
            vm.prank(alice);
            ledger.signTerms(keccak256("matrix-terms-v1"));
        }
        if (c[0] >= 7) {
            vm.prank(admin);
            ledger.adminIssueCredit(alice, 2e6, "matrix");
        }
        if (c[0] >= 8) {
            vm.prank(admin);
            ledger.setMerchantApproved(merchantA, true);
            vm.prank(merchantA);
            ledger.signTerms(keccak256("matrix-terms-v1"));
        }
        if (c[0] >= 10) {
            vm.prank(merchantA);
            ledger.deposit(2e6);
        }
        if (c[0] >= 13) {
            vm.prank(alice);
            ledger.requestLoan(1e6);
        }
        if (c[0] >= 14) {
            (, uint64 due,,,,) = ledger.loans(1);
            vm.warp(c[0] == 14 ? uint256(due) : uint256(due) + 1);
        }
        if (c[1] >= 1) _pause();
        if (c[1] == 2) {
            vm.prank(guardian);
            ledger.unpause();
        }

        uint8[2][16] memory expected = [
            [uint8(0), 1],
            [uint8(2), 0],
            [uint8(0), 0],
            [uint8(0), 0],
            [uint8(0), 0],
            [uint8(0), 1],
            [uint8(0), 1],
            [uint8(0), 1],
            [uint8(0), 1],
            [uint8(0), 1],
            [uint8(0), 1],
            [uint8(0), 1],
            [uint8(0), 1],
            [uint8(0), 1],
            [uint8(0), 1],
            [uint8(0), 1]
        ];
        uint8 e = expected[c[0]][c[1] == 2 ? 0 : c[1]];
        if (c[0] == 15 && c[1] == 2) e = 3; // the grace after the unpause (D-54)
        bytes32 h = keccak256("matrix-terms");
        address target = makeAddr("matrixTarget");

        Snapshot memory s = _snapshot();
        if (e == 1) vm.expectRevert(Pausable.EnforcedPause.selector);
        if (e == 2) vm.expectRevert(Pausable.ExpectedPause.selector);
        if (e == 3) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IIndicoLedger.LiquidationGracePeriod.selector,
                    block.timestamp + LIQUIDATION_GRACE
                )
            );
        }
        if (c[0] == 0) {
            vm.prank(guardian);
            ledger.pause();
            if (e == 0) _expectPaused(s);
        } else if (c[0] == 1) {
            vm.prank(guardian);
            ledger.unpause();
            if (e == 0) _expectUnpaused(s);
        } else if (c[0] == 2) {
            vm.prank(admin);
            ledger.setTermsHash(h);
            s.termsHash = h;
        } else if (c[0] == 3) {
            vm.prank(admin);
            ledger.setUserApproved(target, true);
            assertTrue(ledger.approvedUser(target));
        } else if (c[0] == 4) {
            vm.prank(admin);
            ledger.setMerchantApproved(target, true);
            assertTrue(ledger.approvedMerchant(target));
        } else if (c[0] == 5) {
            vm.prank(alice);
            ledger.registerAsset(keccak256("matrix-doc"), 0, 1_000e6);
            if (e == 0) {
                s.credit[2] += 1_000e6; // alice is actors[2]
                s.totalCredit += 1_000e6;
            }
        } else if (c[0] == 6) {
            vm.prank(admin);
            ledger.adminIssueCredit(alice, 1e6, "matrix");
            if (e == 0) {
                s.credit[2] += 1e6;
                s.totalCredit += 1e6;
            }
        } else if (c[0] == 7) {
            vm.prank(admin);
            ledger.adminDebitCredit(alice, 1e6, "matrix");
            if (e == 0) {
                s.credit[2] -= 1e6;
                s.totalCredit -= 1e6;
            }
        } else if (c[0] == 8) {
            vm.prank(alice);
            ledger.spend(merchantA, 1e6);
            if (e == 0) {
                s.credit[2] -= 1e6; // alice is actors[2]
                s.credit[4] += 1e6; // merchantA is actors[4]
            }
        } else if (c[0] == 9) {
            vm.prank(merchantA);
            ledger.deposit(1e6);
            if (e == 0) _poolMoved(s, -1e6, 1e12);
        } else if (c[0] == 10) {
            vm.prank(merchantA);
            ledger.withdraw(1e6);
            if (e == 0) _poolMoved(s, 1e6, -1e12);
        } else if (c[0] == 11) {
            vm.prank(merchantA);
            ledger.withdrawAll();
            if (e == 0) _poolMoved(s, 2e6, -2e12);
        } else if (c[0] == 12) {
            vm.prank(alice);
            ledger.requestLoan(1e6);
            if (e == 0) {
                (address b,,,, uint128 p, uint128 k) = ledger.loans(1);
                assertEq(b, alice);
                assertEq(p, 1e6);
                assertEq(k, 1.25e6);
                s.usdc[2] += 1e6; // alice is actors[2]
                s.lockedCredit[2] += 1.25e6;
                s.ledgerUsdc -= 1e6;
                s.poolUsdc -= 1e6;
                s.totalLent += 1e6;
                s.nextLoanId = 1;
                s.loansHash = _snapshot().loansHash; // loan 1's fields asserted just above
            }
        } else if (c[0] == 13) {
            vm.prank(alice);
            ledger.repay(1);
            if (e == 0) {
                (,,, uint8 st,,) = ledger.loans(1);
                assertEq(st, uint8(IIndicoLedger.LoanStatus.Repaid));
                s.usdc[2] -= 1e6; // alice is actors[2]
                s.lockedCredit[2] -= 1.25e6;
                s.ledgerUsdc += 1e6;
                s.poolUsdc += 1e6;
                s.totalLent -= 1e6;
                s.loansHash = _snapshot().loansHash; // loan 1's status asserted just above
            }
        } else if (c[0] == 14) {
            vm.prank(alice);
            ledger.extend(1);
            if (e == 0) {
                (, uint64 d, uint16 n,,,) = ledger.loans(1);
                assertEq(d, block.timestamp + TERM);
                assertEq(n, 1);
                s.loansHash = _snapshot().loansHash; // loan 1's new due date asserted just above
            }
        } else {
            vm.prank(bob);
            ledger.liquidate(1);
            if (e == 0) {
                (,,, uint8 st,,) = ledger.loans(1);
                assertEq(st, uint8(IIndicoLedger.LoanStatus.Defaulted));
                s.credit[2] -= 1.25e6; // alice is actors[2]
                s.lockedCredit[2] -= 1.25e6;
                s.totalCredit -= 1.25e6;
                s.poolCredit += 1.25e6;
                s.totalLent -= 1e6;
                s.loansHash = _snapshot().loansHash; // loan 1's status asserted just above
            }
        }
        _assertUnchanged(s);
    }

    /// @dev merchantA (actors[4]) received `usdcIn` USDC (negative: paid in) and its shares
    ///      changed by `sharesIn`; the pool's books move the other way.
    function _poolMoved(Snapshot memory s, int256 usdcIn, int256 sharesIn) internal pure {
        s.usdc[4] = uint256(int256(s.usdc[4]) + usdcIn);
        s.shares[4] = uint256(int256(s.shares[4]) + sharesIn);
        s.totalShares = uint256(int256(s.totalShares) + sharesIn);
        s.poolUsdc = uint256(int256(s.poolUsdc) - usdcIn);
        s.ledgerUsdc = uint256(int256(s.ledgerUsdc) - usdcIn);
    }
}
