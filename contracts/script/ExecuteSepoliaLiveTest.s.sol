// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IndicoLedger} from "../src/IndicoLedger.sol";
import {IIndicoLedger} from "../src/interfaces/IIndicoLedger.sol";
import {LiquidateKeeper} from "./LiquidateKeeper.s.sol";

/// @notice Executes the complete live test journey and corner cases on Base Sepolia.
///         Uses the dummy private keys configured in contracts/.env.
contract ExecuteSepoliaLiveTest is Script {
    address internal constant LEDGER = 0x422D36E2198863C5b2A6B8E2865fBf5196de96cF;
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    bytes32 internal constant DOC_HASH_1 = keccak256("indico-asset-bill-of-exchange-001");
    bytes32 internal constant DOC_HASH_INVALID = keccak256("indico-asset-invalid-type");

    function run() external {
        uint256 merchantPk = vm.envUint("TEST_MERCHANT_PK");
        uint256 userPk = vm.envUint("TEST_USER_PK");

        address merchant = vm.addr(merchantPk);
        address user = vm.addr(userPk);

        IndicoLedger ledger = IndicoLedger(LEDGER);
        IERC20 usdc = IERC20(USDC);
        bytes32 terms = ledger.termsHash();

        console.log("=================================================");
        console.log("=== Base Sepolia Full Lifecycle & Corner Tests ===");
        console.log("=================================================");
        console.log("Target Ledger:   ", address(ledger));
        console.log("Test Merchant:   ", merchant);
        console.log("Test User:       ", user);
        console.log("Active termsHash:", vm.toString(terms));

        _phase1Deposit(ledger, usdc, merchant, merchantPk, terms);
        _phase2Mint(ledger, user, userPk, terms);
        _phase3CornerCases(ledger, merchant);
        _phase4Spend(ledger, user, merchant, userPk);
        uint256 loanId = _phase5Borrow(ledger, user, userPk);
        _phase6RepayProtection(ledger, merchant, loanId);
        _phase7Repay(ledger, usdc, user, userPk, loanId);
        _phase8Keeper(ledger);

        console.log("\n=================================================");
        console.log("=== ALL LIVE SEPOLIA TESTS & CORNER CASES PASSED ===");
        console.log("=================================================");
    }

    function _phase1Deposit(
        IndicoLedger ledger,
        IERC20 usdc,
        address merchant,
        uint256 merchantPk,
        bytes32 terms
    ) internal {
        console.log("\n--- Phase 1: Merchant Liquidity Deposit ---");
        vm.startBroadcast(merchantPk);

        if (!ledger.termsSigned(merchant)) {
            console.log("[1.1] Merchant signing terms...");
            ledger.signTerms(terms);
        } else {
            console.log("[1.1] Merchant terms already signed.");
        }

        uint256 depositAmt = 10e6;
        console.log("[1.2] Approving 10 USDC to IndicoLedger...");
        usdc.approve(address(ledger), depositAmt);

        console.log("[1.3] Depositing 10 USDC into pool...");
        ledger.deposit(depositAmt);

        vm.stopBroadcast();

        uint256 poolAfterDeposit = ledger.poolUsdc();
        uint256 merchantShares = ledger.shares(merchant);
        console.log("  -> Pool USDC:       ", poolAfterDeposit / 1e6, "USDC");
        console.log("  -> Merchant Shares: ", merchantShares);
        require(poolAfterDeposit >= 10e6, "Pool deposit failed");
        require(merchantShares > 0, "No shares minted");
    }

    function _phase2Mint(IndicoLedger ledger, address user, uint256 userPk, bytes32 terms)
        internal
    {
        console.log("\n--- Phase 2: User Terms & Asset Registration ---");
        vm.startBroadcast(userPk);

        if (!ledger.termsSigned(user)) {
            console.log("[2.1] User signing terms...");
            ledger.signTerms(terms);
        } else {
            console.log("[2.1] User terms already signed.");
        }

        console.log("[2.2] Registering asset (Bill of Exchange, 10.00 credit)...");
        ledger.registerAsset(DOC_HASH_1, 1, 10e6);

        vm.stopBroadcast();

        uint256 userCredit = ledger.credit(user);
        console.log("  -> User Credit:     ", userCredit / 1e6, "CREDIT");
        require(userCredit >= 10e6, "Credit not minted");
    }

    function _phase3CornerCases(IndicoLedger ledger, address merchant) internal {
        console.log("\n--- Phase 3: Corner Cases & Invariants ---");

        try ledger.registerAsset(DOC_HASH_1, 1, 10e6) {
            revert("FAIL: Duplicate docHash should have reverted!");
        } catch {
            console.log(
                "  [PASS] Corner Case A: Re-registering duplicate asset reverts (AssetAlreadyRegistered)."
            );
        }

        try ledger.registerAsset(DOC_HASH_INVALID, 6, 10e6) {
            revert("FAIL: Invalid asset type 6 should have reverted!");
        } catch {
            console.log("  [PASS] Corner Case B: Asset type 6 reverts (InvalidAssetType).");
        }

        try ledger.spend(merchant, 500e6) {
            revert("FAIL: Overspending credit should have reverted!");
        } catch {
            console.log("  [PASS] Corner Case C: Overspending credit reverts (InsufficientCredit).");
        }
    }

    function _phase4Spend(IndicoLedger ledger, address user, address merchant, uint256 userPk)
        internal
    {
        console.log("\n--- Phase 4: Credit Spending at Merchant ---");
        vm.startBroadcast(userPk);

        console.log("[4.1] Spending 2.00 credit at Merchant...");
        ledger.spend(merchant, 2e6);

        vm.stopBroadcast();

        uint256 userCreditAfterSpend = ledger.credit(user);
        uint256 merchantCreditAfterSpend = ledger.credit(merchant);
        console.log("  -> User Credit:     ", userCreditAfterSpend / 1e6, "CREDIT");
        console.log("  -> Merchant Credit: ", merchantCreditAfterSpend / 1e6, "CREDIT");
        require(userCreditAfterSpend == 8e6, "User credit balance mismatch");
        require(merchantCreditAfterSpend == 2e6, "Merchant credit balance mismatch");
    }

    function _phase5Borrow(IndicoLedger ledger, address user, uint256 userPk)
        internal
        returns (uint256 loanId)
    {
        console.log("\n--- Phase 5: Requesting Loan ---");
        vm.startBroadcast(userPk);

        uint256 borrowAmt = 4e6;
        console.log("[5.1] Requesting 4.00 USDC loan (locks 5.00 credit at 1.25x LTV)...");
        loanId = ledger.requestLoan(borrowAmt);

        vm.stopBroadcast();

        console.log("  -> Loan ID:         ", loanId);
        (address b, uint64 due,, uint8 status, uint128 p, uint128 k) = ledger.loans(loanId);
        console.log("  -> Borrower:        ", b);
        console.log("  -> Principal:       ", uint256(p) / 1e6, "USDC");
        console.log("  -> Collateral:      ", uint256(k) / 1e6, "CREDIT");
        console.log("  -> Due Date:        ", due);
        console.log("  -> Status (0=Active):", status);
        require(status == 0, "Loan not active");
        require(ledger.lockedCredit(user) == 5e6, "Locked credit mismatch");
    }

    function _phase6RepayProtection(IndicoLedger ledger, address merchant, uint256 loanId)
        internal
    {
        console.log("\n--- Phase 6: Corner Cases (Repayment Protection) ---");
        vm.prank(merchant);
        try ledger.repay(loanId) {
            revert("FAIL: Non-borrower repay should have reverted!");
        } catch {
            console.log(
                "  [PASS] Corner Case D: Non-borrower attempting to repay reverts (NotBorrower)."
            );
        }
    }

    function _phase7Repay(
        IndicoLedger ledger,
        IERC20 usdc,
        address user,
        uint256 userPk,
        uint256 loanId
    ) internal {
        console.log("\n--- Phase 7: Loan Repayment & Collateral Release ---");
        vm.startBroadcast(userPk);

        uint256 borrowAmt = 4e6;
        console.log("[7.1] User approving 4.00 USDC to IndicoLedger...");
        usdc.approve(address(ledger), borrowAmt);

        console.log("[7.2] User repaying Loan #1 in full...");
        ledger.repay(loanId);

        vm.stopBroadcast();

        (,,, uint8 statusAfterRepay,,) = ledger.loans(loanId);
        uint256 lockedAfterRepay = ledger.lockedCredit(user);
        uint256 poolAfterRepay = ledger.poolUsdc();
        console.log("  -> Status (1=Repaid):", statusAfterRepay);
        console.log("  -> Locked Credit:   ", lockedAfterRepay);
        console.log("  -> Restored Pool:   ", poolAfterRepay / 1e6, "USDC");
        require(statusAfterRepay == 1, "Loan not marked Repaid");
        require(lockedAfterRepay == 0, "Collateral not released");

        try ledger.repay(loanId) {
            revert("FAIL: Re-repaying should have reverted!");
        } catch {
            console.log("  [PASS] Corner Case E: Re-repaying repaid loan reverts (LoanNotActive).");
        }
    }

    function _phase8Keeper(IndicoLedger ledger) internal {
        console.log("\n--- Phase 8: Liquidation Keeper Inspection ---");
        LiquidateKeeper keeper = new LiquidateKeeper();
        uint256 overdueCount = keeper.findOverdueLoans(ledger).length;
        console.log("  -> Overdue loans found by keeper:", overdueCount);
        require(overdueCount == 0, "Keeper found overdue loans unexpectedly");
        console.log("  [PASS] Keeper cleanly confirmed 0 overdue loans.");
    }
}
