// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IndicoLedger} from "../../src/IndicoLedger.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";

/// @dev The parts of Circle's FiatToken (USDC v2) these tests use.
interface IFiatToken is IERC20 {
    function masterMinter() external view returns (address);
    function blacklister() external view returns (address);
    function configureMinter(address minter, uint256 allowance) external returns (bool);
    function mint(address to, uint256 amount) external returns (bool);
    function blacklist(address account) external;
    function isBlacklisted(address account) external view returns (bool);
}

/// @notice Fork tests (P2.4, TS 2.4): the ledger deployed on a copy of Base mainnet against
///         Circle's real USDC, at a pinned block so every run sees the same chain.
///
///         Needs `BASE_RPC_URL` (an archive endpoint) in the environment or in `contracts/.env`,
///         which Forge loads and git ignores. Without it every test here is skipped, so CI and
///         anyone without a URL stay green. USDC is minted through its real master minter and
///         addresses are blacklisted through its real blacklister, both impersonated on the fork.
contract BaseForkTest is Test {
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // Circle, Base
    uint256 internal constant FORK_BLOCK = 52_432_000;
    string internal constant BLACKLISTED = "Blacklistable: account is blacklisted";

    IFiatToken internal usdc = IFiatToken(USDC);
    IIndicoLedger internal ledger;
    address internal admin = makeAddr("fork-admin");
    address internal guardian = makeAddr("fork-guardian");
    address internal user = makeAddr("fork-user");
    address internal merchant = makeAddr("fork-merchant");
    bytes32 internal constant TERMS = keccak256("fork-terms");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true); // no RPC URL: skipped cleanly (TS 2.4)
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);
        ledger = IIndicoLedger(address(new IndicoLedger(IERC20(USDC), admin, guardian)));

        // Real USDC for the actors, through the real minting path.
        vm.prank(usdc.masterMinter());
        usdc.configureMinter(address(this), type(uint256).max);
        usdc.mint(merchant, 1_000_000e6);
        usdc.mint(user, 1_000e6);
        vm.prank(merchant);
        usdc.approve(address(ledger), type(uint256).max);
        vm.prank(user);
        usdc.approve(address(ledger), type(uint256).max);

        vm.startPrank(admin);
        ledger.setTermsHash(TERMS);
        ledger.setUserApproved(user, true, keccak256("fork-account"));
        ledger.setMerchantApproved(merchant, true);
        vm.stopPrank();
        vm.prank(user);
        ledger.signTerms(TERMS);
        vm.prank(merchant);
        ledger.signTerms(TERMS);
    }

    /// @dev The constructor accepts Circle's USDC: a contract with 6 decimals (D-16).
    function test_fork_deploysOnRealUsdc() public view {
        assertEq(address(ledger.usdc()), USDC);
        assertEq(usdc.balanceOf(address(ledger)), 0);
    }

    /// @dev Merchant deposits, user registers an asset, borrows, repays, merchant withdraws
    ///      everything: every USDC amount exact, on the real token.
    function test_fork_fullJourney() public {
        vm.prank(merchant);
        ledger.deposit(10_000e6);
        assertEq(usdc.balanceOf(address(ledger)), 10_000e6);
        assertEq(ledger.shares(merchant), 10_000e6 * 1e6);

        vm.prank(user);
        ledger.registerAsset(keccak256("fork-doc"), 0, 1_000e6);
        vm.prank(user);
        uint256 id = ledger.requestLoan(800e6); // maxBorrow: locks exactly 1,000
        assertEq(usdc.balanceOf(user), 1_800e6);
        assertEq(ledger.lockedCredit(user), 1_000e6);
        assertEq(ledger.poolUsdc(), 9_200e6);

        vm.warp(vm.getBlockTimestamp() + 60 days);
        vm.prank(user);
        ledger.repay(id);
        assertEq(usdc.balanceOf(user), 1_000e6);
        assertEq(ledger.lockedCredit(user), 0);
        assertEq(ledger.poolUsdc(), 10_000e6);

        vm.prank(merchant);
        ledger.withdrawAll();
        assertEq(
            usdc.balanceOf(merchant), 1_000_000e6, "the merchant gets back exactly the deposit"
        );
        assertEq(usdc.balanceOf(address(ledger)), 0);
        assertEq(ledger.totalShares(), 0);
    }

    /// @dev A borrower Circle has blacklisted cannot receive the loan: the call reverts with
    ///      USDC's own error and nothing in the ledger changes (full rollback).
    function test_fork_blacklistedBorrower_requestLoan_fullRollback() public {
        vm.prank(merchant);
        ledger.deposit(10_000e6);
        vm.prank(user);
        ledger.registerAsset(keccak256("fork-doc"), 0, 1_000e6);
        vm.prank(usdc.blacklister());
        usdc.blacklist(user);

        uint256 credit = ledger.credit(user);
        vm.prank(user);
        vm.expectRevert(bytes(BLACKLISTED));
        ledger.requestLoan(800e6);

        assertEq(ledger.credit(user), credit);
        assertEq(ledger.lockedCredit(user), 0);
        assertEq(ledger.totalLent(), 0);
        assertEq(ledger.poolUsdc(), 10_000e6);
        assertEq(ledger.nextLoanId(), 0);
        assertEq(usdc.balanceOf(address(ledger)), 10_000e6);
    }

    /// @dev Blacklisted after borrowing: the repayment cannot be pulled, so the loan stays Active
    ///      and the borrower's collateral stays locked; after the due date it can be liquidated
    ///      as usual, so nothing is stuck for the pool's bookkeeping.
    function test_fork_blacklistedBorrower_cannotRepay_canBeLiquidated() public {
        vm.prank(merchant);
        ledger.deposit(10_000e6);
        vm.prank(user);
        ledger.registerAsset(keccak256("fork-doc"), 0, 1_000e6);
        vm.prank(user);
        uint256 id = ledger.requestLoan(800e6);
        vm.prank(usdc.blacklister());
        usdc.blacklist(user);

        vm.prank(user);
        vm.expectRevert(bytes(BLACKLISTED));
        ledger.repay(id);
        (,,, uint8 status,,) = ledger.loans(id);
        assertEq(status, 0, "still Active");
        assertEq(ledger.lockedCredit(user), 1_000e6);

        (, uint64 due,,,,) = ledger.loans(id);
        vm.warp(uint256(due) + 1);
        ledger.liquidate(id);
        assertEq(ledger.credit(user), 0);
        assertEq(ledger.poolCredit(), 1_000e6);
        assertEq(ledger.totalLent(), 0);
    }

    /// @dev A merchant Circle has blacklisted cannot withdraw: USDC's own error, shares and the
    ///      pool unchanged. The money is not lost: it stays booked to the merchant.
    function test_fork_blacklistedMerchant_withdraw_fullRollback() public {
        vm.prank(merchant);
        ledger.deposit(10_000e6);
        vm.prank(usdc.blacklister());
        usdc.blacklist(merchant);

        vm.prank(merchant);
        vm.expectRevert(bytes(BLACKLISTED));
        ledger.withdraw(1_000e6);
        vm.prank(merchant);
        vm.expectRevert(bytes(BLACKLISTED));
        ledger.withdrawAll();

        assertEq(ledger.shares(merchant), 10_000e6 * 1e6);
        assertEq(ledger.totalShares(), 10_000e6 * 1e6);
        assertEq(ledger.poolUsdc(), 10_000e6);
        assertEq(usdc.balanceOf(address(ledger)), 10_000e6);
    }

    /// @dev A blacklisted merchant cannot deposit either: the pull fails before any share exists.
    function test_fork_blacklistedMerchant_deposit_reverts() public {
        vm.prank(usdc.blacklister());
        usdc.blacklist(merchant);
        vm.prank(merchant);
        vm.expectRevert(bytes(BLACKLISTED));
        ledger.deposit(1_000e6);
        assertEq(ledger.totalShares(), 0);
        assertEq(ledger.poolUsdc(), 0);
    }

    /// @dev The remaining user and admin actions once each on the real token, so the real-USDC gas
    ///      table in `handover/gas.md` covers every function the app sends (TS 2.4).
    function test_fork_everyOtherAction() public {
        vm.prank(merchant);
        ledger.deposit(10_000e6);
        vm.prank(admin);
        ledger.adminIssueCredit(user, 2_000e6, keccak256("fork-payment"));
        vm.prank(user);
        ledger.spend(merchant, 500e6);
        vm.prank(admin);
        ledger.adminDebitCredit(merchant, 500e6, keccak256("fork-cash"));
        vm.prank(user);
        uint256 id = ledger.requestLoan(800e6);
        (, uint64 due,,,,) = ledger.loans(id);
        vm.warp(uint256(due) - 1 days);
        vm.prank(user);
        ledger.extend(id);
        vm.prank(user);
        ledger.repay(id);
        address newWallet = makeAddr("fork-new-wallet");
        vm.prank(admin);
        ledger.adminMoveAccount(user, newWallet, keccak256("fork-account"));
        assertEq(ledger.credit(newWallet), 1_500e6);
        assertEq(ledger.credit(merchant), 0);
        assertEq(ledger.poolUsdc(), 10_000e6);
    }

    /// @dev USDC sent straight to the ledger on the real token is counted nowhere (D-38).
    function test_fork_directTransfer_isStuck_poolUnchanged() public {
        vm.prank(merchant);
        ledger.deposit(1_000e6);
        vm.prank(merchant);
        usdc.transfer(address(ledger), 500e6);
        assertEq(ledger.poolUsdc(), 1_000e6);
        assertEq(ledger.maxWithdraw(merchant), 1_000e6);
        assertEq(usdc.balanceOf(address(ledger)), 1_500e6);
    }
}
