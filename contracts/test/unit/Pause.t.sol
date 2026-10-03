// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
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
        s.paused = true;
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
        s.paused = false;
        _assertUnchanged(s);
    }

    function test_pauseEmitsNothingElse() public {
        vm.recordLogs();
        _pause();
        assertEq(vm.getRecordedLogs().length, 1);
    }

    function test_unpauseEmitsNothingElse() public {
        _pause();
        vm.recordLogs();
        vm.prank(guardian);
        ledger.unpause();
        assertEq(vm.getRecordedLogs().length, 1);
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
        Snapshot memory s = _snapshot();
        vm.expectRevert(_accessError(who));
        vm.prank(who);
        if (isPause) ledger.pause();
        else ledger.unpause();
        _assertUnchanged(s);
    }

    function _nonGuardians() internal returns (address[] memory w) {
        w = new address[](10);
        (w[0], w[1], w[2], w[3]) = (admin, alice, bob, merchantA);
        (w[4], w[5], w[6]) = (merchantB, address(this), address(ledger));
        (w[7], w[8], w[9]) = (address(usdc), address(0), makeAddr("random"));
    }

    // ------------------------------------------------------------------ pause matrix, IT 2.3

    /// @dev Rows: function. Columns: starting state (unpaused, paused). Each cell runs from a
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
    /// The last three rows onboard alice (terms set, approved, signed) before pausing, and the
    /// debit row issues her credit first, so each paused cell fails for the pause alone.
    function test_pauseMatrix_everyCell() public {
        _crossProduct(_dims(8, 2), _pauseCell);
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
        if (c[0] == 7) {
            vm.prank(admin);
            ledger.adminIssueCredit(alice, 2e6, "matrix");
        }
        bool startPaused = c[1] == 1;
        if (startPaused) _pause();

        uint8[2][8] memory expected = [
            [uint8(0), 1],
            [uint8(2), 0],
            [uint8(0), 0],
            [uint8(0), 0],
            [uint8(0), 0],
            [uint8(0), 1],
            [uint8(0), 1],
            [uint8(0), 1]
        ];
        uint8 e = expected[c[0]][c[1]];
        bytes32 h = keccak256("matrix-terms");
        address target = makeAddr("matrixTarget");

        Snapshot memory s = _snapshot();
        if (e == 1) vm.expectRevert(Pausable.EnforcedPause.selector);
        if (e == 2) vm.expectRevert(Pausable.ExpectedPause.selector);
        if (c[0] == 0) {
            vm.prank(guardian);
            ledger.pause();
            if (e == 0) s.paused = true;
        } else if (c[0] == 1) {
            vm.prank(guardian);
            ledger.unpause();
            if (e == 0) s.paused = false;
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
        } else {
            vm.prank(admin);
            ledger.adminDebitCredit(alice, 1e6, "matrix");
            if (e == 0) {
                s.credit[2] -= 1e6;
                s.totalCredit -= 1e6;
            }
        }
        _assertUnchanged(s);
    }
}
