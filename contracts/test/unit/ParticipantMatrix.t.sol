// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {ROLE_NONE, ROLE_USER, ROLE_MERCHANT, TERM} from "../../src/lib/Constants.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice Participant state x action, docs/input-testing.md 2.2. Columns so far: 12 of 13
///         (`signTerms`, `setUserApproved`, `pause`, `registerAsset`, `adminIssueCredit`,
///         `adminDebitCredit`, `spend`, `deposit`, `withdraw`, `requestLoan`, `repay`, `extend`); each later portion adds its own
///         at its gate until all 13 x 9 = 117 cells exist (O-025). `deposit(1e6)`: only Merchant
///         deposits, everyone else NotApprovedMerchant. `withdraw(1e6)`: Merchant and
///         MerchantRevoked deposit 1e6 first (the revoked one before its revocation) and both
///         withdraw, since their money is theirs; everyone else holds no shares and gets
///         InsufficientShares(1e12, 0). The two admin-credit columns target bob, and every
///         participant but Admin is denied (ADMIN_ROLE). The `spend` column pays merchantA; every
///         participant holding the user role gets credit first, so each cell fails on access
///         alone: only ApprovedAndSigned pays, ApprovedNotSigned gets TermsNotSigned, the rest
///         NotApprovedUser. `repay(1)`: ApprovedAndSigned borrows loan 1 itself and repays it;
///         ApprovedThenRevoked borrows before its revocation and still repays (nothing trapped);
///         for everyone else alice holds loan 1, so they get NotBorrower. `extend(1)`: the same
///         loans, called at the due date: ApprovedAndSigned extends; ApprovedThenRevoked gets
///         NotApprovedUser (D-50); everyone else NotBorrower.
///
/// | Participant           | signTerms(TERMS) | setUserApproved(t, true) | pause()       | registerAsset   |
/// |-----------------------|------------------|--------------------------|---------------|-----------------|
/// | Unknown               | ok               | denied (ADMIN_ROLE)      | denied (GUARDIAN_ROLE) | NotApprovedUser |
/// | RegisteredNotApproved | AlreadySigned    | denied                   | denied        | NotApprovedUser |
/// | ApprovedNotSigned     | ok               | denied                   | denied        | TermsNotSigned  |
/// | ApprovedAndSigned     | AlreadySigned    | denied                   | denied        | ok              |
/// | ApprovedThenRevoked   | AlreadySigned    | denied                   | denied        | NotApprovedUser |
/// | Merchant              | AlreadySigned    | denied                   | denied        | NotApprovedUser |
/// | MerchantRevoked       | AlreadySigned    | denied                   | denied        | NotApprovedUser |
/// | Admin                 | ok               | ok                       | denied        | NotApprovedUser |
/// | Guardian              | ok               | denied                   | ok            | NotApprovedUser |
/// Every cell runs from a clean onboarded fixture. Every revert leaves the snapshot unchanged.
contract ParticipantMatrixTest is Actors {
    uint8 internal constant OK = 0;
    uint8 internal constant ALREADY_SIGNED = 1;
    uint8 internal constant NOT_ADMIN = 2;
    uint8 internal constant NOT_GUARDIAN = 3;
    uint8 internal constant NOT_USER = 4;
    uint8 internal constant NOT_SIGNED = 5;
    uint8 internal constant NOT_MERCHANT = 6;
    uint8 internal constant NO_SHARES = 7;
    uint8 internal constant NOT_BORROWER = 8;

    uint256 internal constant COLUMNS = 12;
    uint256 internal constant ADMIN_CREDIT = 1e6;
    uint256 internal constant REGISTER_VALUE = 1_000e6;

    function _expected(uint256 p, uint256 action) internal pure returns (uint8) {
        // Rows in Participant order; columns signTerms, setUserApproved, pause, registerAsset,
        // adminIssueCredit, adminDebitCredit, spend, deposit, withdraw, requestLoan, repay, extend.
        uint8[12][9] memory t = [
            [
                OK,
                NOT_ADMIN,
                NOT_GUARDIAN,
                NOT_USER,
                NOT_ADMIN,
                NOT_ADMIN,
                NOT_USER,
                NOT_MERCHANT,
                NO_SHARES,
                NOT_USER,
                NOT_BORROWER,
                NOT_BORROWER
            ],
            [
                ALREADY_SIGNED,
                NOT_ADMIN,
                NOT_GUARDIAN,
                NOT_USER,
                NOT_ADMIN,
                NOT_ADMIN,
                NOT_USER,
                NOT_MERCHANT,
                NO_SHARES,
                NOT_USER,
                NOT_BORROWER,
                NOT_BORROWER
            ],
            [
                OK,
                NOT_ADMIN,
                NOT_GUARDIAN,
                NOT_SIGNED,
                NOT_ADMIN,
                NOT_ADMIN,
                NOT_SIGNED,
                NOT_MERCHANT,
                NO_SHARES,
                NOT_SIGNED,
                NOT_BORROWER,
                NOT_BORROWER
            ],
            [
                ALREADY_SIGNED,
                NOT_ADMIN,
                NOT_GUARDIAN,
                OK,
                NOT_ADMIN,
                NOT_ADMIN,
                OK,
                NOT_MERCHANT,
                NO_SHARES,
                OK,
                OK,
                OK
            ],
            [
                ALREADY_SIGNED,
                NOT_ADMIN,
                NOT_GUARDIAN,
                NOT_USER,
                NOT_ADMIN,
                NOT_ADMIN,
                NOT_USER,
                NOT_MERCHANT,
                NO_SHARES,
                NOT_USER,
                OK,
                NOT_USER
            ],
            [
                ALREADY_SIGNED,
                NOT_ADMIN,
                NOT_GUARDIAN,
                NOT_USER,
                NOT_ADMIN,
                NOT_ADMIN,
                NOT_USER,
                OK,
                OK,
                NOT_USER,
                NOT_BORROWER,
                NOT_BORROWER
            ],
            [
                ALREADY_SIGNED,
                NOT_ADMIN,
                NOT_GUARDIAN,
                NOT_USER,
                NOT_ADMIN,
                NOT_ADMIN,
                NOT_USER,
                NOT_MERCHANT,
                OK,
                NOT_USER,
                NOT_BORROWER,
                NOT_BORROWER
            ],
            [
                OK,
                OK,
                NOT_GUARDIAN,
                NOT_USER,
                OK,
                OK,
                NOT_USER,
                NOT_MERCHANT,
                NO_SHARES,
                NOT_USER,
                NOT_BORROWER,
                NOT_BORROWER
            ],
            [
                OK,
                NOT_ADMIN,
                OK,
                NOT_USER,
                NOT_ADMIN,
                NOT_ADMIN,
                NOT_USER,
                NOT_MERCHANT,
                NO_SHARES,
                NOT_USER,
                NOT_BORROWER,
                NOT_BORROWER
            ]
        ];
        return t[p][action];
    }

    function test_participantMatrix_everyCell() public {
        _crossProduct(_dims(PARTICIPANTS, COLUMNS), _cell);
    }

    function _cell(uint256[] memory c) internal {
        address who = _participant(Participant(c[0]));
        uint8 e = _expected(c[0], c[1]);
        address target = makeAddr("matrixTarget");
        if (c[1] == 5) _mintCredit(bob, 2 * ADMIN_CREDIT); // something to debit
        if (c[1] == 6 && ledger.participantRole(who) == ROLE_USER) _mintCredit(who, ADMIN_CREDIT);
        if (c[1] == 8 && Participant(c[0]) == Participant.Merchant) _deposit(who, ADMIN_CREDIT);
        if (c[1] == 9) {
            _fundPool(ADMIN_CREDIT);
            if (ledger.participantRole(who) == ROLE_USER) _mintCredit(who, 2 * ADMIN_CREDIT);
        }
        if (c[1] == 10 || c[1] == 11) {
            Participant pp = Participant(c[0]);
            if (pp == Participant.ApprovedAndSigned || pp == Participant.ApprovedThenRevoked) {
                if (pp == Participant.ApprovedThenRevoked) {
                    vm.prank(admin);
                    ledger.setUserApproved(who, true);
                }
                _openLoan(who, ADMIN_CREDIT);
                if (pp == Participant.ApprovedThenRevoked) _revokeUser(who);
            } else {
                _openLoan(alice, ADMIN_CREDIT);
            }
        }
        if (c[1] == 11) {
            (, uint64 due,,,,) = ledger.loans(1);
            vm.warp(due);
        }
        if (c[1] == 8 && Participant(c[0]) == Participant.MerchantRevoked) {
            vm.prank(admin);
            ledger.setMerchantApproved(who, true);
            _deposit(who, ADMIN_CREDIT);
            _revokeMerchant(who);
        }

        Snapshot memory s = _snapshot();
        if (e == ALREADY_SIGNED) vm.expectRevert(IIndicoLedger.AlreadySigned.selector);
        if (e == NOT_USER) vm.expectRevert(IIndicoLedger.NotApprovedUser.selector);
        if (e == NOT_SIGNED) vm.expectRevert(IIndicoLedger.TermsNotSigned.selector);
        if (e == NOT_MERCHANT) vm.expectRevert(IIndicoLedger.NotApprovedMerchant.selector);
        if (e == NOT_BORROWER) vm.expectRevert(IIndicoLedger.NotBorrower.selector);
        if (e == NO_SHARES) {
            vm.expectRevert(
                abi.encodeWithSelector(IIndicoLedger.InsufficientShares.selector, 1e12, 0)
            );
        }
        if (e == NOT_ADMIN) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector,
                    who,
                    ledger.ADMIN_ROLE()
                )
            );
        }
        if (e == NOT_GUARDIAN) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector,
                    who,
                    ledger.GUARDIAN_ROLE()
                )
            );
        }

        vm.prank(who);
        if (c[1] == 0) ledger.signTerms(TERMS);
        else if (c[1] == 1) ledger.setUserApproved(target, true);
        else if (c[1] == 2) ledger.pause();
        else if (c[1] == 3) ledger.registerAsset(keccak256("matrix-doc"), 0, REGISTER_VALUE);
        else if (c[1] == 4) ledger.adminIssueCredit(bob, ADMIN_CREDIT, "matrix");
        else if (c[1] == 5) ledger.adminDebitCredit(bob, ADMIN_CREDIT, "matrix");
        else if (c[1] == 6) ledger.spend(merchantA, ADMIN_CREDIT);
        else if (c[1] == 7) ledger.deposit(ADMIN_CREDIT);
        else if (c[1] == 8) ledger.withdraw(ADMIN_CREDIT);
        else if (c[1] == 9) ledger.requestLoan(ADMIN_CREDIT);
        else if (c[1] == 10) ledger.repay(1);
        else ledger.extend(1);

        if (e != OK) return _assertUnchanged(s);

        if (c[1] == 0) {
            assertTrue(ledger.termsSigned(who), "signed");
            assertEq(ledger.signedTermsHash(who), TERMS);
        } else if (c[1] == 1) {
            assertTrue(ledger.approvedUser(target), "approved");
        } else if (c[1] == 2) {
            s.paused = true;
            _assertUnchanged(s);
        } else if (c[1] == 3) {
            assertEq(ledger.credit(who), REGISTER_VALUE, "minted");
            assertEq(ledger.totalCredit(), REGISTER_VALUE, "total");
            assertTrue(ledger.assetRegistered(keccak256("matrix-doc")));
        } else if (c[1] < 6) {
            // Issue: 0 + 1 unit. Debit: the 2 units minted before the snapshot, less 1.
            assertEq(ledger.credit(bob), ADMIN_CREDIT, "bob");
            assertEq(ledger.totalCredit(), ADMIN_CREDIT, "total");
        } else if (c[1] == 6) {
            assertEq(ledger.credit(who), 0, "payer");
            assertEq(ledger.credit(merchantA), ADMIN_CREDIT, "merchant");
        } else if (c[1] == 7) {
            assertEq(ledger.shares(who), ADMIN_CREDIT * 1e6, "shares");
            assertEq(ledger.poolUsdc(), ADMIN_CREDIT, "poolUsdc");
            assertEq(usdc.balanceOf(who), FUND - ADMIN_CREDIT, "paid in");
        } else if (c[1] == 8) {
            assertEq(ledger.shares(who), 0, "shares");
            assertEq(ledger.poolUsdc(), 0, "poolUsdc");
            assertEq(usdc.balanceOf(who), FUND, "paid out");
        } else if (c[1] == 9) {
            assertEq(ledger.lockedCredit(who), ADMIN_CREDIT * 5 / 4, "locked");
            assertEq(ledger.totalLent(), ADMIN_CREDIT, "lent");
            assertEq(ledger.nextLoanId(), 1, "first id");
            assertEq(usdc.balanceOf(who), FUND + ADMIN_CREDIT, "paid out");
        } else if (c[1] == 11) {
            (, uint64 due, uint16 n,,,) = ledger.loans(1);
            assertEq(due, block.timestamp + TERM, "extended from the due date");
            assertEq(n, 1, "count");
            assertEq(ledger.lockedCredit(who), ADMIN_CREDIT * 5 / 4, "still locked");
        } else {
            (,,, uint8 st,,) = ledger.loans(1);
            assertEq(st, uint8(IIndicoLedger.LoanStatus.Repaid), "repaid");
            assertEq(ledger.lockedCredit(who), 0, "released");
            assertEq(ledger.totalLent(), 0, "lent");
            assertEq(usdc.balanceOf(who), FUND, "paid back");
        }
    }

    // ------------------------------------------------------------------ Actors self-check

    /// @dev Each participant state is what its name says. The matrix verdicts depend on it.
    function test_participant_everyStateBuiltAsNamed() public {
        _crossProduct(_dims(PARTICIPANTS, 1), _stateCell);
    }

    function _stateCell(uint256[] memory c) internal {
        Participant p = Participant(c[0]);
        address a = _participant(p);

        bool user = p == Participant.ApprovedNotSigned || p == Participant.ApprovedAndSigned;
        bool merchant = p == Participant.Merchant;
        bool signed = p == Participant.RegisteredNotApproved || p == Participant.ApprovedAndSigned
            || p == Participant.ApprovedThenRevoked || p == Participant.Merchant
            || p == Participant.MerchantRevoked;
        uint8 role = ROLE_NONE;
        if (
            p == Participant.ApprovedNotSigned || p == Participant.ApprovedAndSigned
                || p == Participant.ApprovedThenRevoked
        ) role = ROLE_USER;
        if (p == Participant.Merchant || p == Participant.MerchantRevoked) role = ROLE_MERCHANT;

        assertEq(ledger.approvedUser(a), user, "approvedUser");
        assertEq(ledger.approvedMerchant(a), merchant, "approvedMerchant");
        assertEq(ledger.termsSigned(a), signed, "termsSigned");
        assertEq(ledger.participantRole(a), role, "participantRole");
        bytes32 adminRole = ledger.ADMIN_ROLE();
        bytes32 guardianRole = ledger.GUARDIAN_ROLE();
        assertEq(IAccessControl(address(ledger)).hasRole(adminRole, a), p == Participant.Admin);
        assertEq(
            IAccessControl(address(ledger)).hasRole(guardianRole, a), p == Participant.Guardian
        );
    }
}
