// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {IERC5313} from "@openzeppelin/contracts/interfaces/IERC5313.sol";
import {StateSnapshot} from "../helpers/StateSnapshot.sol";

/// @notice The top admin role under OpenZeppelin `AccessControlDefaultAdminRules`, D-19.
///         Called through OpenZeppelin's interfaces on `address(ledger)`, never the ledger type.
///
/// | Action                                  | Caller / timing                  | Expected                                        |
/// |-----------------------------------------|----------------------------------|-------------------------------------------------|
/// | after deploy                            |                                  | defaultAdmin admin, delay 3 days, none pending  |
/// | beginDefaultAdminTransfer(new)          | default admin                    | pending (new, now + 3 days), event              |
/// | beginDefaultAdminTransfer(new)          | anyone else, ADMIN_ROLE included | AccessControlUnauthorizedAccount(caller, 0x00)  |
/// | acceptDefaultAdminTransfer()            | new, at schedule exactly         | AccessControlEnforcedDefaultAdminDelay(schedule)|
/// | acceptDefaultAdminTransfer()            | new, at schedule + 1             | role moves, old loses it, ADMIN_ROLE untouched  |
/// | acceptDefaultAdminTransfer()            | not the pending address          | AccessControlInvalidDefaultAdmin(caller)        |
/// | acceptDefaultAdminTransfer()            | nothing pending                  | AccessControlInvalidDefaultAdmin(caller)        |
/// | cancelDefaultAdminTransfer()            | default admin                    | pending cleared, event, accept then fails       |
/// | grantRole(DEFAULT_ADMIN_ROLE, x)        | default admin                    | AccessControlEnforcedDefaultAdminRules          |
/// | revokeRole(DEFAULT_ADMIN_ROLE, admin)   | default admin                    | AccessControlEnforcedDefaultAdminRules          |
/// | renounceRole(DEFAULT_ADMIN_ROLE, admin) | nothing scheduled                | AccessControlEnforcedDefaultAdminDelay(0)       |
/// | renounceRole(DEFAULT_ADMIN_ROLE, admin) | transfer to 0 scheduled, passed  | role gone; the deliberate two-step path         |
/// | changeDefaultAdminDelay(1 day)          | default admin                    | DefaultAdminDelayChangeScheduled                |
/// | rollbackDefaultAdminDelay()             | default admin, change pending    | DefaultAdminDelayChangeCanceled                 |
/// | beginDefaultAdminTransfer while paused  | default admin                    | allowed; pause never blocks admin recovery      |
///
/// Constructor ordering (zero `admin_` gets the ledger's `ZeroAddress`, never OpenZeppelin's
/// `AccessControlInvalidDefaultAdmin(0)`) is asserted by the three zero-argument tests in
/// `Constructor.t.sol`, unchanged by this switch.
contract DefaultAdminTest is StateSnapshot {
    uint48 internal constant DELAY = 3 days;
    bytes32 internal constant DEFAULT_ADMIN = 0x00;

    address internal newAdmin = makeAddr("newAdmin");

    function _rules() internal view returns (IAccessControlDefaultAdminRules) {
        return IAccessControlDefaultAdminRules(address(ledger));
    }

    function _ac() internal view returns (IAccessControl) {
        return IAccessControl(address(ledger));
    }

    function _begin(address to) internal returns (uint48 schedule) {
        vm.prank(admin);
        _rules().beginDefaultAdminTransfer(to);
        (, schedule) = _rules().pendingDefaultAdmin();
    }

    // ------------------------------------------------------------------ after deploy

    function test_deploy_singleDefaultAdmin_threeDayDelay_nothingPending() public view {
        assertEq(_rules().defaultAdmin(), admin);
        assertEq(IERC5313(address(ledger)).owner(), admin);
        assertEq(_rules().defaultAdminDelay(), DELAY);
        (address pending, uint48 schedule) = _rules().pendingDefaultAdmin();
        assertEq(pending, address(0));
        assertEq(schedule, 0);
        (uint48 newDelay, uint48 effect) = _rules().pendingDefaultAdminDelay();
        assertEq(newDelay, 0);
        assertEq(effect, 0);
    }

    // ------------------------------------------------------------------ two-step transfer

    function test_begin_schedulesExactlyThreeDaysOut() public {
        uint48 expected = uint48(vm.getBlockTimestamp()) + DELAY;
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IAccessControlDefaultAdminRules.DefaultAdminTransferScheduled(newAdmin, expected);
        uint48 schedule = _begin(newAdmin);
        assertEq(schedule, expected);
        (address pending,) = _rules().pendingDefaultAdmin();
        assertEq(pending, newAdmin);
        assertEq(_rules().defaultAdmin(), admin, "nothing moves at begin");
    }

    function test_accept_atScheduleExactly_reverts() public {
        uint48 schedule = _begin(newAdmin);
        vm.warp(schedule);
        Snapshot memory s = _snapshot();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector,
                schedule
            )
        );
        vm.prank(newAdmin);
        _rules().acceptDefaultAdminTransfer();
        _assertUnchanged(s);
        assertEq(_rules().defaultAdmin(), admin);
    }

    function test_accept_oneSecondAfterSchedule_movesOnlyTheTopRole() public {
        uint48 schedule = _begin(newAdmin);
        vm.warp(uint256(schedule) + 1);

        vm.expectEmit(true, true, true, true, address(ledger));
        emit IAccessControl.RoleRevoked(DEFAULT_ADMIN, admin, newAdmin);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IAccessControl.RoleGranted(DEFAULT_ADMIN, newAdmin, newAdmin);
        vm.prank(newAdmin);
        _rules().acceptDefaultAdminTransfer();

        assertEq(_rules().defaultAdmin(), newAdmin);
        assertTrue(_ac().hasRole(DEFAULT_ADMIN, newAdmin));
        assertFalse(_ac().hasRole(DEFAULT_ADMIN, admin));
        assertTrue(_ac().hasRole(ledger.ADMIN_ROLE(), admin), "ADMIN_ROLE is separate");
        assertFalse(_ac().hasRole(ledger.ADMIN_ROLE(), newAdmin));
        (address pending, uint48 sch) = _rules().pendingDefaultAdmin();
        assertEq(pending, address(0));
        assertEq(sch, 0);
    }

    function test_accept_byWrongAddress_reverts() public {
        uint48 schedule = _begin(newAdmin);
        vm.warp(uint256(schedule) + 1);
        address[] memory wrong = _others();
        for (uint256 i; i < wrong.length; ++i) {
            Snapshot memory s = _snapshot();
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector,
                    wrong[i]
                )
            );
            vm.prank(wrong[i]);
            _rules().acceptDefaultAdminTransfer();
            _assertUnchanged(s);
        }
        assertEq(_rules().defaultAdmin(), admin);
    }

    function test_accept_withNothingPending_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, newAdmin
            )
        );
        vm.prank(newAdmin);
        _rules().acceptDefaultAdminTransfer();
    }

    function test_cancel_clearsPending_andAcceptThenFails() public {
        uint48 schedule = _begin(newAdmin);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IAccessControlDefaultAdminRules.DefaultAdminTransferCanceled();
        vm.prank(admin);
        _rules().cancelDefaultAdminTransfer();

        (address pending, uint48 sch) = _rules().pendingDefaultAdmin();
        assertEq(pending, address(0));
        assertEq(sch, 0);

        vm.warp(uint256(schedule) + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, newAdmin
            )
        );
        vm.prank(newAdmin);
        _rules().acceptDefaultAdminTransfer();
        assertEq(_rules().defaultAdmin(), admin);
    }

    function test_begin_byAnyoneButTheDefaultAdmin_reverts() public {
        address[] memory who = _others();
        for (uint256 i; i < who.length; ++i) {
            Snapshot memory s = _snapshot();
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector, who[i], DEFAULT_ADMIN
                )
            );
            vm.prank(who[i]);
            _rules().beginDefaultAdminTransfer(who[i]);
            _assertUnchanged(s);
        }
        (address pending,) = _rules().pendingDefaultAdmin();
        assertEq(pending, address(0));
    }

    function test_adminRoleHolder_isNotTheDefaultAdmin() public {
        address second = makeAddr("secondAdmin");
        bytes32 adminRole = ledger.ADMIN_ROLE();
        vm.prank(admin);
        _ac().grantRole(adminRole, second);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, second, DEFAULT_ADMIN
            )
        );
        vm.prank(second);
        _rules().beginDefaultAdminTransfer(second);
    }

    // ------------------------------------------------------------------ no one-step paths

    function test_grantDefaultAdminRole_reverts() public {
        Snapshot memory s = _snapshot();
        vm.expectRevert(
            IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminRules.selector
        );
        vm.prank(admin);
        _ac().grantRole(DEFAULT_ADMIN, newAdmin);
        _assertUnchanged(s);
        assertFalse(_ac().hasRole(DEFAULT_ADMIN, newAdmin));
    }

    function test_revokeDefaultAdminRole_reverts() public {
        Snapshot memory s = _snapshot();
        vm.expectRevert(
            IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminRules.selector
        );
        vm.prank(admin);
        _ac().revokeRole(DEFAULT_ADMIN, admin);
        _assertUnchanged(s);
        assertTrue(_ac().hasRole(DEFAULT_ADMIN, admin));
    }

    function test_renounceWithoutSchedule_reverts() public {
        Snapshot memory s = _snapshot();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, 0
            )
        );
        vm.prank(admin);
        _ac().renounceRole(DEFAULT_ADMIN, admin);
        _assertUnchanged(s);
        assertEq(_rules().defaultAdmin(), admin);
    }

    /// @dev Losing the role is possible only on purpose: schedule a transfer to zero, wait the
    ///      delay, then renounce.
    function test_renounce_afterScheduledTransferToZero_isTheOnlyWayToLoseIt() public {
        uint48 schedule = _begin(address(0));
        vm.warp(uint256(schedule) + 1);
        vm.prank(admin);
        _ac().renounceRole(DEFAULT_ADMIN, admin);
        assertEq(_rules().defaultAdmin(), address(0));
        assertFalse(_ac().hasRole(DEFAULT_ADMIN, admin));
    }

    // ------------------------------------------------------------------ the delay itself

    function test_changeDelay_isScheduled_andRollbackCancels() public {
        uint48 newDelay = 1 days;
        // A decrease waits the difference between the old and new delay.
        uint48 effect = uint48(vm.getBlockTimestamp()) + (DELAY - newDelay);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IAccessControlDefaultAdminRules.DefaultAdminDelayChangeScheduled(newDelay, effect);
        vm.prank(admin);
        _rules().changeDefaultAdminDelay(newDelay);
        assertEq(_rules().defaultAdminDelay(), DELAY, "not yet in effect");

        vm.expectEmit(true, true, true, true, address(ledger));
        emit IAccessControlDefaultAdminRules.DefaultAdminDelayChangeCanceled();
        vm.prank(admin);
        _rules().rollbackDefaultAdminDelay();
        (uint48 pendingDelay, uint48 pendingEffect) = _rules().pendingDefaultAdminDelay();
        assertEq(pendingDelay, 0);
        assertEq(pendingEffect, 0);
        assertEq(_rules().defaultAdminDelay(), DELAY);
    }

    function test_changeDelay_byNonDefaultAdmin_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, DEFAULT_ADMIN
            )
        );
        vm.prank(guardian);
        _rules().changeDefaultAdminDelay(0);
    }

    // ------------------------------------------------------------------ pause

    function test_transferStillWorksWhilePaused() public {
        _pause();
        uint48 schedule = _begin(newAdmin);
        vm.warp(uint256(schedule) + 1);
        vm.prank(newAdmin);
        _rules().acceptDefaultAdminTransfer();
        assertEq(_rules().defaultAdmin(), newAdmin);
    }

    function _others() internal returns (address[] memory w) {
        w = new address[](8);
        (w[0], w[1], w[2], w[3]) = (guardian, alice, bob, merchantA);
        (w[4], w[5], w[6], w[7]) = (merchantB, address(this), address(ledger), makeAddr("random"));
    }
}
