// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {ROLE_NONE, ROLE_USER, ROLE_MERCHANT} from "../../src/lib/Constants.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice Participant state x action, docs/input-testing.md 2.2. Columns so far: 4 of 13
///         (`signTerms`, `setUserApproved`, `pause`, `registerAsset`); each later portion adds
///         its own at its gate until all 13 x 9 = 117 cells exist (O-025).
///
/// | Participant           | signTerms(TERMS) | setUserApproved(t, true) | pause()       | registerAsset   |
/// |-----------------------|------------------|--------------------------|---------------|-----------------|
/// | Unknown               | ok               | denied (ADMIN_ROLE)      | denied (GUARDIAN_ROLE) | NotApprovedUser |
/// | RegisteredNotApproved | AlreadySigned    | denied                   | denied        | NotApprovedUser |
/// | ApprovedNotSigned     | ok               | denied                   | denied        | TermsNotSigned  |
/// | ApprovedAndSigned     | AlreadySigned    | denied                   | denied        | ok              |
/// | ApprovedThenRevoked   | AlreadySigned    | denied                   | denied        | NotApprovedUser |
/// | Merchant              | AlreadySigned    | denied                   | denied        | NotApprovedUser |
/// | MerchantRevoked       | AlreadySigned    | denied                   | denied        | NotApprovedUser |
/// | Admin                 | ok               | ok                       | denied        | NotApprovedUser |
/// | Guardian              | ok               | denied                   | ok            | NotApprovedUser |
/// Every cell runs from a clean onboarded fixture. Every revert leaves the snapshot unchanged.
contract ParticipantMatrixTest is Actors {
    uint8 internal constant OK = 0;
    uint8 internal constant ALREADY_SIGNED = 1;
    uint8 internal constant NOT_ADMIN = 2;
    uint8 internal constant NOT_GUARDIAN = 3;
    uint8 internal constant NOT_USER = 4;
    uint8 internal constant NOT_SIGNED = 5;

    uint256 internal constant COLUMNS = 4;
    uint256 internal constant REGISTER_VALUE = 1_000e6;

    function _expected(uint256 p, uint256 action) internal pure returns (uint8) {
        // Rows in Participant order; columns signTerms, setUserApproved, pause, registerAsset.
        uint8[4][9] memory t = [
            [OK, NOT_ADMIN, NOT_GUARDIAN, NOT_USER],
            [ALREADY_SIGNED, NOT_ADMIN, NOT_GUARDIAN, NOT_USER],
            [OK, NOT_ADMIN, NOT_GUARDIAN, NOT_SIGNED],
            [ALREADY_SIGNED, NOT_ADMIN, NOT_GUARDIAN, OK],
            [ALREADY_SIGNED, NOT_ADMIN, NOT_GUARDIAN, NOT_USER],
            [ALREADY_SIGNED, NOT_ADMIN, NOT_GUARDIAN, NOT_USER],
            [ALREADY_SIGNED, NOT_ADMIN, NOT_GUARDIAN, NOT_USER],
            [OK, OK, NOT_GUARDIAN, NOT_USER],
            [OK, NOT_ADMIN, OK, NOT_USER]
        ];
        return t[p][action];
    }

    function test_participantMatrix_everyCell() public {
        _crossProduct(_dims(PARTICIPANTS, COLUMNS), _cell);
    }

    function _cell(uint256[] memory c) internal {
        address who = _participant(Participant(c[0]));
        uint8 e = _expected(c[0], c[1]);
        address target = makeAddr("matrixTarget");

        Snapshot memory s = _snapshot();
        if (e == ALREADY_SIGNED) vm.expectRevert(IIndicoLedger.AlreadySigned.selector);
        if (e == NOT_USER) vm.expectRevert(IIndicoLedger.NotApprovedUser.selector);
        if (e == NOT_SIGNED) vm.expectRevert(IIndicoLedger.TermsNotSigned.selector);
        if (e == NOT_ADMIN) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector,
                    who,
                    ledger.ADMIN_ROLE()
                )
            );
        }
        if (e == NOT_GUARDIAN) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector,
                    who,
                    ledger.GUARDIAN_ROLE()
                )
            );
        }

        vm.prank(who);
        if (c[1] == 0) ledger.signTerms(TERMS);
        else if (c[1] == 1) ledger.setUserApproved(target, true);
        else if (c[1] == 2) ledger.pause();
        else ledger.registerAsset(keccak256("matrix-doc"), 0, REGISTER_VALUE);

        if (e != OK) return _assertUnchanged(s);

        if (c[1] == 0) {
            assertTrue(ledger.termsSigned(who), "signed");
            assertEq(ledger.signedTermsHash(who), TERMS);
        } else if (c[1] == 1) {
            assertTrue(ledger.approvedUser(target), "approved");
        } else if (c[1] == 2) {
            s.paused = true;
            _assertUnchanged(s);
        } else {
            assertEq(ledger.credit(who), REGISTER_VALUE, "minted");
            assertEq(ledger.totalCredit(), REGISTER_VALUE, "total");
            assertTrue(ledger.assetRegistered(keccak256("matrix-doc")));
        }
    }

    // ------------------------------------------------------------------ Actors self-check

    /// @dev Each participant state is what its name says. The matrix verdicts depend on it.
    function test_participant_everyStateBuiltAsNamed() public {
        _crossProduct(_dims(PARTICIPANTS, 1), _stateCell);
    }

    function _stateCell(uint256[] memory c) internal {
        Participant p = Participant(c[0]);
        address a = _participant(p);

        bool user = p == Participant.ApprovedNotSigned || p == Participant.ApprovedAndSigned;
        bool merchant = p == Participant.Merchant;
        bool signed = p == Participant.RegisteredNotApproved || p == Participant.ApprovedAndSigned
            || p == Participant.ApprovedThenRevoked || p == Participant.Merchant
            || p == Participant.MerchantRevoked;
        uint8 role = ROLE_NONE;
        if (
            p == Participant.ApprovedNotSigned || p == Participant.ApprovedAndSigned
                || p == Participant.ApprovedThenRevoked
        ) role = ROLE_USER;
        if (p == Participant.Merchant || p == Participant.MerchantRevoked) role = ROLE_MERCHANT;

        assertEq(ledger.approvedUser(a), user, "approvedUser");
        assertEq(ledger.approvedMerchant(a), merchant, "approvedMerchant");
        assertEq(ledger.termsSigned(a), signed, "termsSigned");
        assertEq(ledger.participantRole(a), role, "participantRole");
        bytes32 adminRole = ledger.ADMIN_ROLE();
        bytes32 guardianRole = ledger.GUARDIAN_ROLE();
        assertEq(IAccessControl(address(ledger)).hasRole(adminRole, a), p == Participant.Admin);
        assertEq(
            IAccessControl(address(ledger)).hasRole(guardianRole, a), p == Participant.Guardian
        );
    }
}
