// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IndicoLedger} from "../../src/IndicoLedger.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {MockUSDC} from "../helpers/MockUSDC.sol";

/// @dev Stands in for a Safe: any contract will do for the "is a contract" check.
contract FakeSafe {}

/// @notice The deploy script (P3.1). The token at Circle's address is the 6-decimal mock, placed
///         there with `vm.etch`, so the script runs as it will on the real chain.
///
/// chain: Base Sepolia 84532 and Base 8453 deploy on their pinned USDC; any other (1, 31337)
///        reverts UnsupportedChain(chainId).
/// admin, guardian: a contract deploys; a plain wallet or zero reverts NotAContract(role, account);
///        the same Safe for both deploys (D-15).
/// after deploy: the Safes hold exactly their roles, the deployer none; `check` refuses a ledger
///        whose roles are anything else.
contract DeployTest is Test {
    address internal constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    Deploy internal script;
    address internal adminSafe;
    address internal guardianSafe;

    function setUp() public {
        script = new Deploy();
        adminSafe = address(new FakeSafe());
        guardianSafe = address(new FakeSafe());
        bytes memory code = address(new MockUSDC()).code;
        vm.etch(USDC_BASE_SEPOLIA, code);
        vm.etch(USDC_BASE, code);
        vm.chainId(84532);
    }

    function test_run_baseSepolia_deploysOnCircleUsdc_rolesExact() public {
        vm.setEnv("ADMIN_ADDRESS", vm.toString(adminSafe));
        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(guardianSafe));
        IndicoLedger ledger = script.run();
        IAccessControl ac = IAccessControl(address(ledger));
        assertEq(address(ledger.usdc()), USDC_BASE_SEPOLIA);
        assertTrue(ac.hasRole(0x00, adminSafe));
        assertTrue(ac.hasRole(ledger.ADMIN_ROLE(), adminSafe));
        assertTrue(ac.hasRole(ledger.GUARDIAN_ROLE(), guardianSafe));
        assertFalse(ac.hasRole(ledger.ADMIN_ROLE(), guardianSafe));
        assertFalse(ac.hasRole(ledger.GUARDIAN_ROLE(), adminSafe));
        address deployer = msg.sender; // the broadcaster `run` used
        assertFalse(ac.hasRole(0x00, deployer));
        assertFalse(ac.hasRole(ledger.ADMIN_ROLE(), deployer));
        assertFalse(ac.hasRole(ledger.GUARDIAN_ROLE(), deployer));
    }

    function test_deploy_base_usesMainnetUsdc() public {
        vm.chainId(8453);
        IndicoLedger ledger = script.deploy(adminSafe, guardianSafe);
        assertEq(address(ledger.usdc()), USDC_BASE);
    }

    function test_deploy_sameSafeForBoth_allowed() public {
        IndicoLedger ledger = script.deploy(adminSafe, adminSafe);
        assertTrue(IAccessControl(address(ledger)).hasRole(ledger.GUARDIAN_ROLE(), adminSafe));
    }

    function test_deploy_testnetEoa_allowedOnBaseSepolia() public {
        address eoa = makeAddr("eoa-admin");
        IndicoLedger ledger = script.deploy(eoa, eoa, true);
        IAccessControl ac = IAccessControl(address(ledger));
        assertTrue(ac.hasRole(0x00, eoa));
        assertTrue(ac.hasRole(ledger.ADMIN_ROLE(), eoa));
        assertTrue(ac.hasRole(ledger.GUARDIAN_ROLE(), eoa));
    }

    function test_deploy_testnetEoa_refusedOnMainnet() public {
        vm.chainId(8453);
        address eoa = makeAddr("eoa-admin");
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.EoaNotAllowedOnMainnet.selector, "admin", eoa)
        );
        script.deploy(eoa, guardianSafe, true);

        vm.expectRevert(
            abi.encodeWithSelector(Deploy.EoaNotAllowedOnMainnet.selector, "guardian", eoa)
        );
        script.deploy(adminSafe, eoa, true);
    }

    function test_deploy_otherChains_refused() public {
        uint256[3] memory chains = [uint256(1), 31337, 11155111];
        for (uint256 i; i < chains.length; i++) {
            vm.chainId(chains[i]);
            vm.expectRevert(abi.encodeWithSelector(Deploy.UnsupportedChain.selector, chains[i]));
            script.deploy(adminSafe, guardianSafe);
        }
    }

    function test_deploy_adminNotAContract_refused() public {
        address wallet = makeAddr("plain-wallet");
        vm.expectRevert(abi.encodeWithSelector(Deploy.NotAContract.selector, "admin", wallet));
        script.deploy(wallet, guardianSafe);
        vm.expectRevert(abi.encodeWithSelector(Deploy.NotAContract.selector, "admin", address(0)));
        script.deploy(address(0), guardianSafe);
    }

    function test_deploy_guardianNotAContract_refused() public {
        address wallet = makeAddr("plain-wallet");
        vm.expectRevert(abi.encodeWithSelector(Deploy.NotAContract.selector, "guardian", wallet));
        script.deploy(adminSafe, wallet);
    }

    function test_check_refusesWrongRoles() public {
        IndicoLedger ledger = script.deploy(adminSafe, guardianSafe);
        address other = address(new FakeSafe());
        vm.expectRevert(abi.encodeWithSelector(Deploy.RoleCheckFailed.selector, "admin top role"));
        script.check(ledger, other, guardianSafe, address(this));
        vm.expectRevert(abi.encodeWithSelector(Deploy.RoleCheckFailed.selector, "guardian role"));
        script.check(ledger, adminSafe, other, address(this));
        // a ledger the deployer kept a role in
        IndicoLedger kept = new IndicoLedger(IERC20(USDC_BASE_SEPOLIA), address(this), guardianSafe);
        vm.expectRevert(abi.encodeWithSelector(Deploy.RoleCheckFailed.selector, "admin top role"));
        script.check(kept, adminSafe, guardianSafe, address(this));
    }

    function test_check_refusesWrongUsdc() public {
        MockUSDC other = new MockUSDC();
        IndicoLedger ledger = new IndicoLedger(IERC20(address(other)), adminSafe, guardianSafe);
        vm.expectRevert(abi.encodeWithSelector(Deploy.RoleCheckFailed.selector, "usdc"));
        script.check(ledger, adminSafe, guardianSafe, address(this));
    }
}
