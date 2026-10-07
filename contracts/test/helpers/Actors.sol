// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {StateSnapshot} from "./StateSnapshot.sol";
import {Fixture, FixtureBase} from "./Fixture.sol";
import {Matrix} from "./Matrix.sol";
import {EXTENSION_WINDOW} from "../../src/lib/Constants.sol";

/// @notice Every finite domain from docs/input-testing.md section 2, each value one call away.
///         Combine with `_crossProduct` so a full matrix is a loop, not hand-written setups:
///
///     function test_participantMatrix() public { _crossProduct(_dims(PARTICIPANTS, 13), _cell); }
///     function _cell(uint256[] memory c) internal {
///         address who = _participant(Participant(c[0]));
///         ...
///     }
abstract contract Actors is StateSnapshot, Fixture, Matrix {
    /// @dev Section 2.2.
    enum Participant {
        Unknown,
        RegisteredNotApproved,
        ApprovedNotSigned,
        ApprovedAndSigned,
        ApprovedThenRevoked,
        Merchant,
        MerchantRevoked,
        Admin,
        Guardian
    }

    /// @dev Section 2.1.
    enum LoanState {
        NonExistent,
        Active,
        Repaid,
        Defaulted
    }

    /// @dev Section 2.4.
    enum PoolState {
        Empty,
        HasDepositsNoneLent,
        PartiallyLent,
        FullyLent,
        LentWithADefault,
        AllRepaidAfterDefault
    }

    uint256 internal constant PARTICIPANTS = 9;
    uint256 internal constant POOL_STATES = 6;

    /// @dev Returned by `_poolInState` when no loan is left Active.
    uint256 internal constant NO_LOAN = type(uint256).max;

    uint256 internal constant POOL_DEPOSIT = 1_000e6;

    /// @dev Full onboarding from `Fixture`; `StateSnapshot` adds no setup of its own.
    function setUp() public virtual override(FixtureBase, Fixture) {
        super.setUp();
    }

    /// @notice A fresh address in state `p`, tracked for snapshots, holding `FUND` USDC with
    ///         the ledger approved. Holds no credit; mint what the cell needs.
    /// @dev `RegisteredNotApproved` has signed the terms but was never approved. Registration
    ///      itself is off chain, and the contract's `signTerms` has no approval check, so
    ///      this is the only on-chain state that separates it from `Unknown`.
    function _participant(Participant p) internal returns (address a) {
        if (p == Participant.Admin) return admin;
        if (p == Participant.Guardian) return guardian;

        a = makeAddr(string.concat("participant-", vm.toString(uint256(p))));
        _addActor(a);

        if (p == Participant.RegisteredNotApproved) {
            _sign(a);
        } else if (p == Participant.ApprovedNotSigned) {
            _approveUser(a);
        } else if (p == Participant.ApprovedAndSigned) {
            _approveAndSign(a);
        } else if (p == Participant.ApprovedThenRevoked) {
            _approveAndSign(a);
            _revokeUser(a);
        } else if (p == Participant.Merchant) {
            _approveMerchantAndSign(a);
        } else if (p == Participant.MerchantRevoked) {
            _approveMerchantAndSign(a);
            _revokeMerchant(a);
        }
    }

    /// @notice A loan of `principal` borrowed by `alice`, in state `s`. The clock is left
    ///         where it was, so the caller positions time relative to the loan's due date.
    /// @return loanId For `NonExistent`, `nextLoanId + 1`, the first id not yet issued (ids
    ///         start at 1 and `nextLoanId` is the newest, D-44).
    function _loanInState(LoanState s, uint256 principal) internal returns (uint256 loanId) {
        if (s == LoanState.NonExistent) return ledger.nextLoanId() + 1;

        loanId = _openLoan(alice, principal);
        if (s == LoanState.Repaid) {
            vm.prank(alice);
            ledger.repay(loanId);
        } else if (s == LoanState.Defaulted) {
            _default(loanId);
        }
    }

    /// @notice The pool in state `s`, built from a `POOL_DEPOSIT` deposit by merchantA.
    ///         Lent-with-a-default: alice borrows 40% and extends, bob borrows 30% and defaults.
    ///         Leaves the clock 60 days after the loans opened.
    /// @return activeLoanId A loan still Active in that state, or `NO_LOAN`.
    function _poolInState(PoolState s) internal returns (uint256 activeLoanId) {
        activeLoanId = NO_LOAN;
        if (s == PoolState.Empty) return activeLoanId;

        _fundPool(POOL_DEPOSIT);
        if (s == PoolState.HasDepositsNoneLent) return activeLoanId;

        if (s == PoolState.PartiallyLent || s == PoolState.FullyLent) {
            uint256 principal = s == PoolState.FullyLent ? POOL_DEPOSIT : POOL_DEPOSIT * 4 / 10;
            _mintCredit(alice, _collateralFor(principal));
            vm.prank(alice);
            return ledger.requestLoan(principal);
        }

        // LentWithADefault, AllRepaidAfterDefault
        uint256 aliceLoan = _borrowFromPool(alice, POOL_DEPOSIT * 4 / 10);
        uint256 bobLoan = _borrowFromPool(bob, POOL_DEPOSIT * 3 / 10);
        // Alice extends at the opening of her window (D-13), so her loan outlives bob's default.
        (, uint64 dueDate,,,,) = ledger.loans(aliceLoan);
        vm.warp(dueDate - EXTENSION_WINDOW);
        vm.prank(alice);
        ledger.extend(aliceLoan);
        _default(bobLoan);

        if (s == PoolState.LentWithADefault) return aliceLoan;
        vm.prank(alice);
        ledger.repay(aliceLoan);
    }

    function _borrowFromPool(address borrower, uint256 principal) private returns (uint256) {
        _mintCredit(borrower, _collateralFor(principal));
        vm.prank(borrower);
        return ledger.requestLoan(principal);
    }
}
