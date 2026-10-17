// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IndicoLedger} from "../src/IndicoLedger.sol";

/// @notice Onboards TestMerchant1 and TestUser1 for Base Sepolia live test (Option 2).
///         - Sets termsHash on the ledger if not already set
///         - Approves TestMerchant1 as Merchant
///         - Approves TestUser1 as User with random accountRef
///         - Funds TestMerchant1 with ETH (gas) and 10 USDC (liquidity)
///         - Funds TestUser1 with ETH (gas) and 5 USDC (repayment)
contract OnboardParticipants is Script {
    address internal constant LEDGER = 0xa51D54BAe8431f4c6f0dd644D2fCeb498CE5eeF0;
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    address internal constant TEST_MERCHANT = 0x7b4C1E792d0ef3942f479E74de6043A6238a8fd1;
    address internal constant TEST_USER = 0xD785f1668D59710199d8b9aF37eD31883621Aa65;

    bytes32 internal constant TERMS_HASH = keccak256("indico-terms-v1-sepolia");
    bytes32 internal constant USER_ACCOUNT_REF = keccak256("indico-user-account-ref-1");

    function run() external {
        IndicoLedger ledger = IndicoLedger(LEDGER);
        IERC20 usdc = IERC20(USDC);

        console.log("=== Base Sepolia Onboarding ===");
        console.log("Ledger:        ", address(ledger));
        console.log("Deployer:      ", msg.sender);
        console.log("TestMerchant1: ", TEST_MERCHANT);
        console.log("TestUser1:     ", TEST_USER);

        vm.startBroadcast();

        // 1. Set termsHash if not set
        if (ledger.termsHash() == bytes32(0)) {
            console.log("Setting termsHash on IndicoLedger...");
            ledger.setTermsHash(TERMS_HASH);
        } else {
            console.log("termsHash already set:", vm.toString(ledger.termsHash()));
        }

        // 2. Approve Merchant
        if (!ledger.approvedMerchant(TEST_MERCHANT)) {
            console.log("Approving TestMerchant1 as Merchant...");
            ledger.setMerchantApproved(TEST_MERCHANT, true);
        } else {
            console.log("TestMerchant1 already approved.");
        }

        // 3. Approve User
        if (!ledger.approvedUser(TEST_USER)) {
            console.log("Approving TestUser1 as User...");
            ledger.setUserApproved(TEST_USER, true, USER_ACCOUNT_REF);
        } else {
            console.log("TestUser1 already approved.");
        }

        // 4. Fund TestMerchant1 with ETH for gas (0.03 ETH)
        if (TEST_MERCHANT.balance < 0.02 ether) {
            console.log("Sending 0.03 ETH gas to TestMerchant1...");
            payable(TEST_MERCHANT).transfer(0.03 ether);
        }

        // 5. Fund TestUser1 with ETH for gas (0.03 ETH)
        if (TEST_USER.balance < 0.02 ether) {
            console.log("Sending 0.03 ETH gas to TestUser1...");
            payable(TEST_USER).transfer(0.03 ether);
        }

        // 6. Transfer 10 USDC to TestMerchant1 for deposit
        if (usdc.balanceOf(TEST_MERCHANT) < 10e6) {
            console.log("Transferring 10 USDC to TestMerchant1...");
            usdc.transfer(TEST_MERCHANT, 10e6);
        }

        // 7. Transfer 5 USDC to TestUser1 for repayment
        if (usdc.balanceOf(TEST_USER) < 5e6) {
            console.log("Transferring 5 USDC to TestUser1...");
            usdc.transfer(TEST_USER, 5e6);
        }

        vm.stopBroadcast();

        console.log("=== Onboarding Complete ===");
        console.log("Merchant ETH:  ", TEST_MERCHANT.balance);
        console.log("Merchant USDC: ", usdc.balanceOf(TEST_MERCHANT));
        console.log("User ETH:      ", TEST_USER.balance);
        console.log("User USDC:     ", usdc.balanceOf(TEST_USER));
    }
}
