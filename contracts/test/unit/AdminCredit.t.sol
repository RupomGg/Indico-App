// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {CREDIT_CAP} from "../../src/lib/Constants.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice `adminIssueCredit` and `adminDebitCredit`, contract-spec 6.3, PRD AD-10 to AD-12,
///         D-27, D-32, D-33.
///
/// user (address), both functions
/// | Class                         | Expected                                      |
/// |-------------------------------|-----------------------------------------------|
/// | zero address                  | ZeroAddress (first, as in `_admit`)           |
/// | never approved                | NotAUser(user)                                |
/// | merchant, revoked merchant    | NotAUser(user) (D-32; D-33 evidence for issue) |
/// | the ledger, the USDC address  | NotAUser(user), they can never be approved    |
/// | approved user                 | succeeds                                      |
/// | revoked user                  | succeeds (D-32)                               |
/// amount (uint256), balance b, available a (= b while nothing is locked)
/// | zero                          | ZeroAmount                                    |
/// | one wei                       | issue: b + 1; debit (b >= 1): b - 1           |
/// | issue exactly the room        | b reaches CREDIT_CAP                          |
/// | issue room plus one, max      | CreditCapExceeded(amount, room), no panic     |
/// | debit exactly a               | b - a, zero here                              |
/// | debit a plus one, max         | InsufficientAvailableCredit(amount, a)        |
/// | debit to zero, then issue cap | succeeds: the cap limits balance, not lifetime issuance |
/// memo (bytes32): zero and max both allowed, emitted as given.
/// caller: only ADMIN_ROLE; paused: EnforcedPause.
/// Check order: AccessControl, EnforcedPause, ZeroAddress, NotAUser, ZeroAmount, then
/// CreditCapExceeded / InsufficientAvailableCredit.
/// Property: after any sequence of issues and debits, totalCredit equals the sum of balances and
/// every user is at most CREDIT_CAP (D-33).
/// Every revert leaves the full state snapshot unchanged.
contract AdminCreditTest is Actors {
    bytes32 internal constant MEMO = "payment-1";

    function _issue(address u, uint256 a, bytes32 memo) internal {
        vm.prank(admin);
        ledger.adminIssueCredit(u, a, memo);
    }

    function _debit(address u, uint256 a, bytes32 memo) internal {
        vm.prank(admin);
        ledger.adminDebitCredit(u, a, memo);
    }

    /// @dev Calls issue (`isIssue`) or debit as `caller`, expecting `err`, state unchanged.
    /// @dev Built once here, not on every fuzz run of the sequence test (D-43).
    address internal revokedUser;

    function setUp() public override {
        super.setUp();
        revokedUser = _participant(Participant.ApprovedThenRevoked);
    }

    function _expectRevertUnchanged(
        address caller,
        bool isIssue,
        address u,
        uint256 a,
        bytes memory err
    ) internal {
        _revertsUnchanged(
            caller,
            isIssue
                ? abi.encodeCall(IIndicoLedger.adminIssueCredit, (u, a, MEMO))
                : abi.encodeCall(IIndicoLedger.adminDebitCredit, (u, a, MEMO)),
            err
        );
    }

    function _index(address a) internal view returns (uint256) {
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] == a) return i;
        }
        revert("not an actor");
    }

    // ================================================================== issue, happy path

    function test_issue_mintsExactly_emitsCreditMinted() public {
        Snapshot memory s = _snapshot();
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.CreditMinted(alice, 500e6, MEMO);
        _issue(alice, 500e6, MEMO);
        s.credit[_index(alice)] += 500e6;
        s.totalCredit += 500e6;
        _assertUnchanged(s);
    }

    function test_issue_emitsExactlyOneEvent() public {
        vm.recordLogs();
        _issue(alice, 1, MEMO);
        assertEq(vm.getRecordedLogs().length, 1);
    }

    function test_issue_oneWei() public {
        _issue(alice, 1, MEMO);
        assertEq(ledger.credit(alice), 1);
    }

    function test_issue_zeroAndMaxMemo_emittedAsGiven() public {
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.CreditMinted(alice, 1, bytes32(0));
        _issue(alice, 1, bytes32(0));
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.CreditMinted(alice, 1, bytes32(type(uint256).max));
        _issue(alice, 1, bytes32(type(uint256).max));
    }

    function test_issue_toRevokedUser_succeeds() public {
        _revokeUser(alice);
        _issue(alice, 7e6, MEMO);
        assertEq(ledger.credit(alice), 7e6);
    }

    function test_issue_addsToRegisteredCredit_oneBalance() public {
        vm.prank(alice);
        ledger.registerAsset(keccak256("doc"), 0, 100e6);
        _issue(alice, 50e6, MEMO);
        assertEq(ledger.credit(alice), 150e6);
        assertEq(ledger.totalCredit(), 150e6);
    }

    // ================================================================== issue, cap (D-27)

    function test_issue_exactlyRoom_reachesCap() public {
        _issue(alice, 123e6, MEMO);
        _issue(alice, CREDIT_CAP - 123e6, MEMO);
        assertEq(ledger.credit(alice), CREDIT_CAP);
    }

    function test_issue_roomPlusOne_reverts() public {
        _issue(alice, 123e6, MEMO);
        uint256 room = CREDIT_CAP - 123e6;
        _expectRevertUnchanged(
            admin,
            true,
            alice,
            room + 1,
            abi.encodeWithSelector(IIndicoLedger.CreditCapExceeded.selector, room + 1, room)
        );
    }

    function test_issue_uint256Max_revertsNamed_noPanic() public {
        _expectRevertUnchanged(
            admin,
            true,
            alice,
            type(uint256).max,
            abi.encodeWithSelector(
                IIndicoLedger.CreditCapExceeded.selector, type(uint256).max, CREDIT_CAP
            )
        );
    }

    /// @dev The cap limits the balance, not lifetime issuance.
    function test_debitToZero_thenIssueFullCap_succeeds() public {
        _issue(alice, CREDIT_CAP, MEMO);
        _debit(alice, CREDIT_CAP, MEMO);
        assertEq(ledger.credit(alice), 0);
        _issue(alice, CREDIT_CAP, MEMO);
        assertEq(ledger.credit(alice), CREDIT_CAP);
    }

    // ================================================================== debit

    function test_debit_burnsExactly_emitsCreditBurned() public {
        _issue(alice, 500e6, MEMO);
        Snapshot memory s = _snapshot();
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.CreditBurned(alice, 200e6, "settlement");
        _debit(alice, 200e6, "settlement");
        s.credit[_index(alice)] -= 200e6;
        s.totalCredit -= 200e6;
        _assertUnchanged(s);
    }

    function test_debit_emitsExactlyOneEvent() public {
        _issue(alice, 5, MEMO);
        vm.recordLogs();
        _debit(alice, 1, MEMO);
        assertEq(vm.getRecordedLogs().length, 1);
    }

    function test_debit_oneWei() public {
        _issue(alice, 5, MEMO);
        _debit(alice, 1, MEMO);
        assertEq(ledger.credit(alice), 4);
    }

    function test_debit_exactlyAvailable_toZero() public {
        _issue(alice, 5e6, MEMO);
        _debit(alice, 5e6, MEMO);
        assertEq(ledger.credit(alice), 0);
        assertEq(ledger.totalCredit(), 0);
    }

    function test_debit_availablePlusOne_reverts() public {
        _issue(alice, 5e6, MEMO);
        _expectRevertUnchanged(
            admin,
            false,
            alice,
            5e6 + 1,
            abi.encodeWithSelector(IIndicoLedger.InsufficientAvailableCredit.selector, 5e6 + 1, 5e6)
        );
    }

    function test_debit_uint256Max_reverts() public {
        _issue(alice, 5e6, MEMO);
        _expectRevertUnchanged(
            admin,
            false,
            alice,
            type(uint256).max,
            abi.encodeWithSelector(
                IIndicoLedger.InsufficientAvailableCredit.selector, type(uint256).max, 5e6
            )
        );
    }

    function test_debit_emptyBalance_reverts() public {
        _expectRevertUnchanged(
            admin,
            false,
            alice,
            1,
            abi.encodeWithSelector(IIndicoLedger.InsufficientAvailableCredit.selector, 1, 0)
        );
    }

    function test_debit_revokedUser_succeeds() public {
        _issue(alice, 5e6, MEMO);
        _revokeUser(alice);
        _debit(alice, 2e6, MEMO);
        assertEq(ledger.credit(alice), 3e6);
    }

    function testFuzz_debit_withinAvailable_exact(uint256 b, uint256 a) public {
        b = bound(b, 1, CREDIT_CAP);
        a = bound(a, 1, b);
        _issue(alice, b, MEMO);
        _startDiff();
        _debit(alice, a, MEMO);
        Write[] memory w = new Write[](2);
        w[0] = _w(address(ledger), _key(alice, SLOT_CREDIT), b - a);
        w[1] = _w(address(ledger), bytes32(SLOT_TOTAL_CREDIT), b - a);
        _assertWrites(w);
        assertEq(ledger.credit(alice), b - a);
        assertEq(ledger.totalCredit(), b - a);
    }

    function testFuzz_debit_aboveAvailable_alwaysNamedRevert(uint256 b, uint256 a) public {
        b = bound(b, 0, CREDIT_CAP);
        a = bound(a, b + 1, type(uint256).max);
        if (b > 0) _issue(alice, b, MEMO);
        _expectRevertUnchanged(
            admin,
            false,
            alice,
            a,
            abi.encodeWithSelector(IIndicoLedger.InsufficientAvailableCredit.selector, a, b)
        );
    }

    // ================================================================== user, both functions

    function test_user_zero_revertsZeroAddressFirst() public {
        for (uint256 f; f < 2; ++f) {
            _expectRevertUnchanged(
                admin,
                f == 0,
                address(0),
                0,
                abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector)
            );
        }
    }

    /// @dev Never approved, merchant, revoked merchant, the ledger, USDC: NotAUser, both
    ///      functions. For issue to a merchant this is the D-33 evidence: `_mint` is never reached.
    function test_user_notAUser_bothFunctions() public {
        address[5] memory who = [
            makeAddr("stranger"),
            merchantA,
            _participant(Participant.MerchantRevoked),
            address(ledger),
            address(usdc)
        ];
        for (uint256 f; f < 2; ++f) {
            for (uint256 i; i < who.length; ++i) {
                _expectRevertUnchanged(
                    admin,
                    f == 0,
                    who[i],
                    1,
                    abi.encodeWithSelector(IIndicoLedger.NotAUser.selector, who[i])
                );
            }
        }
    }

    function test_user_signedButNeverApproved_notAUser() public {
        address a = _participant(Participant.RegisteredNotApproved);
        _expectRevertUnchanged(
            admin, true, a, 1, abi.encodeWithSelector(IIndicoLedger.NotAUser.selector, a)
        );
    }

    function test_user_approvedButUnsigned_canBeIssued() public {
        address a = _participant(Participant.ApprovedNotSigned);
        _issue(a, 1, MEMO);
        assertEq(ledger.credit(a), 1);
    }

    function test_amount_zero_revertsZeroAmount_bothFunctions() public {
        for (uint256 f; f < 2; ++f) {
            _expectRevertUnchanged(
                admin, f == 0, alice, 0, abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
            );
        }
    }

    // ================================================================== access, pause, order

    function test_nonAdmins_revert_bothFunctions() public {
        address[7] memory who =
            [guardian, alice, bob, merchantA, address(this), address(ledger), makeAddr("random")];
        bytes32 role = ledger.ADMIN_ROLE();
        for (uint256 f; f < 2; ++f) {
            for (uint256 i; i < who.length; ++i) {
                _expectRevertUnchanged(
                    who[i],
                    f == 0,
                    alice,
                    1,
                    abi.encodeWithSelector(
                        IAccessControl.AccessControlUnauthorizedAccount.selector, who[i], role
                    )
                );
            }
        }
    }

    function test_paused_reverts_bothFunctions() public {
        _issue(alice, 5e6, MEMO);
        _pause();
        for (uint256 f; f < 2; ++f) {
            _expectRevertUnchanged(
                admin, f == 0, alice, 1, abi.encodeWithSelector(Pausable.EnforcedPause.selector)
            );
        }
    }

    function test_order_accessBeforePause() public {
        _pause();
        bytes32 role = ledger.ADMIN_ROLE();
        _expectRevertUnchanged(
            alice,
            true,
            address(0),
            0,
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role
            )
        );
    }

    function test_order_pauseBeforeZeroAddress() public {
        _pause();
        _expectRevertUnchanged(
            admin, false, address(0), 0, abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    function test_order_notAUserBeforeZeroAmount() public {
        _expectRevertUnchanged(
            admin,
            true,
            merchantA,
            0,
            abi.encodeWithSelector(IIndicoLedger.NotAUser.selector, merchantA)
        );
    }

    function test_order_zeroAmountBeforeLimits() public {
        _issue(alice, CREDIT_CAP, MEMO);
        _expectRevertUnchanged(
            admin, true, alice, 0, abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
        );
        _expectRevertUnchanged(
            admin, false, bob, 0, abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
        );
    }

    // ================================================================== property (D-33)

    /// @dev Any sequence of issues and debits, valid or not: afterwards totalCredit equals the
    ///      sum of every balance and no user is above CREDIT_CAP.
    function testFuzz_anySequence_totalIsSum_usersWithinCap(uint256 seed) public {
        address[3] memory users = [alice, bob, revokedUser];
        for (uint256 step; step < 24; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            address u = users[r % 3];
            uint256 amount = (r >> 8) % 4 == 0 ? (r >> 16) : (r >> 16) % (CREDIT_CAP / 2 + 1);
            vm.prank(admin);
            if ((r >> 2) % 2 == 0) {
                try ledger.adminIssueCredit(u, amount, MEMO) {} catch {}
            } else {
                try ledger.adminDebitCredit(u, amount, MEMO) {} catch {}
            }
        }
        uint256 sum;
        for (uint256 i; i < actors.length; ++i) {
            sum += ledger.credit(actors[i]);
        }
        assertEq(ledger.totalCredit(), sum, "totalCredit == sum of balances");
        for (uint256 i; i < users.length; ++i) {
            assertLe(ledger.credit(users[i]), CREDIT_CAP, "user within cap");
        }
    }
}
