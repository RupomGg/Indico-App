// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {ROLE_USER, ROLE_RETIRED, CREDIT_CAP} from "../../src/lib/Constants.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice `adminMoveAccount(oldWallet, newWallet, accountRef)`, D-64: an app account moves from a
///         lost wallet to a new one, with its whole credit.
///
/// oldWallet
/// | Class                                         | Expected                                  |
/// |-----------------------------------------------|-------------------------------------------|
/// | zero                                          | ZeroAddress                               |
/// | approved user, no locked credit               | moves                                     |
/// | revoked user                                  | moves (no approval to clear)              |
/// | never approved, merchant, revoked merchant,   | NotAUser(oldWallet)                       |
/// | the ledger, a retired wallet                  |                                           |
/// | locked credit (an active loan)                | AccountHasLockedCredit(oldWallet, locked) |
/// | loans repaid or defaulted, nothing locked     | moves; the old loans keep their borrower  |
/// newWallet
/// | zero                                          | ZeroAddress                               |
/// | the ledger, USDC                              | InvalidParticipant(newWallet)             |
/// | a user, revoked user, merchant, revoked       | WalletNotFresh(newWallet)                 |
/// | merchant, retired, oldWallet itself           |                                           |
/// | never approved (signed or not)                | moves                                     |
/// accountRef: oldWallet's link -> moves; zero or another -> AccountRefMismatch(old, linked).
/// credit: 0 (no credit write), typical, CREDIT_CAP; totalCredit never changes.
/// caller: ADMIN_ROLE only; paused: works (D-24).
/// Order: AccessControl, ZeroAddress, NotAUser, AccountRefMismatch, AccountHasLockedCredit,
/// InvalidParticipant, WalletNotFresh.
/// After a move: the old wallet can never be approved (either role), linked, credited or
/// debited, and can still be revoked; the reference cannot link a third wallet; the new wallet
/// spends and borrows only after signing the terms, unless it signed on its own before.
contract AccountMoveTest is Actors {
    address internal fresh = makeAddr("freshWallet");
    bytes32 internal refA;

    function setUp() public override {
        super.setUp();
        refA = _accountRef(alice);
    }

    function _move(address o, address n, bytes32 r) internal {
        vm.prank(admin);
        ledger.adminMoveAccount(o, n, r);
    }

    function _call(address o, address n, bytes32 r) internal pure returns (bytes memory) {
        return abi.encodeCall(IIndicoLedger.adminMoveAccount, (o, n, r));
    }

    function _err(bytes4 sel, address a) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(sel, a);
    }

    /// @dev The exact net writes of a move of `c` credit.
    function _moveWrites(address o, address n, bytes32 r, uint256 c, bool wasApproved)
        internal
        view
        returns (Write[] memory w)
    {
        address l = address(ledger);
        w = new Write[](9);
        uint256 i;
        w[i++] = _w(l, _key(n, SLOT_APPROVED_USER), 1);
        w[i++] = _w(l, _key(o, SLOT_PARTICIPANT_ROLE), ROLE_RETIRED);
        w[i++] = _w(l, _key(n, SLOT_PARTICIPANT_ROLE), ROLE_USER);
        w[i++] = _w(l, _key(o, SLOT_ACCOUNT_REF_OF), 0);
        w[i++] = _w(l, _key(n, SLOT_ACCOUNT_REF_OF), uint256(r));
        w[i++] = _w(l, _key(r, SLOT_WALLET_OF_ACCOUNT), uint256(uint160(n)));
        // A revoked old wallet's approvedUser is already false: not a net change.
        if (wasApproved) w[i++] = _w(l, _key(o, SLOT_APPROVED_USER), 0);
        if (c > 0) {
            w[i++] = _w(l, _key(o, SLOT_CREDIT), 0);
            w[i++] = _w(l, _key(n, SLOT_CREDIT), c);
        }
        assembly ("memory-safe") {
            mstore(w, i)
        }
    }

    // ================================================================== happy path

    function test_move_movesCreditLinkAndApproval_exactWrites() public {
        _mintCredit(alice, 700e6);
        _startDiff();
        _move(alice, fresh, refA);
        _assertWrites(_moveWrites(alice, fresh, refA, 700e6, true));
        assertEq(ledger.credit(fresh), 700e6);
        assertEq(ledger.credit(alice), 0);
        assertEq(ledger.totalCredit(), 700e6, "totalCredit unchanged");
        assertTrue(ledger.approvedUser(fresh));
        assertFalse(ledger.approvedUser(alice));
        assertEq(ledger.participantRole(alice), ROLE_RETIRED);
        assertEq(ledger.participantRole(fresh), ROLE_USER);
        assertEq(ledger.accountRefOf(fresh), refA);
        assertEq(ledger.accountRefOf(alice), bytes32(0));
        assertEq(ledger.walletOfAccount(refA), fresh);
    }

    function test_move_emitsExactlyAccountMoved() public {
        _mintCredit(alice, 700e6);
        vm.recordLogs();
        _move(alice, fresh, refA);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one event");
        assertEq(logs[0].emitter, address(ledger));
        assertEq(logs[0].topics[0], IIndicoLedger.AccountMoved.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(alice))));
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(fresh))));
        assertEq(logs[0].topics[3], refA);
        assertEq(logs[0].data, abi.encode(uint256(700e6)));
    }

    function test_move_zeroCredit_noCreditWrites() public {
        _startDiff();
        _move(alice, fresh, refA);
        _assertWrites(_moveWrites(alice, fresh, refA, 0, true));
    }

    function test_move_creditAtCap() public {
        _mintCredit(alice, CREDIT_CAP);
        _move(alice, fresh, refA);
        assertEq(ledger.credit(fresh), CREDIT_CAP);
    }

    function test_move_revokedOldWallet_succeeds() public {
        _mintCredit(alice, 5e6);
        _revokeUser(alice);
        _startDiff();
        _move(alice, fresh, refA);
        _assertWrites(_moveWrites(alice, fresh, refA, 5e6, false));
        assertTrue(ledger.approvedUser(fresh), "the new wallet is approved");
    }

    function test_move_whilePaused_succeeds() public {
        _mintCredit(alice, 5e6);
        _pause();
        _move(alice, fresh, refA);
        assertEq(ledger.credit(fresh), 5e6);
    }

    function test_move_afterRepaidLoan_oldLoanKeepsOldBorrower() public {
        uint256 id = _openLoan(alice, 400e6);
        vm.prank(alice);
        ledger.repay(id);
        _move(alice, fresh, refA);
        (address b,,,,,) = ledger.loans(id);
        assertEq(b, alice, "a record keeps its borrower");
        assertEq(ledger.credit(fresh), 500e6);
    }

    function test_move_afterDefault_movesTheRemainingCredit() public {
        _mintCredit(alice, 100e6);
        uint256 id = _openLoan(alice, 400e6); // 600e6 credit, 500e6 locked
        _default(id);
        assertEq(ledger.lockedCredit(alice), 0);
        _move(alice, fresh, refA);
        assertEq(ledger.credit(fresh), 100e6);
        assertEq(ledger.totalCredit(), 100e6);
    }

    function test_move_thenMoveAgain() public {
        _mintCredit(alice, 5e6);
        _move(alice, fresh, refA);
        address second = makeAddr("secondWallet");
        _move(fresh, second, refA);
        assertEq(ledger.credit(second), 5e6);
        assertEq(ledger.walletOfAccount(refA), second);
        assertEq(ledger.participantRole(fresh), ROLE_RETIRED);
    }

    // ================================================================== refusals

    function test_zeroAddress_eitherWallet_reverts() public {
        bytes memory e = abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector);
        _revertsUnchanged(admin, _call(address(0), fresh, refA), e);
        _revertsUnchanged(admin, _call(alice, address(0), refA), e);
        _revertsUnchanged(admin, _call(address(0), address(0), bytes32(0)), e);
    }

    function test_old_notAUser_reverts() public {
        address retired = makeAddr("retiredWallet");
        _approveUser(retired);
        _move(retired, makeAddr("retiredTo"), _accountRef(retired));
        address[5] memory who = [
            makeAddr("stranger"),
            merchantA,
            _participant(Participant.MerchantRevoked),
            address(ledger),
            retired
        ];
        for (uint256 i; i < who.length; ++i) {
            _revertsUnchanged(
                admin,
                _call(who[i], fresh, bytes32(0)),
                _err(IIndicoLedger.NotAUser.selector, who[i])
            );
        }
    }

    function test_ref_mismatch_reverts() public {
        bytes32[3] memory refs = [bytes32(0), _accountRef(bob), keccak256("other")];
        for (uint256 i; i < refs.length; ++i) {
            _revertsUnchanged(
                admin,
                _call(alice, fresh, refs[i]),
                abi.encodeWithSelector(IIndicoLedger.AccountRefMismatch.selector, alice, refA)
            );
        }
    }

    function test_old_lockedCredit_reverts() public {
        uint256 id = _openLoan(alice, 400e6);
        _revertsUnchanged(
            admin,
            _call(alice, fresh, refA),
            abi.encodeWithSelector(IIndicoLedger.AccountHasLockedCredit.selector, alice, 500e6)
        );
        vm.prank(alice);
        ledger.repay(id);
        _move(alice, fresh, refA); // nothing locked any more
    }

    function test_new_ledgerOrUsdc_reverts() public {
        address[2] memory n = [address(ledger), address(usdc)];
        for (uint256 i; i < 2; ++i) {
            _revertsUnchanged(
                admin,
                _call(alice, n[i], refA),
                _err(IIndicoLedger.InvalidParticipant.selector, n[i])
            );
        }
    }

    function test_new_notFresh_reverts() public {
        address retired = makeAddr("retiredWallet");
        _approveUser(retired);
        _move(retired, makeAddr("retiredTo"), _accountRef(retired));
        address[6] memory n = [
            bob,
            _participant(Participant.ApprovedThenRevoked),
            merchantA,
            _participant(Participant.MerchantRevoked),
            retired,
            alice
        ];
        for (uint256 i; i < n.length; ++i) {
            _revertsUnchanged(
                admin, _call(alice, n[i], refA), _err(IIndicoLedger.WalletNotFresh.selector, n[i])
            );
        }
    }

    function test_nonAdmins_revert() public {
        address[6] memory who = [guardian, alice, bob, merchantA, fresh, address(ledger)];
        for (uint256 i; i < who.length; ++i) {
            _revertsUnchanged(
                who[i],
                _call(alice, fresh, refA),
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector,
                    who[i],
                    ledger.ADMIN_ROLE()
                )
            );
        }
    }

    // ================================================================== check order

    function test_order_zeroBeforeNotAUser() public {
        _revertsUnchanged(
            admin,
            _call(makeAddr("stranger"), address(0), refA),
            abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector)
        );
    }

    function test_order_notAUserBeforeMismatch() public {
        _revertsUnchanged(
            admin, _call(merchantA, fresh, refA), _err(IIndicoLedger.NotAUser.selector, merchantA)
        );
    }

    function test_order_mismatchBeforeLocked() public {
        _openLoan(alice, 400e6);
        _revertsUnchanged(
            admin,
            _call(alice, fresh, bytes32(0)),
            abi.encodeWithSelector(IIndicoLedger.AccountRefMismatch.selector, alice, refA)
        );
    }

    function test_order_lockedBeforeInvalidParticipant() public {
        _openLoan(alice, 400e6);
        _revertsUnchanged(
            admin,
            _call(alice, address(usdc), refA),
            abi.encodeWithSelector(IIndicoLedger.AccountHasLockedCredit.selector, alice, 500e6)
        );
    }

    function test_order_invalidParticipantBeforeNotFresh() public {
        // The ledger is never approved, so only the D-23 check can name it.
        _revertsUnchanged(
            admin,
            _call(alice, address(ledger), refA),
            _err(IIndicoLedger.InvalidParticipant.selector, address(ledger))
        );
    }

    // ================================================================== after a move

    function test_retired_cannotBeApprovedLinkedCreditedOrDebited() public {
        _mintCredit(alice, 5e6);
        _move(alice, fresh, refA);
        bytes memory conflict = _err(IIndicoLedger.ParticipantRoleConflict.selector, alice);
        _revertsUnchanged(
            admin, abi.encodeCall(IIndicoLedger.setUserApproved, (alice, true, refA)), conflict
        );
        _revertsUnchanged(
            admin,
            abi.encodeCall(IIndicoLedger.setUserApproved, (alice, true, keccak256("new"))),
            conflict
        );
        _revertsUnchanged(
            admin, abi.encodeCall(IIndicoLedger.setMerchantApproved, (alice, true)), conflict
        );
        bytes memory notUser = _err(IIndicoLedger.NotAUser.selector, alice);
        _revertsUnchanged(
            admin, abi.encodeCall(IIndicoLedger.adminIssueCredit, (alice, 1, "m")), notUser
        );
        _revertsUnchanged(
            admin, abi.encodeCall(IIndicoLedger.adminDebitCredit, (alice, 1, "m")), notUser
        );
    }

    function test_retired_canStillBeRevoked_withItsEmptyLink() public {
        _move(alice, fresh, refA);
        vm.prank(admin);
        ledger.setUserApproved(alice, false, bytes32(0));
        _revertsUnchanged(
            admin,
            abi.encodeCall(IIndicoLedger.setUserApproved, (alice, false, refA)),
            abi.encodeWithSelector(IIndicoLedger.AccountRefMismatch.selector, alice, bytes32(0))
        );
    }

    function test_retired_cannotSpendOrBorrow() public {
        _mintCredit(alice, 5e6);
        _fundPool(10e6);
        _move(alice, fresh, refA);
        bytes memory e = abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector);
        _revertsUnchanged(alice, abi.encodeCall(IIndicoLedger.spend, (merchantA, 1)), e);
        _revertsUnchanged(alice, abi.encodeCall(IIndicoLedger.requestLoan, (1)), e);
    }

    function test_ref_cannotLinkAThirdWallet() public {
        _move(alice, fresh, refA);
        address third = makeAddr("thirdWallet");
        _revertsUnchanged(
            admin,
            abi.encodeCall(IIndicoLedger.setUserApproved, (third, true, refA)),
            abi.encodeWithSelector(IIndicoLedger.AccountAlreadyLinked.selector, refA, fresh)
        );
    }

    function test_newWallet_mustSignBeforeSpendingOrBorrowing() public {
        _mintCredit(alice, 5e6);
        _fundPool(10e6);
        _move(alice, fresh, refA);
        bytes memory e = abi.encodeWithSelector(IIndicoLedger.TermsNotSigned.selector);
        _revertsUnchanged(fresh, abi.encodeCall(IIndicoLedger.spend, (merchantA, 1)), e);
        _revertsUnchanged(fresh, abi.encodeCall(IIndicoLedger.requestLoan, (1)), e);
        _sign(fresh);
        vm.prank(fresh);
        ledger.spend(merchantA, 1e6);
        vm.prank(fresh);
        ledger.requestLoan(1e6);
        assertEq(ledger.credit(fresh), 4e6);
        assertEq(ledger.lockedCredit(fresh), 1.25e6);
    }

    function test_newWallet_signedOnItsOwn_signatureStands() public {
        _mintCredit(alice, 5e6);
        _sign(fresh); // before any approval, as CS 6.2 allows
        _move(alice, fresh, refA);
        vm.prank(fresh);
        ledger.spend(merchantA, 1e6);
        assertEq(ledger.credit(fresh), 4e6);
    }

    function test_newWallet_revokeAndReapproveWithTheRef() public {
        _move(alice, fresh, refA);
        vm.prank(admin);
        ledger.setUserApproved(fresh, false, refA);
        assertFalse(ledger.approvedUser(fresh));
        vm.prank(admin);
        ledger.setUserApproved(fresh, true, refA);
        assertTrue(ledger.approvedUser(fresh));
    }

    // ================================================================== fuzz

    function testFuzz_move_anyBalanceAnyFreshWallet_exactWrites(uint256 c, address n) public {
        c = bound(c, 0, CREDIT_CAP);
        n = _remapForgeAddress(n);
        // Remapped, never discarded: any address that is not fresh becomes one that is.
        if (
            n == address(0) || n == address(ledger) || n == address(usdc)
                || ledger.participantRole(n) != 0
        ) n = makeAddr("remapped-fresh");
        if (c > 0) _mintCredit(alice, c);
        _startDiff();
        _move(alice, n, refA);
        _assertWrites(_moveWrites(alice, n, refA, c, true));
        assertEq(ledger.totalCredit(), c, "totalCredit unchanged");
    }
}
