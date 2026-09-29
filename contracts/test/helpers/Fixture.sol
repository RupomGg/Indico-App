// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IndicoLedger} from "../../src/IndicoLedger.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {Math} from "../../src/lib/Math.sol";
import {BPS, LTV_BPS} from "../../src/lib/Constants.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice The only place test setup lives. Test files call these helpers; they never
///         prank the admin themselves.
///
///         After `setUp`: terms hash set; `alice` and `bob` approved users who signed;
///         `merchantA` and `merchantB` approved merchants who signed; every named actor
///         holds `FUND` USDC and has approved the ledger to pull it. No credit, empty pool.
abstract contract Fixture is Test {
    bytes32 internal constant TERMS = keccak256("indico-terms-v1");
    uint256 internal constant FUND = 1_000_000e6;

    MockUSDC internal usdc;
    IIndicoLedger internal ledger;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal merchantA = makeAddr("merchantA");
    address internal merchantB = makeAddr("merchantB");

    /// @dev Every address whose balances `_snapshot()` records.
    address[] internal actors;

    function setUp() public virtual {
        usdc = new MockUSDC();
        ledger = IIndicoLedger(address(new IndicoLedger(usdc, admin, guardian)));

        vm.prank(admin);
        ledger.setTermsHash(TERMS);

        _approveAndSign(alice);
        _approveAndSign(bob);
        _approveMerchantAndSign(merchantA);
        _approveMerchantAndSign(merchantB);

        _addActor(admin);
        _addActor(guardian);
        _addActor(alice);
        _addActor(bob);
        _addActor(merchantA);
        _addActor(merchantB);
    }

    // ------------------------------------------------------------------ the three named

    function _approveAndSign(address user) internal {
        _approveUser(user);
        _sign(user);
    }

    /// @dev merchantA deposits `amount`.
    function _fundPool(uint256 amount) internal {
        vm.prank(merchantA);
        ledger.deposit(amount);
    }

    function _mintCredit(address user, uint256 amount) internal {
        vm.prank(admin);
        ledger.adminIssueCredit(user, amount, "fixture");
    }

    // ------------------------------------------------------------------ further setup

    function _approveUser(address user) internal {
        vm.prank(admin);
        ledger.setUserApproved(user, true);
    }

    function _sign(address account) internal {
        vm.prank(account);
        ledger.signTerms(TERMS);
    }

    function _approveMerchantAndSign(address m) internal {
        vm.prank(admin);
        ledger.setMerchantApproved(m, true);
        _sign(m);
    }

    function _revokeUser(address user) internal {
        vm.prank(admin);
        ledger.setUserApproved(user, false);
    }

    function _revokeMerchant(address m) internal {
        vm.prank(admin);
        ledger.setMerchantApproved(m, false);
    }

    function _pause() internal {
        vm.prank(guardian);
        ledger.pause();
    }

    /// @dev Track `a` for snapshots, give it `FUND` USDC and an unlimited ledger allowance.
    function _addActor(address a) internal {
        actors.push(a);
        usdc.mint(a, FUND);
        vm.prank(a);
        usdc.approve(address(ledger), type(uint256).max);
    }

    /// @dev Collateral computed independently of the ledger's own view.
    function _collateralFor(uint256 principal) internal pure returns (uint256) {
        return Math.ceilDiv(principal * BPS, LTV_BPS);
    }

    /// @dev Mints exactly enough credit and pool liquidity, then `borrower` borrows.
    function _openLoan(address borrower, uint256 principal) internal returns (uint256 loanId) {
        _mintCredit(borrower, _collateralFor(principal));
        _fundPool(principal);
        vm.prank(borrower);
        loanId = ledger.requestLoan(principal);
    }

    /// @dev Moves past the due date, liquidates, and restores the clock.
    function _default(uint256 loanId) internal {
        (, uint64 dueDate,,,,) = ledger.loans(loanId);
        uint256 now_ = block.timestamp;
        vm.warp(uint256(dueDate) + 1);
        ledger.liquidate(loanId);
        vm.warp(now_);
    }
}
