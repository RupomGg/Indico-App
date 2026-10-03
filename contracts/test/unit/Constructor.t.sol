// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IndicoLedger} from "../../src/IndicoLedger.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {StateSnapshot} from "../helpers/StateSnapshot.sol";

/// @dev ERC-20 stand-ins whose `decimals()` is wrong in one specific way.
contract DecimalsToken {
    uint256 internal immutable value;

    constructor(uint256 v) {
        value = v;
    }

    /// @dev Returns a full word, so values above 255 reach the ledger undecoded.
    function decimals() external view returns (uint256) {
        return value;
    }
}

contract RevertingDecimalsToken {
    function decimals() external pure returns (uint8) {
        revert("no decimals");
    }
}

/// @dev Has code but no `decimals()` and a fallback that returns nothing.
contract SilentToken {
    fallback() external {}
}

/// @dev `decimals()` never returns; the call runs out of the gas it was forwarded.
contract GasBurningToken {
    function decimals() external pure returns (uint8) {
        while (true) {}
        return 6;
    }
}

/// @dev Has code but no `decimals()` and no fallback, so the call reverts with no data.
contract NoDecimalsToken {
    function name() external pure returns (string memory) {
        return "none";
    }
}

/// @notice Constructor and roles, contract-spec 3 and 6.0, D-15, D-16.
///
/// Partition table for constructor(IERC20 usdc_, address admin_, address guardian_)
///
/// | Param     | Class                              | Expected                                   |
/// |-----------|------------------------------------|--------------------------------------------|
/// | usdc_     | zero address                       | ZeroAddress                                |
/// | usdc_     | EOA, no code                       | UsdcNotAContract(token)                    |
/// | usdc_     | precompile address(1), no code     | UsdcNotAContract(token)                    |
/// | usdc_     | the ledger's own future address    | UsdcNotAContract(token), it has no code yet |
/// | usdc_     | decimals() == 18                   | UsdcWrongDecimals(18)                      |
/// | usdc_     | decimals() == 0                    | UsdcWrongDecimals(0)                       |
/// | usdc_     | decimals() == 5 and 7 (either side)| UsdcWrongDecimals(5), UsdcWrongDecimals(7) |
/// | usdc_     | decimals() == 256, not a uint8     | UsdcWrongDecimals(256)                     |
/// | usdc_     | decimals() reverts with a reason   | UsdcDecimalsUnreadable(token)              |
/// | usdc_     | no decimals(), reverts empty       | UsdcDecimalsUnreadable(token)              |
/// | usdc_     | no decimals(), returns nothing     | UsdcDecimalsUnreadable(token)              |
/// | usdc_     | decimals() burns all its gas       | UsdcDecimalsUnreadable(token), 1/64 kept   |
/// | usdc_     | MockUSDC, decimals() == 6          | deploys, usdc() == token                   |
/// | admin_    | zero address                       | ZeroAddress                                |
/// | admin_    | typical                            | DEFAULT_ADMIN_ROLE and ADMIN_ROLE, only    |
/// | admin_    | equal to guardian_ (D-15)          | deploys, holds all three roles             |
/// | guardian_ | zero address                       | ZeroAddress                                |
/// | guardian_ | typical                            | GUARDIAN_ROLE, only                        |
/// | all three | zero together                      | ZeroAddress, zero checks run first         |
/// | usdc_ = 0 | with valid admin and guardian      | ZeroAddress, not UsdcNotAContract          |
contract ConstructorTest is StateSnapshot {
    bytes32 internal constant DEFAULT_ADMIN = 0x00;

    function _deployExpectingRevert(address token, address a, address g, bytes memory err)
        internal
    {
        vm.expectRevert(err);
        new IndicoLedger(IERC20(token), a, g);
    }

    // ------------------------------------------------------------------ zero addresses

    function test_usdcZero_reverts() public {
        _deployExpectingRevert(
            address(0), admin, guardian, abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector)
        );
    }

    function test_adminZero_reverts() public {
        _deployExpectingRevert(
            address(usdc),
            address(0),
            guardian,
            abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector)
        );
    }

    function test_guardianZero_reverts() public {
        _deployExpectingRevert(
            address(usdc),
            admin,
            address(0),
            abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector)
        );
    }

    function test_allZero_revertsZeroAddress() public {
        _deployExpectingRevert(
            address(0),
            address(0),
            address(0),
            abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector)
        );
    }

    // ------------------------------------------------------------------ usdc_ has code

    function test_usdcIsEoa_reverts() public {
        address eoa = makeAddr("eoa");
        _deployExpectingRevert(
            eoa,
            admin,
            guardian,
            abi.encodeWithSelector(IIndicoLedger.UsdcNotAContract.selector, eoa)
        );
    }

    function test_usdcIsPrecompile_reverts() public {
        _deployExpectingRevert(
            address(1),
            admin,
            guardian,
            abi.encodeWithSelector(IIndicoLedger.UsdcNotAContract.selector, address(1))
        );
    }

    function test_usdcIsTheLedgerItself_reverts() public {
        address future = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        _deployExpectingRevert(
            future,
            admin,
            guardian,
            abi.encodeWithSelector(IIndicoLedger.UsdcNotAContract.selector, future)
        );
    }

    // ------------------------------------------------------------------ usdc_ decimals

    function test_decimals18_reverts() public {
        _assertWrongDecimals(18);
    }

    function test_decimals0_reverts() public {
        _assertWrongDecimals(0);
    }

    function test_decimals5_reverts() public {
        _assertWrongDecimals(5);
    }

    function test_decimals7_reverts() public {
        _assertWrongDecimals(7);
    }

    function test_decimals256_reverts() public {
        _assertWrongDecimals(256);
    }

    function testFuzz_decimalsNotSix_alwaysNamedRevert(uint256 d) public {
        if (d == 6) d = 7; // remapped, never discarded (INSTRUCTION 1.2)
        _assertWrongDecimals(d);
    }

    function test_decimalsReverts_reverts() public {
        address t = address(new RevertingDecimalsToken());
        _deployExpectingRevert(
            t,
            admin,
            guardian,
            abi.encodeWithSelector(IIndicoLedger.UsdcDecimalsUnreadable.selector, t)
        );
    }

    function test_noDecimalsFunction_reverts() public {
        address t = address(new NoDecimalsToken());
        _deployExpectingRevert(
            t,
            admin,
            guardian,
            abi.encodeWithSelector(IIndicoLedger.UsdcDecimalsUnreadable.selector, t)
        );
    }

    function test_decimalsReturnsNothing_reverts() public {
        address t = address(new SilentToken());
        _deployExpectingRevert(
            t,
            admin,
            guardian,
            abi.encodeWithSelector(IIndicoLedger.UsdcDecimalsUnreadable.selector, t)
        );
    }

    function test_decimalsBurnsAllGas_reverts() public {
        address t = address(new GasBurningToken());
        _deployExpectingRevert(
            t,
            admin,
            guardian,
            abi.encodeWithSelector(IIndicoLedger.UsdcDecimalsUnreadable.selector, t)
        );
    }

    function _assertWrongDecimals(uint256 d) internal {
        address t = address(new DecimalsToken(d));
        _deployExpectingRevert(
            t, admin, guardian, abi.encodeWithSelector(IIndicoLedger.UsdcWrongDecimals.selector, d)
        );
    }

    // ------------------------------------------------------------------ happy path

    function test_deploy_usdcAndNotPaused() public view {
        assertEq(address(ledger.usdc()), address(usdc));
        assertFalse(Pausable(address(ledger)).paused());
    }

    function test_deploy_emitsExactlyThreeRoleGrants() public {
        vm.recordLogs();
        address deployed = address(new IndicoLedger(usdc, admin, guardian));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 3, "exactly three events");
        _assertRoleGranted(logs[0], deployed, DEFAULT_ADMIN, admin);
        _assertRoleGranted(logs[1], deployed, ledger.ADMIN_ROLE(), admin);
        _assertRoleGranted(logs[2], deployed, ledger.GUARDIAN_ROLE(), guardian);
    }

    function _assertRoleGranted(Vm.Log memory l, address emitter, bytes32 role, address account)
        internal
        view
    {
        assertEq(l.emitter, emitter, "emitter");
        assertEq(l.topics.length, 4, "topics");
        assertEq(l.topics[0], IAccessControl.RoleGranted.selector, "event");
        assertEq(l.topics[1], role, "role");
        assertEq(l.topics[2], bytes32(uint256(uint160(account))), "account");
        assertEq(l.topics[3], bytes32(uint256(uint160(address(this)))), "sender");
    }

    function test_roleIds() public view {
        assertEq(ledger.ADMIN_ROLE(), keccak256("ADMIN_ROLE"));
        assertEq(ledger.GUARDIAN_ROLE(), keccak256("GUARDIAN_ROLE"));
    }

    function test_everyRoleIsAdministeredByDefaultAdmin() public view {
        IAccessControl ac = IAccessControl(address(ledger));
        assertEq(ac.getRoleAdmin(DEFAULT_ADMIN), DEFAULT_ADMIN);
        assertEq(ac.getRoleAdmin(ledger.ADMIN_ROLE()), DEFAULT_ADMIN);
        assertEq(ac.getRoleAdmin(ledger.GUARDIAN_ROLE()), DEFAULT_ADMIN);
    }

    /// @dev Exact holders over every address the suite knows, plus the edge addresses.
    function test_rolesHeldByExactlyTheRightAddresses() public {
        IAccessControl ac = IAccessControl(address(ledger));
        bytes32[3] memory roles = [DEFAULT_ADMIN, ledger.ADMIN_ROLE(), ledger.GUARDIAN_ROLE()];
        address[] memory who = _everyone();
        for (uint256 r; r < 3; ++r) {
            for (uint256 i; i < who.length; ++i) {
                bool expected = (r < 2 && who[i] == admin) || (r == 2 && who[i] == guardian);
                assertEq(ac.hasRole(roles[r], who[i]), expected, vm.toString(who[i]));
            }
        }
    }

    function test_adminEqualsGuardian_holdsAllThree() public {
        IAccessControl ac = IAccessControl(address(new IndicoLedger(usdc, admin, admin)));
        IIndicoLedger l = IIndicoLedger(address(ac));
        assertTrue(ac.hasRole(DEFAULT_ADMIN, admin));
        assertTrue(ac.hasRole(l.ADMIN_ROLE(), admin));
        assertTrue(ac.hasRole(l.GUARDIAN_ROLE(), admin));
        assertFalse(ac.hasRole(l.GUARDIAN_ROLE(), guardian));
    }

    // ------------------------------------------------------------------ no role moves USDC

    /// @dev Every caller tries every state-changing function that exists in this portion.
    ///      Extend `_calls` as each portion adds functions.
    function test_noCallerCanMoveUsdc_throughAnyFunction() public {
        usdc.mint(address(ledger), 500_000e6);
        address[] memory callers = _everyone();
        for (uint256 i; i < callers.length; ++i) {
            bytes[] memory calls = _calls(callers[i]);
            for (uint256 j; j < calls.length; ++j) {
                Snapshot memory s = _snapshot();
                vm.prank(callers[i]);
                (bool ok,) = address(ledger).call(calls[j]);
                ok;
                assertEq(_snapshot().usdc, s.usdc, "an actor's USDC moved");
                assertEq(usdc.balanceOf(address(ledger)), s.ledgerUsdc, "ledger USDC moved");
            }
        }
    }

    function _calls(address caller) internal view returns (bytes[] memory c) {
        bytes32 adminRole = ledger.ADMIN_ROLE();
        bytes32 guardianRole = ledger.GUARDIAN_ROLE();
        c = new bytes[](17);
        c[0] = abi.encodeCall(IIndicoLedger.pause, ());
        c[1] = abi.encodeCall(IIndicoLedger.unpause, ());
        c[2] = abi.encodeCall(IAccessControl.grantRole, (adminRole, caller));
        c[3] = abi.encodeCall(IAccessControl.grantRole, (guardianRole, caller));
        c[4] = abi.encodeCall(IAccessControl.revokeRole, (adminRole, admin));
        c[5] = abi.encodeCall(IAccessControl.renounceRole, (guardianRole, caller));
        c[6] = abi.encodeCall(IAccessControl.renounceRole, (DEFAULT_ADMIN, caller));
        c[7] = abi.encodeCall(IAccessControlDefaultAdminRules.beginDefaultAdminTransfer, (caller));
        c[8] = abi.encodeCall(IAccessControlDefaultAdminRules.cancelDefaultAdminTransfer, ());
        c[9] = abi.encodeCall(IAccessControlDefaultAdminRules.acceptDefaultAdminTransfer, ());
        c[10] = abi.encodeCall(IAccessControlDefaultAdminRules.changeDefaultAdminDelay, (0));
        c[11] = abi.encodeCall(IAccessControlDefaultAdminRules.rollbackDefaultAdminDelay, ());
        c[12] = abi.encodeCall(IIndicoLedger.setTermsHash, (keccak256("sweep")));
        c[13] = abi.encodeCall(IIndicoLedger.setUserApproved, (caller, true));
        c[14] = abi.encodeCall(IIndicoLedger.setMerchantApproved, (caller, true));
        c[15] = abi.encodeCall(IIndicoLedger.signTerms, (keccak256("sweep")));
        c[16] = abi.encodeCall(IIndicoLedger.registerAsset, (keccak256("sweep-doc"), 0, 1_000e6));
    }

    function _everyone() internal returns (address[] memory w) {
        w = new address[](10);
        (w[0], w[1], w[2], w[3]) = (admin, guardian, alice, bob);
        (w[4], w[5], w[6]) = (merchantA, merchantB, address(this));
        (w[7], w[8], w[9]) = (address(ledger), address(usdc), makeAddr("random"));
    }
}
