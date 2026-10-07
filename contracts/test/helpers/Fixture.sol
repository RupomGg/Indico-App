// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IndicoLedger} from "../../src/IndicoLedger.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {LedgerMath} from "../../src/lib/Math.sol";
import {BPS, LTV_BPS} from "../../src/lib/Constants.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice Deployment only: the ledger on `MockUSDC`, roles granted by the constructor, and
///         every named actor holding `FUND` USDC with the ledger approved to pull it. Uses
///         nothing but the constructor, so it works from the first portion that has a ledger.
abstract contract FixtureBase is Test {
    uint256 internal constant FUND = 1_000_000e6;

    // Storage slots, from `forge inspect IndicoLedger storageLayout` and `MockUSDC`. Checked
    // against the getters by `StateDiffTest.test_slotConstants_matchGetters`.
    uint256 internal constant SLOT_PAUSED = 3;
    uint256 internal constant SLOT_TERMS_HASH = 4;
    uint256 internal constant SLOT_APPROVED_USER = 5;
    uint256 internal constant SLOT_APPROVED_MERCHANT = 6;
    uint256 internal constant SLOT_TERMS_SIGNED = 7;
    uint256 internal constant SLOT_SIGNED_TERMS_HASH = 8;
    uint256 internal constant SLOT_PARTICIPANT_ROLE = 9;
    uint256 internal constant SLOT_CREDIT = 10;
    uint256 internal constant SLOT_LOCKED_CREDIT = 11;
    uint256 internal constant SLOT_TOTAL_CREDIT = 12;
    uint256 internal constant SLOT_POOL_CREDIT = 13;
    uint256 internal constant SLOT_ASSET_REGISTERED = 14;
    uint256 internal constant SLOT_SHARES = 15;
    uint256 internal constant SLOT_TOTAL_SHARES = 16;
    uint256 internal constant SLOT_TOTAL_LENT = 17;
    uint256 internal constant SLOT_POOL_USDC = 18;
    uint256 internal constant SLOT_NEXT_LOAN_ID = 19;
    uint256 internal constant SLOT_LOANS = 20;
    /// @dev `lastPausedAt` in the low 64 bits, `lastUnpausedAt` in the next 64 (D-58).
    uint256 internal constant SLOT_PAUSE_TIMES = 21;
    uint256 internal constant SLOT_USDC_BALANCES = 0;

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

        _addActor(admin);
        _addActor(guardian);
        _addActor(alice);
        _addActor(bob);
        _addActor(merchantA);
        _addActor(merchantB);
    }

    /// @dev Track `a` for snapshots, give it `FUND` USDC and an unlimited ledger allowance.
    function _addActor(address a) internal {
        actors.push(a);
        usdc.mint(a, FUND);
        vm.prank(a);
        usdc.approve(address(ledger), type(uint256).max);
    }

    function _pause() internal {
        vm.prank(guardian);
        ledger.pause();
    }

    /// @dev Fuzzed addresses are remapped, never discarded (INSTRUCTION 1.2): Forge's own
    ///      addresses (the cheatcode VM, console, the CREATE2 deployer) become one ordinary
    ///      address; every other address is returned unchanged.
    function _remapForgeAddress(address a) internal returns (address) {
        if (a == VM_ADDRESS || a == CONSOLE || a == CREATE2_FACTORY) {
            return makeAddr("remapped-forge-address");
        }
        return a;
    }
}

/// @notice The only place test setup lives. Test files call these helpers; they never
///         prank the admin themselves.
///
///         After `setUp`: everything `FixtureBase` sets up, plus the terms hash set; `alice`
///         and `bob` approved users who signed; `merchantA` and `merchantB` approved merchants
///         who signed. No credit, empty pool.
abstract contract Fixture is FixtureBase {
    bytes32 internal constant TERMS = keccak256("indico-terms-v1");

    function setUp() public virtual override {
        super.setUp();

        vm.prank(admin);
        ledger.setTermsHash(TERMS);

        _approveAndSign(alice);
        _approveAndSign(bob);
        _approveMerchantAndSign(merchantA);
        _approveMerchantAndSign(merchantB);
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

    // ------------------------------------------------------------------ pool model (D-38)

    /// @dev The offset written out again here, so a change to the ledger's constant is caught.
    uint256 internal constant MODEL_VIRTUAL_SHARES = 1e6;
    uint256 internal constant MODEL_VIRTUAL_ASSETS = 1;

    function _modelShares() internal view returns (uint256) {
        return ledger.totalShares() + MODEL_VIRTUAL_SHARES;
    }

    function _modelAssets() internal view returns (uint256) {
        return ledger.poolUsdc() + ledger.totalLent() + MODEL_VIRTUAL_ASSETS;
    }

    /// @dev Shares `deposit(received)` mints now, rounded down.
    function _modelSharesFor(uint256 received) internal view returns (uint256) {
        return LedgerMath.mulDivDown(received, _modelShares(), _modelAssets());
    }

    /// @dev Shares `withdraw(assets)` burns now, rounded up.
    function _modelSharesToBurn(uint256 assets) internal view returns (uint256) {
        return LedgerMath.mulDivUp(assets, _modelShares(), _modelAssets());
    }

    /// @dev What `m`'s shares are worth now, rounded down, ignoring the pool's cash.
    function _modelClaim(address m) internal view returns (uint256) {
        return LedgerMath.mulDivDown(ledger.shares(m), _modelAssets(), _modelShares());
    }

    /// @dev `a` deposits `amount`.
    function _deposit(address a, uint256 amount) internal {
        vm.prank(a);
        ledger.deposit(amount);
    }

    // ------------------------------------------------ loans for pool tests (O-033)

    /// @dev The borrower behind `_lendOut`: an approved user who signed, created on first use.
    address internal poolBorrower = makeAddr("poolBorrower");

    /// @notice Lends `lent` out of the pool in real loans and defaults `lost` of it: a loan of
    ///         `lost`, liquidated past its due date with the clock restored (`_default`), and a
    ///         loan of `lent - lost` left Active. A loan of 0 is not opened. The pool ends with
    ///         `poolUsdc` down by `lent` and `totalLent` up by `lent - lost`; the USDC goes to the
    ///         borrower.
    /// @return activeLoanId The Active loan of `lent - lost`, or 0 if `lent == lost`.
    function _lendOut(uint256 lent, uint256 lost) internal returns (uint256 activeLoanId) {
        if (!ledger.approvedUser(poolBorrower)) {
            _addActor(poolBorrower);
            _approveAndSign(poolBorrower);
        }
        uint256 collateral = _collateralFor(lost) + _collateralFor(lent - lost);
        if (collateral > 0) _mintCredit(poolBorrower, collateral);
        if (lost > 0) {
            vm.prank(poolBorrower);
            _default(ledger.requestLoan(lost));
        }
        if (lent > lost) {
            vm.prank(poolBorrower);
            activeLoanId = ledger.requestLoan(lent - lost);
        }
    }

    /// @dev The pool borrower repays `loanId` in full.
    function _repayLoan(uint256 loanId) internal {
        vm.prank(poolBorrower);
        ledger.repay(loanId);
    }

    /// @dev Collateral computed independently of the ledger's own view.
    function _collateralFor(uint256 principal) internal pure returns (uint256) {
        return LedgerMath.ceilDiv(principal * BPS, LTV_BPS);
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
        // Not `block.timestamp`: under via_ir that read can be reused after `vm.warp`.
        uint256 now_ = vm.getBlockTimestamp();
        vm.warp(uint256(dueDate) + 1);
        ledger.liquidate(loanId);
        vm.warp(now_);
    }
}
