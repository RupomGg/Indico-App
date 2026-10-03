// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {ROLE_NONE, ROLE_USER, ROLE_MERCHANT} from "../../src/lib/Constants.sol";
import {StateSnapshot} from "../helpers/StateSnapshot.sol";

/// @notice `setTermsHash`, `setUserApproved`, `setMerchantApproved`, contract-spec 6.1,
///         D-20 to D-24.
///
/// setTermsHash(bytes32 newHash)
/// | Class                       | Value              | Expected                                   |
/// |-----------------------------|--------------------|--------------------------------------------|
/// | zero                        | 0x00               | ZeroTermsHash                              |
/// | typical                     | keccak("terms-v1") | stored, TermsHashSet(hash)                 |
/// | max                         | bytes32 max        | stored, TermsHashSet(max)                  |
/// | same as current (D-20)      | current hash       | allowed, TermsHashSet emitted again        |
/// | changed                     | a second hash      | replaces, TermsHashSet(new)                |
/// | caller without ADMIN_ROLE   | eight addresses    | AccessControlUnauthorizedAccount(c, ADMIN) |
/// | second ADMIN_ROLE holder    | granted by admin   | allowed                                    |
/// | while paused (D-24)         |                    | allowed                                    |
///
/// setUserApproved(address user, bool approved) and setMerchantApproved(address m, bool approved)
/// | Class                                   | approved | Expected                                       |
/// |-----------------------------------------|----------|------------------------------------------------|
/// | zero address                            | either   | ZeroAddress                                    |
/// | the ledger itself (D-23)                | true     | InvalidParticipant(ledger)                     |
/// | the USDC address (D-23)                 | true     | InvalidParticipant(usdc)                       |
/// | the ledger or USDC address              | false    | allowed, flag false, role unchanged, event     |
/// | fresh address                           | true     | flag true, role set, event                     |
/// | fresh address, never approved           | false    | allowed, flag false, role stays NONE, event    |
/// | approved                                | true     | allowed again, emits again (D-20)              |
/// | approved                                | false    | flag false, role kept                          |
/// | revoked, same role                      | true     | re-approved                                    |
/// | ever approved in the other role (D-22)  | true     | ParticipantRoleConflict(account)               |
/// | ever approved in the other role         | false    | allowed (revoking a role it never had)         |
/// | the admin's own address                 | true     | allowed; no rule against it                    |
/// | caller without ADMIN_ROLE               | either   | AccessControlUnauthorizedAccount(c, ADMIN)     |
/// | while paused (D-24)                     | either   | allowed                                        |
/// Check order: ZeroAddress, then InvalidParticipant, then ParticipantRoleConflict.
/// Every revert leaves the full state snapshot unchanged, participantRole included.
contract MembershipTest is StateSnapshot {
    bytes32 internal constant H1 = keccak256("terms-v1");
    bytes32 internal constant H2 = keccak256("terms-v2");

    address internal x = makeAddr("x");

    function _adminRole() internal view returns (bytes32) {
        return ledger.ADMIN_ROLE();
    }

    function _deny(address who) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, who, _adminRole()
        );
    }

    function _nonAdmins() internal returns (address[] memory w) {
        w = new address[](8);
        (w[0], w[1], w[2], w[3]) = (guardian, alice, bob, merchantA);
        (w[4], w[5], w[6], w[7]) = (merchantB, address(this), address(ledger), makeAddr("random"));
    }

    function _setUser(address a, bool v) internal {
        vm.prank(admin);
        ledger.setUserApproved(a, v);
    }

    function _setMerchant(address a, bool v) internal {
        vm.prank(admin);
        ledger.setMerchantApproved(a, v);
    }

    /// @dev Calls the user setter (`asUser`) or the merchant setter as `caller`.
    function _set(address caller, bool asUser, address a, bool v) internal {
        vm.prank(caller);
        if (asUser) ledger.setUserApproved(a, v);
        else ledger.setMerchantApproved(a, v);
    }

    function _flag(bool asUser, address a) internal view returns (bool) {
        return asUser ? ledger.approvedUser(a) : ledger.approvedMerchant(a);
    }

    function _expectApprovalEvent(bool asUser, address a, bool v) internal {
        vm.expectEmit(true, true, true, true, address(ledger));
        if (asUser) emit IIndicoLedger.UserApprovalSet(a, v);
        else emit IIndicoLedger.MerchantApprovalSet(a, v);
    }

    // ================================================================== setTermsHash

    function test_setTermsHash_zero_reverts() public {
        Snapshot memory s = _snapshot();
        vm.expectRevert(IIndicoLedger.ZeroTermsHash.selector);
        vm.prank(admin);
        ledger.setTermsHash(bytes32(0));
        _assertUnchanged(s);
    }

    function test_setTermsHash_typical_storesAndEmits() public {
        Snapshot memory s = _snapshot();
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.TermsHashSet(H1);
        vm.prank(admin);
        ledger.setTermsHash(H1);
        s.termsHash = H1;
        _assertUnchanged(s);
    }

    function test_setTermsHash_max_stored() public {
        vm.prank(admin);
        ledger.setTermsHash(bytes32(type(uint256).max));
        assertEq(ledger.termsHash(), bytes32(type(uint256).max));
    }

    function test_setTermsHash_sameTwice_emitsBothTimes() public {
        vm.prank(admin);
        ledger.setTermsHash(H1);
        vm.recordLogs();
        vm.prank(admin);
        ledger.setTermsHash(H1);
        assertEq(vm.getRecordedLogs().length, 1, "emits again");
        assertEq(ledger.termsHash(), H1);
    }

    function test_setTermsHash_changed_replaces() public {
        vm.prank(admin);
        ledger.setTermsHash(H1);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.TermsHashSet(H2);
        vm.prank(admin);
        ledger.setTermsHash(H2);
        assertEq(ledger.termsHash(), H2);
    }

    function test_setTermsHash_emitsNothingElse() public {
        vm.recordLogs();
        vm.prank(admin);
        ledger.setTermsHash(H1);
        assertEq(vm.getRecordedLogs().length, 1);
    }

    function testFuzz_setTermsHash_anyNonZero_stored(bytes32 h) public {
        if (h == bytes32(0)) h = keccak256("remapped-zero"); // remapped, never discarded
        vm.prank(admin);
        ledger.setTermsHash(h);
        assertEq(ledger.termsHash(), h);
    }

    function test_setTermsHash_nonAdmins_revert() public {
        address[] memory who = _nonAdmins();
        for (uint256 i; i < who.length; ++i) {
            Snapshot memory s = _snapshot();
            vm.expectRevert(_deny(who[i]));
            vm.prank(who[i]);
            ledger.setTermsHash(H1);
            _assertUnchanged(s);
        }
    }

    function test_setTermsHash_secondAdminRoleHolder_allowed() public {
        address second = makeAddr("secondAdmin");
        bytes32 role = _adminRole();
        vm.prank(admin);
        IAccessControl(address(ledger)).grantRole(role, second);
        vm.prank(second);
        ledger.setTermsHash(H1);
        assertEq(ledger.termsHash(), H1);
    }

    function test_setTermsHash_whilePaused_allowed() public {
        _pause();
        vm.prank(admin);
        ledger.setTermsHash(H1);
        assertEq(ledger.termsHash(), H1);
    }

    // ================================================================== both setters
    // Each test runs once for the user setter and once for the merchant setter.

    function test_zeroAddress_reverts_bothSetters_bothValues() public {
        for (uint256 u; u < 2; ++u) {
            for (uint256 v; v < 2; ++v) {
                Snapshot memory s = _snapshot();
                vm.expectRevert(IIndicoLedger.ZeroAddress.selector);
                _set(admin, u == 0, address(0), v == 0);
                _assertUnchanged(s);
            }
        }
    }

    function test_approveLedgerOrUsdc_reverts() public {
        address[2] memory bad = [address(ledger), address(usdc)];
        for (uint256 u; u < 2; ++u) {
            for (uint256 i; i < 2; ++i) {
                Snapshot memory s = _snapshot();
                vm.expectRevert(
                    abi.encodeWithSelector(IIndicoLedger.InvalidParticipant.selector, bad[i])
                );
                _set(admin, u == 0, bad[i], true);
                _assertUnchanged(s);
                assertEq(ledger.participantRole(bad[i]), ROLE_NONE);
            }
        }
    }

    function test_revokeLedgerOrUsdc_allowed_roleUnchanged() public {
        address[2] memory bad = [address(ledger), address(usdc)];
        for (uint256 u; u < 2; ++u) {
            for (uint256 i; i < 2; ++i) {
                _expectApprovalEvent(u == 0, bad[i], false);
                _set(admin, u == 0, bad[i], false);
                assertFalse(_flag(u == 0, bad[i]));
                assertEq(ledger.participantRole(bad[i]), ROLE_NONE);
            }
        }
    }

    function test_approveFresh_setsFlagRoleAndEvent() public {
        address[2] memory who = [makeAddr("freshUser"), makeAddr("freshMerchant")];
        for (uint256 u; u < 2; ++u) {
            Snapshot memory s = _snapshot();
            _expectApprovalEvent(u == 0, who[u], true);
            _set(admin, u == 0, who[u], true);
            assertTrue(_flag(u == 0, who[u]));
            assertFalse(_flag(u != 0, who[u]), "other flag untouched");
            assertEq(ledger.participantRole(who[u]), u == 0 ? ROLE_USER : ROLE_MERCHANT);
            _assertUnchanged(s);
        }
    }

    function test_approvalEmitsNothingElse() public {
        for (uint256 u; u < 2; ++u) {
            vm.recordLogs();
            _set(admin, u == 0, u == 0 ? makeAddr("u1") : makeAddr("m1"), true);
            assertEq(vm.getRecordedLogs().length, 1);
        }
    }

    /// @dev participantRole is set only by an approval, never by a revoke.
    function test_revokeNeverApproved_allowed_roleStaysNone() public {
        for (uint256 u; u < 2; ++u) {
            Snapshot memory s = _snapshot();
            _expectApprovalEvent(u == 0, x, false);
            _set(admin, u == 0, x, false);
            assertFalse(_flag(u == 0, x));
            assertEq(ledger.participantRole(x), ROLE_NONE);
            _assertUnchanged(s);
        }
    }

    function test_approveTwice_allowed_emitsBothTimes() public {
        address[2] memory who = [makeAddr("twiceUser"), makeAddr("twiceMerchant")];
        for (uint256 u; u < 2; ++u) {
            _set(admin, u == 0, who[u], true);
            _expectApprovalEvent(u == 0, who[u], true);
            _set(admin, u == 0, who[u], true);
            assertTrue(_flag(u == 0, who[u]));
        }
    }

    function test_revokeTwice_allowed_emitsBothTimes() public {
        address[2] memory who = [makeAddr("revUser"), makeAddr("revMerchant")];
        for (uint256 u; u < 2; ++u) {
            _set(admin, u == 0, who[u], true);
            _set(admin, u == 0, who[u], false);
            _expectApprovalEvent(u == 0, who[u], false);
            _set(admin, u == 0, who[u], false);
            assertFalse(_flag(u == 0, who[u]));
        }
    }

    function test_revoke_keepsRole() public {
        address[2] memory who = [makeAddr("keepUser"), makeAddr("keepMerchant")];
        for (uint256 u; u < 2; ++u) {
            _set(admin, u == 0, who[u], true);
            Snapshot memory s = _snapshot();
            _set(admin, u == 0, who[u], false);
            assertFalse(_flag(u == 0, who[u]));
            assertEq(ledger.participantRole(who[u]), u == 0 ? ROLE_USER : ROLE_MERCHANT);
            _assertUnchanged(s);
        }
    }

    // ------------------------------------------------------------------ D-22, permanent role

    function test_user_revoke_reapproveAsUser_succeeds() public {
        _setUser(x, true);
        _setUser(x, false);
        _setUser(x, true);
        assertTrue(ledger.approvedUser(x));
        assertEq(ledger.participantRole(x), ROLE_USER);
    }

    function test_merchant_revoke_reapproveAsMerchant_succeeds() public {
        _setMerchant(x, true);
        _setMerchant(x, false);
        _setMerchant(x, true);
        assertTrue(ledger.approvedMerchant(x));
        assertEq(ledger.participantRole(x), ROLE_MERCHANT);
    }

    function test_user_revoke_approveAsMerchant_reverts() public {
        _setUser(x, true);
        _setUser(x, false);
        Snapshot memory s = _snapshot();
        vm.expectRevert(abi.encodeWithSelector(IIndicoLedger.ParticipantRoleConflict.selector, x));
        _setMerchant(x, true);
        _assertUnchanged(s);
        assertEq(ledger.participantRole(x), ROLE_USER);
    }

    function test_merchant_revoke_approveAsUser_reverts() public {
        _setMerchant(x, true);
        _setMerchant(x, false);
        vm.expectRevert(abi.encodeWithSelector(IIndicoLedger.ParticipantRoleConflict.selector, x));
        _setUser(x, true);
        assertEq(ledger.participantRole(x), ROLE_MERCHANT);
    }

    function test_activeUser_approveAsMerchant_reverts() public {
        _setUser(x, true);
        vm.expectRevert(abi.encodeWithSelector(IIndicoLedger.ParticipantRoleConflict.selector, x));
        _setMerchant(x, true);
        assertTrue(ledger.approvedUser(x), "user approval untouched");
    }

    function test_activeMerchant_approveAsUser_reverts() public {
        _setMerchant(x, true);
        vm.expectRevert(abi.encodeWithSelector(IIndicoLedger.ParticipantRoleConflict.selector, x));
        _setUser(x, true);
        assertTrue(ledger.approvedMerchant(x), "merchant approval untouched");
    }

    function test_revokeOtherRoleNeverHeld_allowed() public {
        _setUser(x, true);
        _expectApprovalEvent(false, x, false);
        _setMerchant(x, false);
        assertTrue(ledger.approvedUser(x));
        assertFalse(ledger.approvedMerchant(x));
        assertEq(ledger.participantRole(x), ROLE_USER, "a revoke never sets the role");

        address y = makeAddr("y");
        _setMerchant(y, true);
        _setUser(y, false);
        assertEq(ledger.participantRole(y), ROLE_MERCHANT);
    }

    function test_adminOwnAddress_canBeApproved() public {
        _setUser(admin, true);
        assertTrue(ledger.approvedUser(admin));
    }

    /// @dev Check order: the zero address is reported before anything else.
    function test_checkOrder_zeroBeforeEverything() public {
        vm.expectRevert(IIndicoLedger.ZeroAddress.selector);
        _setMerchant(address(0), true);
    }

    function testFuzz_firstApprovalFixesRole(address a, bool userFirst) public {
        // Remapped, never discarded (INSTRUCTION 1.2): the fuzzer favours these three.
        if (a == address(0) || a == address(ledger) || a == address(usdc)) {
            a = makeAddr("remapped");
        }
        _set(admin, userFirst, a, true);
        uint8 role = userFirst ? ROLE_USER : ROLE_MERCHANT;
        assertEq(ledger.participantRole(a), role);
        _set(admin, userFirst, a, false);
        vm.expectRevert(abi.encodeWithSelector(IIndicoLedger.ParticipantRoleConflict.selector, a));
        _set(admin, !userFirst, a, true);
        assertEq(ledger.participantRole(a), role);
    }

    // ------------------------------------------------------------------ access, pause

    function test_setters_nonAdmins_revert() public {
        address[] memory who = _nonAdmins();
        for (uint256 u; u < 2; ++u) {
            for (uint256 v; v < 2; ++v) {
                for (uint256 i; i < who.length; ++i) {
                    Snapshot memory s = _snapshot();
                    vm.expectRevert(_deny(who[i]));
                    _set(who[i], u == 0, x, v == 0);
                    _assertUnchanged(s);
                }
            }
        }
    }

    function test_setters_whilePaused_allowed() public {
        _pause();
        _setUser(x, true);
        assertTrue(ledger.approvedUser(x));
        address m = makeAddr("pausedMerchant");
        _setMerchant(m, true);
        assertTrue(ledger.approvedMerchant(m));
        _setUser(x, false);
        assertFalse(ledger.approvedUser(x));
    }
}
