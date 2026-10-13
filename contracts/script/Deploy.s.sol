// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IndicoLedger} from "../src/IndicoLedger.sol";

/// @notice Deploys the ledger (P3.1). Run by the owner, from a keystore account, never a key in a
///         file:
///
///         forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --account deployer \
///             --broadcast --verify --etherscan-api-key $BASE_SCAN_API_KEY
///
///         Required environment variables (set in contracts/.env or the shell):
///           ADMIN_ADDRESS   – address that receives DEFAULT_ADMIN_ROLE and ADMIN_ROLE
///           GUARDIAN_ADDRESS – address that receives GUARDIAN_ROLE (may equal ADMIN_ADDRESS, D-15)
///           TESTNET_EOA     – set to "true" on Base Sepolia to allow an EOA admin (D-68);
///                             must be unset or "false" on mainnet, which requires a Safe (CS §3)
///
///         USDC is pinned per chain-id from Circle's published list (checked 2026-10-13):
///           Base 8453:         0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
///           Base Sepolia 84532: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
///         Any other chain is refused.
///
///         After deploying, the script asserts the roles: admin holds the top role and ADMIN_ROLE,
///         guardian holds GUARDIAN_ROLE, the deployer holds nothing (unless the deployer is the admin).
contract Deploy is Script {
    uint256 internal constant BASE = 8453;
    uint256 internal constant BASE_SEPOLIA = 84532;
    address internal constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    error UnsupportedChain(uint256 chainId);
    error NotAContract(string role, address account);
    error EoaNotAllowedOnMainnet(string role, address account);
    error RoleCheckFailed(string what);

    function run() external returns (IndicoLedger ledger) {
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address guardian = vm.envAddress("GUARDIAN_ADDRESS");
        bool testnetEoa = _isTestnetEoa();

        vm.startBroadcast();
        address deployer = msg.sender;
        ledger = deploy(admin, guardian, testnetEoa);
        vm.stopBroadcast();

        check(ledger, admin, guardian, deployer);

        console.log("IndicoLedger deployed at:", address(ledger));
        console.log("chain id:                ", block.chainid);
        console.log("block:                   ", block.number);
        console.log("admin:                   ", admin);
        console.log("guardian:                ", guardian);
        console.log("usdc:                    ", address(ledger.usdc()));
    }

    /// @notice The USDC the ledger must use on this chain.
    function usdcFor(uint256 chainId) public pure returns (address) {
        if (chainId == BASE) return USDC_BASE;
        if (chainId == BASE_SEPOLIA) return USDC_BASE_SEPOLIA;
        revert UnsupportedChain(chainId);
    }

    function deploy(address admin, address guardian) public returns (IndicoLedger) {
        return deploy(admin, guardian, false);
    }

    function deploy(address admin, address guardian, bool testnetEoa)
        public
        returns (IndicoLedger)
    {
        address usdc = usdcFor(block.chainid);

        if (block.chainid == BASE) {
            // Mainnet: both admin and guardian must be contracts (Safes, CS §3). D-68.
            if (admin.code.length == 0) revert EoaNotAllowedOnMainnet("admin", admin);
            if (guardian.code.length == 0) revert EoaNotAllowedOnMainnet("guardian", guardian);
        } else if (!testnetEoa) {
            // Testnet without the EOA override: still require contracts (D-68).
            if (admin.code.length == 0) revert NotAContract("admin", admin);
            if (guardian.code.length == 0) revert NotAContract("guardian", guardian);
        }
        // testnetEoa == true on Base Sepolia: EOA admin allowed for testnet (D-68).

        return new IndicoLedger(IERC20(usdc), admin, guardian);
    }

    /// @notice Role assertions after deployment: exactly the configured addresses, never the deployer.
    function check(IndicoLedger ledger, address admin, address guardian, address deployer)
        public
        view
    {
        IAccessControl ac = IAccessControl(address(ledger));
        bytes32 top = 0x00; // DEFAULT_ADMIN_ROLE
        if (address(ledger.usdc()) != usdcFor(block.chainid)) revert RoleCheckFailed("usdc");
        if (!ac.hasRole(top, admin)) revert RoleCheckFailed("admin top role");
        if (!ac.hasRole(ledger.ADMIN_ROLE(), admin)) revert RoleCheckFailed("admin role");
        if (!ac.hasRole(ledger.GUARDIAN_ROLE(), guardian)) revert RoleCheckFailed("guardian role");
        if (deployer != admin && deployer != guardian) {
            if (ac.hasRole(top, deployer)) revert RoleCheckFailed("deployer top role");
            if (ac.hasRole(ledger.ADMIN_ROLE(), deployer)) {
                revert RoleCheckFailed("deployer admin");
            }
            if (ac.hasRole(ledger.GUARDIAN_ROLE(), deployer)) {
                revert RoleCheckFailed("deployer guardian");
            }
        }
    }

    function _isTestnetEoa() internal view returns (bool) {
        try vm.envBool("TESTNET_EOA") returns (bool v) {
            return v;
        } catch {
            return false;
        }
    }
}
