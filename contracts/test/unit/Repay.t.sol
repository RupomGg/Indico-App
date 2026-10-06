// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {LedgerMath} from "../../src/lib/Math.sol";
import {BPS, LTV_BPS} from "../../src/lib/Constants.sol";
import {MockUSDC} from "../helpers/MockUSDC.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice `repay`, contract-spec 6.6; PRD R-01 to R-03, R-08; D-09 (after the due date), D-48
///         (check order; a short delivery reverts `RepaymentShort`).
///
/// loanId
/// | Class                               | Expected                                       |
/// |-------------------------------------|------------------------------------------------|
/// | 0 (never a loan, D-44)              | LoanNotFound                                   |
/// | a valid Active id                   | repaid                                         |
/// | nextLoanId + 1 (one past the end)   | LoanNotFound                                   |
/// | uint256 max                         | LoanNotFound                                   |
/// | already repaid                      | LoanNotActive                                  |
/// | defaulted                           | LoanNotActive, needs `liquidate`: P1.11 matrix |
/// | another user's loan                 | NotBorrower                                    |
/// caller: the borrower repays, revoked or not (approval and terms not checked); any other
/// address -> NotBorrower; paused -> EnforcedPause.
/// time: at the due date, one second after, 1000 days after -> repaid (D-09).
/// token: allowance short, balance short, returns false, blacklisted -> full rollback with the
/// token's error; fee on transfer -> RepaymentShort(principal, received); re-entry -> guard.
/// Effects: status Repaid (other loan fields unchanged), lockedCredit -= k, totalLent -= p,
/// poolUsdc += p, exactly p USDC from the borrower to the ledger; credit and totalCredit
/// unchanged; `LoanRepaid` and `CollateralReleased`, nothing else.
/// Order: EnforcedPause, LoanNotFound, LoanNotActive, NotBorrower, RepaymentShort.
/// Every revert: `_revertsUnchanged` (state diff, D-43).
contract RepayTest is Actors {
    uint256 internal constant CREDIT = 1_000e6;
    uint256 internal constant POOL = 10_000e6;
    uint256 internal constant P = 800e6; // loan 1, k = 1_000e6, all of alice's credit
    uint256 internal constant REPAID = 1 << 240; // status byte in loan slot 0

    function setUp() public override {
        super.setUp();
        _mintCredit(alice, CREDIT);
        _fundPool(POOL);
        _borrow(alice, P);
    }

    function _k(uint256 p) internal pure returns (uint256) {
        return LedgerMath.mulDivUp(p, BPS, LTV_BPS);
    }

    function _borrow(address who, uint256 p) internal returns (uint256) {
        vm.prank(who);
        return ledger.requestLoan(p);
    }

    function _repay(address who, uint256 id) internal {
        vm.prank(who);
        ledger.repay(id);
    }

    function _call(uint256 id) internal pure returns (bytes memory) {
        return abi.encodeCall(IIndicoLedger.repay, (id));
    }

    function _loan(uint256 id)
        internal
        view
        returns (address b, uint64 due, uint16 n, uint8 st, uint128 p, uint128 k)
    {
        return ledger.loans(id);
    }

    function _loanSlot(uint256 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(id, SLOT_LOANS));
    }

    function _ledgerLogs(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(ledger)) ++n;
        }
    }

    // ================================================================== happy path

    function test_repay_exactly_emitsBoth() public {
        (, uint64 due,,,,) = _loan(1);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.LoanRepaid(1, alice, P);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.CollateralReleased(alice, CREDIT, 1);
        _repay(alice, 1);

        (address b, uint64 d, uint16 n, uint8 st, uint128 p, uint128 k) = _loan(1);
        assertEq(b, alice);
        assertEq(d, due, "due date unchanged");
        assertEq(n, 0);
        assertEq(st, uint8(IIndicoLedger.LoanStatus.Repaid));
        assertEq(p, P, "principal kept as a record");
        assertEq(k, CREDIT, "collateral kept as a record");
        assertEq(ledger.lockedCredit(alice), 0, "collateral released");
        assertEq(ledger.credit(alice), CREDIT, "credit unchanged");
        assertEq(ledger.totalCredit(), CREDIT, "totalCredit unchanged");
        assertEq(ledger.totalLent(), 0);
        assertEq(ledger.poolUsdc(), POOL, "poolUsdc back to its start");
        assertEq(usdc.balanceOf(alice), FUND, "exactly the principal paid");
        assertEq(usdc.balanceOf(address(ledger)), POOL);
        assertEq(ledger.nextLoanId(), 1, "no new id");
    }

    function test_repay_emitsOnlyTwo() public {
        vm.recordLogs();
        _repay(alice, 1);
        assertEq(_ledgerLogs(vm.getRecordedLogs()), 2);
    }

    /// @dev The exact net storage writes: nothing else in the ledger or the token moves.
    function test_repay_exactWrites() public {
        bytes32 slot0 = vm.load(address(ledger), _loanSlot(1));
        _startDiff();
        _repay(alice, 1);
        Write[] memory w = new Write[](6);
        w[0] = _w(address(ledger), _loanSlot(1), uint256(slot0) | REPAID);
        w[1] = _w(address(ledger), _key(alice, SLOT_LOCKED_CREDIT), 0);
        w[2] = _w(address(ledger), bytes32(SLOT_TOTAL_LENT), 0);
        w[3] = _w(address(ledger), bytes32(SLOT_POOL_USDC), POOL);
        w[4] = _w(address(usdc), _key(address(ledger), SLOT_USDC_BALANCES), POOL);
        w[5] = _w(address(usdc), _key(alice, SLOT_USDC_BALANCES), FUND);
        _assertWrites(w);
    }

    /// @dev IT 3.2: repay, then a loan of the same principal opens again.
    function test_repay_thenSamePrincipalBorrowsAgain() public {
        _repay(alice, 1);
        assertEq(_borrow(alice, P), 2);
        assertEq(ledger.lockedCredit(alice), CREDIT);
    }

    // ================================================================== time (D-09)

    function test_repay_exactlyAtDueDate() public {
        (, uint64 due,,,,) = _loan(1);
        vm.warp(due);
        _repay(alice, 1);
        assertEq(ledger.lockedCredit(alice), 0);
    }

    function test_repay_oneSecondAfterDue() public {
        (, uint64 due,,,,) = _loan(1);
        vm.warp(uint256(due) + 1);
        _repay(alice, 1);
        assertEq(ledger.lockedCredit(alice), 0);
    }

    function test_repay_1000DaysAfterDue_notLiquidated() public {
        (, uint64 due,,,,) = _loan(1);
        vm.warp(uint256(due) + 1000 days);
        _repay(alice, 1);
        assertEq(ledger.poolUsdc(), POOL);
    }

    // ================================================================== several loans

    /// @dev TS 2.2: repaying the middle of three leaves the other two exactly as they were, and
    ///      available credit rises by exactly that loan's collateral.
    function test_threeLoans_repayMiddle_othersUntouched() public {
        _mintCredit(bob, 1_000e6);
        _borrow(bob, 100e6); // 2
        _borrow(bob, 200e6 + 1); // 3
        _borrow(bob, 300e6 + 3); // 4
        bytes32[2] memory l2 = [
            vm.load(address(ledger), _loanSlot(2)),
            vm.load(address(ledger), bytes32(uint256(_loanSlot(2)) + 1))
        ];
        bytes32[2] memory l4 = [
            vm.load(address(ledger), _loanSlot(4)),
            vm.load(address(ledger), bytes32(uint256(_loanSlot(4)) + 1))
        ];
        uint256 locked = ledger.lockedCredit(bob);
        uint256 lent = ledger.totalLent();

        _repay(bob, 3);

        assertEq(ledger.lockedCredit(bob), locked - _k(200e6 + 1));
        assertEq(ledger.credit(bob) - ledger.lockedCredit(bob), 1_000e6 - locked + _k(200e6 + 1));
        assertEq(ledger.totalLent(), lent - (200e6 + 1));
        assertEq(vm.load(address(ledger), _loanSlot(2)), l2[0]);
        assertEq(vm.load(address(ledger), bytes32(uint256(_loanSlot(2)) + 1)), l2[1]);
        assertEq(vm.load(address(ledger), _loanSlot(4)), l4[0]);
        assertEq(vm.load(address(ledger), bytes32(uint256(_loanSlot(4)) + 1)), l4[1]);
        (,,, uint8 st1,,) = _loan(1);
        assertEq(st1, 0, "alice's loan untouched");
    }

    // ================================================================== loanId

    function test_loanId_zero_revertsLoanNotFound() public {
        _revertsUnchanged(
            alice, _call(0), abi.encodeWithSelector(IIndicoLedger.LoanNotFound.selector)
        );
    }

    function test_loanId_onePastTheEnd_revertsLoanNotFound() public {
        _revertsUnchanged(
            alice,
            _call(ledger.nextLoanId() + 1),
            abi.encodeWithSelector(IIndicoLedger.LoanNotFound.selector)
        );
    }

    function test_loanId_uint256Max_revertsLoanNotFound() public {
        _revertsUnchanged(
            alice,
            _call(type(uint256).max),
            abi.encodeWithSelector(IIndicoLedger.LoanNotFound.selector)
        );
    }

    function test_repaidTwice_revertsLoanNotActive() public {
        _repay(alice, 1);
        _revertsUnchanged(
            alice, _call(1), abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector)
        );
    }

    // ================================================================== caller

    function test_caller_notBorrower_revertsNotBorrower() public {
        address stranger = makeAddr("stranger");
        address[6] memory who = [bob, merchantA, merchantB, admin, guardian, stranger];
        for (uint256 i; i < who.length; ++i) {
            _revertsUnchanged(
                who[i], _call(1), abi.encodeWithSelector(IIndicoLedger.NotBorrower.selector)
            );
        }
    }

    /// @dev TS 2.2: approval revoked after borrowing; repaying still works and releases the
    ///      collateral, so nothing is trapped.
    function test_caller_revokedBorrower_canRepay() public {
        _revokeUser(alice);
        _repay(alice, 1);
        assertEq(ledger.lockedCredit(alice), 0);
        (,,, uint8 st,,) = _loan(1);
        assertEq(st, uint8(IIndicoLedger.LoanStatus.Repaid));
    }

    function test_paused_revertsEnforcedPause() public {
        _pause();
        _revertsUnchanged(alice, _call(1), abi.encodeWithSelector(Pausable.EnforcedPause.selector));
    }

    // ================================================================== token

    function test_allowanceShort_fullRollback() public {
        vm.prank(alice);
        usdc.approve(address(ledger), P - 1);
        _revertsUnchanged(
            alice,
            _call(1),
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(ledger), P - 1, P
            )
        );
    }

    function test_balanceShort_fullRollback() public {
        vm.prank(alice);
        usdc.transfer(bob, FUND + 1); // alice keeps P - 1
        _revertsUnchanged(
            alice,
            _call(1),
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, P - 1, P)
        );
    }

    /// @dev R-02: less than the principal arriving is a partial repayment, so it reverts.
    function test_feeOnTransfer_revertsRepaymentShort() public {
        usdc.setFeeBps(100);
        _revertsUnchanged(
            alice,
            _call(1),
            abi.encodeWithSelector(IIndicoLedger.RepaymentShort.selector, P, P - P / 100)
        );
    }

    function test_tokenReturnsFalse_fullRollback() public {
        usdc.setReturnsFalse(true);
        _revertsUnchanged(
            alice,
            _call(1),
            abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdc))
        );
    }

    function test_blacklistedBorrower_fullRollback() public {
        usdc.blacklist(alice);
        _revertsUnchanged(
            alice, _call(1), abi.encodeWithSelector(MockUSDC.Blacklisted.selector, alice)
        );
    }

    function test_reentrancy_reverts() public {
        usdc.setReentrantTarget(address(ledger), _call(1));
        _revertsUnchanged(
            alice,
            _call(1),
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

    function test_order_notActiveBeforeNotBorrower() public {
        _repay(alice, 1);
        _revertsUnchanged(
            bob, _call(1), abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector)
        );
    }

    function test_order_notBorrowerBeforeToken() public {
        usdc.blacklist(bob);
        _revertsUnchanged(bob, _call(1), abi.encodeWithSelector(IIndicoLedger.NotBorrower.selector));
    }

    // ================================================================== properties (IT 3.2)

    /// @dev For any principal: repaying makes exactly the writes of a repayment, returns
    ///      lockedCredit, totalLent and poolUsdc to their pre-loan values, and the same
    ///      principal can then be borrowed again.
    function testFuzz_repay_anyPrincipal_exactWritesAndRestores(uint256 p) public {
        p = bound(p, 1, FUND - POOL); // merchantA's remaining USDC
        uint256 k = _k(p);
        _mintCredit(bob, k);
        _fundPool(p);
        uint256 cash = ledger.poolUsdc();
        uint256 lent = ledger.totalLent();
        uint256 id = _borrow(bob, p);
        bytes32 slot0 = vm.load(address(ledger), _loanSlot(id));
        uint256 held = usdc.balanceOf(address(ledger));

        _startDiff();
        _repay(bob, id);
        Write[] memory w = new Write[](6);
        w[0] = _w(address(ledger), _loanSlot(id), uint256(slot0) | REPAID);
        w[1] = _w(address(ledger), _key(bob, SLOT_LOCKED_CREDIT), 0);
        w[2] = _w(address(ledger), bytes32(SLOT_TOTAL_LENT), lent);
        w[3] = _w(address(ledger), bytes32(SLOT_POOL_USDC), cash);
        w[4] = _w(address(usdc), _key(address(ledger), SLOT_USDC_BALANCES), held + p);
        w[5] = _w(address(usdc), _key(bob, SLOT_USDC_BALANCES), FUND);
        _assertWrites(w);

        _borrow(bob, p);
        assertEq(ledger.lockedCredit(bob), k);
    }

    /// @dev Any address but the borrower is refused, and nothing changes.
    function testFuzz_repay_anyOtherCaller_revertsNotBorrower(address who) public {
        who = _remapForgeAddress(who);
        if (who == alice) who = bob;
        _revertsUnchanged(who, _call(1), abi.encodeWithSelector(IIndicoLedger.NotBorrower.selector));
    }

    /// @dev Any id that was never issued is refused, and nothing changes.
    function testFuzz_repay_unknownId_revertsLoanNotFound(uint256 id) public {
        if (id == 1) id = 0;
        _revertsUnchanged(
            alice, _call(id), abi.encodeWithSelector(IIndicoLedger.LoanNotFound.selector)
        );
    }
}
