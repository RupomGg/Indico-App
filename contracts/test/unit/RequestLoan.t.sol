// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {LedgerMath} from "../../src/lib/Math.sol";
import {BPS, LTV_BPS, TERM} from "../../src/lib/Constants.sol";
import {MockUSDC} from "../helpers/MockUSDC.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice `requestLoan`, contract-spec 5, 6.6; PRD L-01 to L-10; D-05, D-44 (ids from 1), D-45
///         (check order; collateral = mulDivUp(principal, BPS, LTV_BPS)).
///
/// principal, available credit a, pool cash c, collateral k = mulDivUp(p, 10_000, 8_000)
/// | Class                                  | Expected                                        |
/// |----------------------------------------|-------------------------------------------------|
/// | zero                                   | ZeroAmount                                      |
/// | one wei                                | k = 2 (1.25 rounded up), loan opens             |
/// | typical (800e6)                        | k = 1_000e6                                     |
/// | k exactly a                            | opens, available 0                              |
/// | k = a + 1 (one wei short)              | InsufficientAvailableCredit(k, a)               |
/// | maxBorrow(a) = a * 8000 / 10000        | opens; maxBorrow + 1 reverts                    |
/// | above uint128 max                      | InsufficientAvailableCredit (k > any credit)    |
/// | uint256 max                            | MathOverflow (named), never a panic             |
/// | exactly c                              | opens, pool cash 0                              |
/// | c + 1 (credit enough)                  | InsufficientLiquidity(p, c)                     |
/// caller: approved and signed borrows; unapproved, revoked, merchant, admin -> NotApprovedUser;
/// approved but unsigned -> TermsNotSigned; paused -> EnforcedPause.
/// Effects: lockedCredit += k, totalLent += p, poolUsdc -= p, loan stored (borrower, dueDate =
/// now + TERM, extensionCount 0, Active, p, k), id = ++nextLoanId, p USDC to the borrower last;
/// credit and totalCredit unchanged; `LoanOpened` and `CollateralLocked`, nothing else.
/// Order: EnforcedPause, NotApprovedUser, TermsNotSigned, ZeroAmount,
/// InsufficientAvailableCredit, InsufficientLiquidity.
/// Every revert: `_revertsUnchanged` (state diff, D-43).
contract RequestLoanTest is Actors {
    uint256 internal constant CREDIT = 1_000e6;
    uint256 internal constant POOL = 10_000e6;

    function setUp() public override {
        super.setUp();
        _mintCredit(alice, CREDIT);
        _fundPool(POOL);
    }

    function _k(uint256 p) internal pure returns (uint256) {
        return LedgerMath.mulDivUp(p, BPS, LTV_BPS);
    }

    function _borrow(address who, uint256 p) internal returns (uint256) {
        vm.prank(who);
        return ledger.requestLoan(p);
    }

    function _call(uint256 p) internal pure returns (bytes memory) {
        return abi.encodeCall(IIndicoLedger.requestLoan, (p));
    }

    function _loan(uint256 id)
        internal
        view
        returns (address b, uint64 due, uint16 n, uint8 st, uint128 p, uint128 k)
    {
        return ledger.loans(id);
    }

    function _ledgerLogs(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(ledger)) ++n;
        }
    }

    // ================================================================== happy path

    function test_requestLoan_opensExactly_emitsBoth() public {
        vm.warp(1_800_000_000);
        uint64 due = uint64(1_800_000_000 + TERM);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.LoanOpened(1, alice, 800e6, 1_000e6, due);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.CollateralLocked(alice, 1_000e6, 1);
        uint256 id = _borrow(alice, 800e6);

        assertEq(id, 1, "first id is 1 (D-44)");
        assertEq(ledger.nextLoanId(), 1);
        (address b, uint64 d, uint16 n, uint8 st, uint128 p, uint128 k) = _loan(1);
        assertEq(b, alice);
        assertEq(d, due);
        assertEq(n, 0);
        assertEq(st, uint8(IIndicoLedger.LoanStatus.Active));
        assertEq(p, 800e6);
        assertEq(k, 1_000e6);
        assertEq(ledger.lockedCredit(alice), 1_000e6);
        assertEq(ledger.credit(alice), CREDIT, "credit unchanged");
        assertEq(ledger.totalCredit(), CREDIT, "totalCredit unchanged");
        assertEq(ledger.totalLent(), 800e6);
        assertEq(ledger.poolUsdc(), POOL - 800e6, "poolUsdc lowered by the principal");
        assertEq(usdc.balanceOf(alice), FUND + 800e6, "USDC to the borrower");
    }

    function test_requestLoan_emitsOnlyTwo() public {
        vm.recordLogs();
        _borrow(alice, 800e6);
        assertEq(_ledgerLogs(vm.getRecordedLogs()), 2);
    }

    /// @dev The exact net storage writes: nothing else in the ledger or the token moves.
    function test_requestLoan_exactWrites() public {
        uint256 held = usdc.balanceOf(address(ledger));
        uint64 due = uint64(block.timestamp + TERM);
        _startDiff();
        _borrow(alice, 800e6);
        bytes32 loanSlot = keccak256(abi.encode(uint256(1), SLOT_LOANS));
        Write[] memory w = new Write[](8);
        w[0] = _w(address(ledger), _key(alice, SLOT_LOCKED_CREDIT), 1_000e6);
        w[1] = _w(address(ledger), bytes32(SLOT_TOTAL_LENT), 800e6);
        w[2] = _w(address(ledger), bytes32(SLOT_POOL_USDC), POOL - 800e6);
        w[3] = _w(address(ledger), bytes32(SLOT_NEXT_LOAN_ID), 1);
        w[4] = _w(address(ledger), loanSlot, uint256(uint160(alice)) | (uint256(due) << 160));
        w[5] =
            _w(address(ledger), bytes32(uint256(loanSlot) + 1), 800e6 | (uint256(1_000e6) << 128));
        w[6] = _w(address(usdc), _key(address(ledger), SLOT_USDC_BALANCES), held - 800e6);
        w[7] = _w(address(usdc), _key(alice, SLOT_USDC_BALANCES), FUND + 800e6);
        _assertWrites(w);
    }

    function test_principal_oneWei_locksTwo() public {
        _borrow(alice, 1);
        assertEq(ledger.lockedCredit(alice), 2);
    }

    function test_collateral_exactlyAvailable_opens() public {
        _borrow(alice, 800e6); // k = 1_000e6 = all credit
        assertEq(ledger.lockedCredit(alice), CREDIT);
    }

    function test_collateral_oneWeiShort_reverts() public {
        uint256 p = 800e6 + 1; // k = 1_000_000_002 > 1_000_000_000
        _revertsUnchanged(
            alice,
            _call(p),
            abi.encodeWithSelector(
                IIndicoLedger.InsufficientAvailableCredit.selector, _k(p), CREDIT
            )
        );
    }

    /// @dev maxBorrow rounds down, so it always passes the collateral check; one more never does.
    function test_maxBorrow_opens_andOneMoreReverts() public {
        uint256 a = 999_999_999; // not a multiple of 5, so the rounding matters
        _mintCredit(bob, a);
        uint256 mb = a * LTV_BPS / BPS;
        _revertsUnchanged(
            bob,
            _call(mb + 1),
            abi.encodeWithSelector(
                IIndicoLedger.InsufficientAvailableCredit.selector, _k(mb + 1), a
            )
        );
        _borrow(bob, mb);
        assertLe(ledger.lockedCredit(bob), a);
    }

    function test_principal_aboveUint128_revertsNamed() public {
        uint256 p = uint256(type(uint128).max) + 1;
        _revertsUnchanged(
            alice,
            _call(p),
            abi.encodeWithSelector(
                IIndicoLedger.InsufficientAvailableCredit.selector, _k(p), CREDIT
            )
        );
    }

    function test_principal_uint256Max_revertsMathOverflow_noPanic() public {
        _revertsUnchanged(
            alice,
            _call(type(uint256).max),
            abi.encodeWithSelector(LedgerMath.MathOverflow.selector)
        );
    }

    function test_principal_exactlyPoolCash_opens() public {
        _mintCredit(bob, _k(POOL));
        _borrow(bob, POOL);
        assertEq(ledger.poolUsdc(), 0);
        assertEq(ledger.totalLent(), POOL);
    }

    function test_principal_aboveCash_revertsInsufficientLiquidity() public {
        _mintCredit(bob, _k(POOL + 1));
        _revertsUnchanged(
            bob,
            _call(POOL + 1),
            abi.encodeWithSelector(IIndicoLedger.InsufficientLiquidity.selector, POOL + 1, POOL)
        );
    }

    function test_zero_revertsZeroAmount() public {
        _revertsUnchanged(
            alice, _call(0), abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
        );
    }

    // ================================================================== several loans

    function test_threeLoans_lockExactlyTheSum_idsInOrder() public {
        assertEq(_borrow(alice, 100e6), 1);
        assertEq(_borrow(alice, 200e6), 2);
        assertEq(_borrow(alice, 300e6 + 3), 3);
        assertEq(ledger.nextLoanId(), 3);
        assertEq(ledger.lockedCredit(alice), _k(100e6) + _k(200e6) + _k(300e6 + 3));
        assertEq(ledger.totalLent(), 600e6 + 3);
    }

    /// @dev Many small loans up to the limit, then one more wei reverts.
    function test_manyLoans_toTheLimit_thenOneMoreReverts() public {
        for (uint256 i; i < 10; ++i) {
            _borrow(alice, 80e6); // k = 100e6 each
        }
        _revertsUnchanged(
            alice,
            _call(1),
            abi.encodeWithSelector(IIndicoLedger.InsufficientAvailableCredit.selector, 2, 0)
        );
    }

    // ================================================================== locked credit (carried in)

    function test_lockedCredit_cannotBeSpent() public {
        _borrow(alice, 800e6); // everything locked
        _revertsUnchanged(
            alice,
            abi.encodeCall(IIndicoLedger.spend, (merchantA, 1)),
            abi.encodeWithSelector(IIndicoLedger.InsufficientAvailableCredit.selector, 1, 0)
        );
    }

    /// @dev D-32, moved from P1.5: lock everything, a debit of 1 reverts (1, 0).
    function test_lockedCredit_cannotBeDebited() public {
        _borrow(alice, 800e6);
        _revertsUnchanged(
            admin,
            abi.encodeCall(IIndicoLedger.adminDebitCredit, (alice, 1, "x")),
            abi.encodeWithSelector(IIndicoLedger.InsufficientAvailableCredit.selector, 1, 0)
        );
    }

    /// @dev Partly locked: a debit of exactly the unlocked part succeeds, one more reverts.
    function test_partlyLocked_debitExactlyUnlocked_succeeds() public {
        _borrow(alice, 400e6); // locks 500e6 of 1_000e6
        _revertsUnchanged(
            admin,
            abi.encodeCall(IIndicoLedger.adminDebitCredit, (alice, 500e6 + 1, "x")),
            abi.encodeWithSelector(
                IIndicoLedger.InsufficientAvailableCredit.selector, 500e6 + 1, 500e6
            )
        );
        vm.prank(admin);
        ledger.adminDebitCredit(alice, 500e6, "x");
        assertEq(ledger.credit(alice), 500e6);
        assertEq(ledger.lockedCredit(alice), 500e6);
    }

    function test_partlyLocked_spendExactlyUnlocked_succeeds() public {
        _borrow(alice, 400e6);
        vm.prank(alice);
        ledger.spend(merchantA, 500e6);
        assertEq(ledger.credit(alice), 500e6);
    }

    // ================================================================== caller

    function test_caller_notAUser_revertsNotApprovedUser() public {
        address stranger = makeAddr("stranger");
        address[4] memory who = [merchantA, admin, guardian, stranger];
        for (uint256 i; i < who.length; ++i) {
            _revertsUnchanged(
                who[i], _call(1), abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
            );
        }
    }

    function test_caller_revoked_cannotBorrow() public {
        _revokeUser(alice);
        _revertsUnchanged(
            alice, _call(1), abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
        );
    }

    function test_caller_unsigned_revertsTermsNotSigned() public {
        address u = makeAddr("unsigned");
        _approveUser(u);
        _revertsUnchanged(
            u, _call(1), abi.encodeWithSelector(IIndicoLedger.TermsNotSigned.selector)
        );
    }

    /// @dev Revocation leaves the loan, the lock and the balances exactly as they were.
    function test_revocation_leavesLoanUntouched() public {
        _borrow(alice, 800e6);
        (address b, uint64 d,,, uint128 p, uint128 k) = _loan(1);
        _revokeUser(alice);
        (address b2, uint64 d2, uint16 n2, uint8 st2, uint128 p2, uint128 k2) = _loan(1);
        assertEq(b2, b);
        assertEq(d2, d);
        assertEq(n2, 0);
        assertEq(st2, 0);
        assertEq(p2, p);
        assertEq(k2, k);
        assertEq(ledger.lockedCredit(alice), CREDIT);
        assertEq(ledger.credit(alice), CREDIT);
    }

    function test_paused_revertsEnforcedPause() public {
        _pause();
        _revertsUnchanged(alice, _call(1), abi.encodeWithSelector(Pausable.EnforcedPause.selector));
    }

    // ================================================================== token

    function test_blacklistedBorrower_fullRollback() public {
        usdc.blacklist(alice);
        _revertsUnchanged(
            alice, _call(800e6), abi.encodeWithSelector(MockUSDC.Blacklisted.selector, alice)
        );
    }

    function test_reentrancy_reverts() public {
        usdc.setReentrantTarget(address(ledger), _call(1));
        _revertsUnchanged(
            alice,
            _call(800e6),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
    }

    // ================================================================== check order

    function test_order_pausedFirst() public {
        _pause();
        _revertsUnchanged(
            makeAddr("stranger"), _call(0), abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    function test_order_approvalBeforeTerms() public {
        address u = makeAddr("unsigned");
        _approveUser(u);
        _revokeUser(u);
        _revertsUnchanged(
            u, _call(0), abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
        );
    }

    function test_order_termsBeforeZero() public {
        address u = makeAddr("unsigned");
        _approveUser(u);
        _revertsUnchanged(
            u, _call(0), abi.encodeWithSelector(IIndicoLedger.TermsNotSigned.selector)
        );
    }

    function test_order_zeroBeforeCredit() public {
        _revertsUnchanged(bob, _call(0), abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector));
    }

    /// @dev Short of both credit and cash: the caller's credit is checked first (D-45).
    function test_order_creditBeforeLiquidity() public {
        uint256 p = POOL + 1;
        _revertsUnchanged(
            alice,
            _call(p),
            abi.encodeWithSelector(
                IIndicoLedger.InsufficientAvailableCredit.selector, _k(p), CREDIT
            )
        );
    }

    // ================================================================== properties (IT 3.2)

    /// @dev Succeeds if and only if k <= available and p <= cash; on success exactly the writes
    ///      of a loan, on failure nothing at all.
    function testFuzz_requestLoan_succeedsIffWithinCreditAndCash(uint256 p, uint256 cash) public {
        cash = bound(cash, 0, POOL);
        p = bound(p, 1, 2 * CREDIT);
        uint256 id = 1;
        if (cash < POOL) {
            // the rest is out on bob's real loan
            _mintCredit(bob, _k(POOL - cash));
            _borrow(bob, POOL - cash);
            id = 2;
        }
        uint256 k = _k(p);
        uint256 lentBefore = ledger.totalLent();
        if (k > CREDIT) {
            _revertsUnchanged(
                alice,
                _call(p),
                abi.encodeWithSelector(
                    IIndicoLedger.InsufficientAvailableCredit.selector, k, CREDIT
                )
            );
        } else if (p > cash) {
            _revertsUnchanged(
                alice,
                _call(p),
                abi.encodeWithSelector(IIndicoLedger.InsufficientLiquidity.selector, p, cash)
            );
        } else {
            uint256 held = usdc.balanceOf(address(ledger));
            uint64 due = uint64(block.timestamp + TERM);
            _startDiff();
            _borrow(alice, p);
            bytes32 loanSlot = keccak256(abi.encode(id, SLOT_LOANS));
            Write[] memory w = new Write[](8);
            w[0] = _w(address(ledger), _key(alice, SLOT_LOCKED_CREDIT), k);
            w[1] = _w(address(ledger), bytes32(SLOT_TOTAL_LENT), lentBefore + p);
            w[2] = _w(address(ledger), bytes32(SLOT_POOL_USDC), cash - p);
            w[3] = _w(address(ledger), bytes32(SLOT_NEXT_LOAN_ID), id);
            w[4] = _w(address(ledger), loanSlot, uint256(uint160(alice)) | (uint256(due) << 160));
            w[5] = _w(address(ledger), bytes32(uint256(loanSlot) + 1), p | (k << 128));
            w[6] = _w(address(usdc), _key(address(ledger), SLOT_USDC_BALANCES), held - p);
            w[7] = _w(address(usdc), _key(alice, SLOT_USDC_BALANCES), FUND + p);
            _assertWrites(w);
        }
    }

    /// @dev Collateral is always at least 1.25x principal and at most one wei more.
    function testFuzz_collateral_isPrincipalTimes125_roundedUp(uint256 p) public {
        p = bound(p, 1, FUND - POOL); // merchantA's remaining USDC
        _mintCredit(bob, _k(p));
        _fundPool(p);
        _borrow(bob, p);
        uint256 k = ledger.lockedCredit(bob);
        assertGe(k * LTV_BPS, p * BPS, "below 1.25x");
        assertLt((k - 1) * LTV_BPS, p * BPS, "more than one wei over 1.25x");
    }
}
