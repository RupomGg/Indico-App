// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {CREDIT_CAP} from "../../src/lib/Constants.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice `spend`, contract-spec 6.4, PRD C-03 to C-08, S-05, S-06, D-22, D-26, D-27, D-37.
///
/// merchant (address)
/// | Class                                 | Expected                                   |
/// |---------------------------------------|--------------------------------------------|
/// | zero address                          | ZeroAddress (first among merchant checks)  |
/// | the ledger, the USDC address          | NotApprovedMerchant (never approvable)     |
/// | never approved                        | NotApprovedMerchant                        |
/// | the caller itself (D-22)              | NotApprovedMerchant: a user is never a merchant |
/// | another user                          | NotApprovedMerchant                        |
/// | revoked merchant                      | NotApprovedMerchant                        |
/// | approved, terms not signed (D-37)     | MerchantTermsNotSigned(merchant)           |
/// | approved and signed                   | paid                                       |
/// amount (uint256), available a
/// | zero                                  | ZeroAmount                                 |
/// | one wei                               | moved                                      |
/// | typical                               | moved                                      |
/// | exactly a                             | moved, payer at zero                       |
/// | a plus one, uint256 max               | InsufficientAvailableCredit(amount, a)     |
/// caller: approved and signed pays; unapproved, revoked, merchant, admin -> NotApprovedUser;
/// approved but unsigned -> TermsNotSigned; paused -> EnforcedPause.
/// Effects: the payer loses exactly `amount`, the merchant gains exactly `amount` (no fee, S-05),
/// `totalCredit` unchanged; `Spent` and `MerchantReceipt(..., block.timestamp)` (D-26), nothing
/// else. A merchant paid by many may exceed CREDIT_CAP (D-27).
/// Check order: EnforcedPause, NotApprovedUser, TermsNotSigned, ZeroAddress, NotApprovedMerchant,
/// MerchantTermsNotSigned, ZeroAmount, InsufficientAvailableCredit.
/// Every revert leaves the full state snapshot unchanged.
contract SpendTest is Actors {
    uint256 internal constant BAL = 1_000e6;

    function setUp() public override {
        super.setUp();
        _mintCredit(alice, BAL);
    }

    function _spend(address from, address to, uint256 amount) internal {
        vm.prank(from);
        ledger.spend(to, amount);
    }

    function _expectRevertUnchanged(address from, address to, uint256 amount, bytes memory err)
        internal
    {
        _revertsUnchanged(from, abi.encodeCall(IIndicoLedger.spend, (to, amount)), err);
    }

    function _index(address a) internal view returns (uint256) {
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] == a) return i;
        }
        revert("not an actor");
    }

    // ================================================================== happy path

    function test_spend_movesExactly_noFee_emitsBoth() public {
        vm.warp(1_800_000_000);
        Snapshot memory s = _snapshot();
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.Spent(alice, merchantA, 250e6);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.MerchantReceipt(merchantA, alice, 250e6, 1_800_000_000);
        _spend(alice, merchantA, 250e6);

        s.credit[_index(alice)] -= 250e6;
        s.credit[_index(merchantA)] += 250e6;
        _assertUnchanged(s); // totalCredit unchanged: credit moved, none minted or burned
    }

    function test_spend_emitsExactlyTwoEvents() public {
        vm.recordLogs();
        _spend(alice, merchantA, 1);
        assertEq(vm.getRecordedLogs().length, 2);
    }

    function test_spend_oneWei() public {
        _spend(alice, merchantA, 1);
        assertEq(ledger.credit(alice), BAL - 1);
        assertEq(ledger.credit(merchantA), 1);
    }

    function test_spend_exactlyAvailable_payerAtZero() public {
        _spend(alice, merchantA, BAL);
        assertEq(ledger.credit(alice), 0);
        assertEq(ledger.credit(merchantA), BAL);
        assertEq(ledger.totalCredit(), BAL);
    }

    function test_spend_twoMerchants_eachExact() public {
        _spend(alice, merchantA, 100e6);
        _spend(alice, merchantB, 300e6);
        assertEq(ledger.credit(merchantA), 100e6);
        assertEq(ledger.credit(merchantB), 300e6);
        assertEq(ledger.credit(alice), BAL - 400e6);
    }

    function test_spend_signedOnlyOlderTerms_bothSides_allowed() public {
        vm.prank(admin);
        ledger.setTermsHash(keccak256("terms-v2"));
        _spend(alice, merchantA, 1);
        assertEq(ledger.credit(merchantA), 1);
    }

    /// @dev D-27: a merchant paid by many may hold more than CREDIT_CAP; spend is not a mint.
    function test_merchant_mayExceedCap_viaSpend() public {
        _mintCredit(alice, CREDIT_CAP - BAL);
        _mintCredit(bob, CREDIT_CAP);
        _spend(alice, merchantA, CREDIT_CAP);
        _spend(bob, merchantA, CREDIT_CAP);
        assertEq(ledger.credit(merchantA), 2 * CREDIT_CAP);
        assertEq(ledger.totalCredit(), 2 * CREDIT_CAP);
    }

    function testFuzz_spend_withinAvailable_conserves(uint256 amount) public {
        amount = bound(amount, 1, BAL);
        uint256 total = ledger.totalCredit();
        _startDiff();
        _spend(alice, merchantA, amount);
        Write[] memory w = new Write[](2);
        w[0] = _w(address(ledger), _key(alice, SLOT_CREDIT), BAL - amount);
        w[1] = _w(address(ledger), _key(merchantA, SLOT_CREDIT), amount);
        _assertWrites(w);
        assertEq(ledger.credit(alice), BAL - amount);
        assertEq(ledger.credit(merchantA), amount);
        assertEq(ledger.totalCredit(), total);
    }

    // ================================================================== amount

    function test_amount_zero_revertsZeroAmount() public {
        _expectRevertUnchanged(
            alice, merchantA, 0, abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
        );
    }

    function test_amount_availablePlusOne_reverts() public {
        _expectRevertUnchanged(
            alice,
            merchantA,
            BAL + 1,
            abi.encodeWithSelector(IIndicoLedger.InsufficientAvailableCredit.selector, BAL + 1, BAL)
        );
    }

    function test_amount_uint256Max_reverts() public {
        _expectRevertUnchanged(
            alice,
            merchantA,
            type(uint256).max,
            abi.encodeWithSelector(
                IIndicoLedger.InsufficientAvailableCredit.selector, type(uint256).max, BAL
            )
        );
    }

    function test_amount_noCredit_reverts() public {
        _expectRevertUnchanged(
            bob,
            merchantA,
            1,
            abi.encodeWithSelector(IIndicoLedger.InsufficientAvailableCredit.selector, 1, 0)
        );
    }

    function testFuzz_amount_aboveAvailable_alwaysNamedRevert(uint256 amount) public {
        amount = bound(amount, BAL + 1, type(uint256).max);
        _expectRevertUnchanged(
            alice,
            merchantA,
            amount,
            abi.encodeWithSelector(IIndicoLedger.InsufficientAvailableCredit.selector, amount, BAL)
        );
    }

    // ================================================================== merchant

    function test_merchant_zero_revertsZeroAddress() public {
        _expectRevertUnchanged(
            alice, address(0), 1, abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector)
        );
    }

    function test_merchant_notApproved_variants() public {
        address[6] memory who = [
            address(ledger),
            address(usdc),
            makeAddr("stranger"),
            bob,
            _participant(Participant.MerchantRevoked),
            admin
        ];
        for (uint256 i; i < who.length; ++i) {
            _expectRevertUnchanged(
                alice, who[i], 1, abi.encodeWithSelector(IIndicoLedger.NotApprovedMerchant.selector)
            );
        }
    }

    /// @dev D-22: a user can never be an approved merchant, so paying yourself is refused by the
    ///      merchant check itself; no separate self-spend rule exists or is needed.
    function test_spendToSelf_revertsNotApprovedMerchant_D22() public {
        _expectRevertUnchanged(
            alice, alice, 1, abi.encodeWithSelector(IIndicoLedger.NotApprovedMerchant.selector)
        );
    }

    /// @dev D-37: an approved merchant who has not signed the terms cannot be paid.
    function test_merchant_approvedNotSigned_reverts() public {
        address m = makeAddr("unsignedMerchant");
        _addActor(m);
        vm.prank(admin);
        ledger.setMerchantApproved(m, true);
        _expectRevertUnchanged(
            alice, m, 1, abi.encodeWithSelector(IIndicoLedger.MerchantTermsNotSigned.selector, m)
        );
        _sign(m);
        _spend(alice, m, 1);
        assertEq(ledger.credit(m), 1, "paid once signed");
    }

    // ================================================================== caller, pause

    function test_caller_notApprovedUser_reverts() public {
        address[5] memory who = [makeAddr("stranger"), merchantA, admin, guardian, address(this)];
        for (uint256 i; i < who.length; ++i) {
            _expectRevertUnchanged(
                who[i], merchantB, 1, abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
            );
        }
    }

    function test_caller_revoked_reverts_creditKept() public {
        _revokeUser(alice);
        _expectRevertUnchanged(
            alice, merchantA, 1, abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
        );
        assertEq(ledger.credit(alice), BAL);
    }

    function test_caller_approvedNotSigned_reverts() public {
        address a = _participant(Participant.ApprovedNotSigned);
        _mintCredit(a, 5);
        _expectRevertUnchanged(
            a, merchantA, 1, abi.encodeWithSelector(IIndicoLedger.TermsNotSigned.selector)
        );
    }

    function test_paused_reverts() public {
        _pause();
        _expectRevertUnchanged(
            alice, merchantA, 1, abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    // ================================================================== check order

    function test_order_pauseFirst() public {
        _pause();
        _expectRevertUnchanged(
            makeAddr("stranger"),
            address(0),
            0,
            abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    function test_order_userBeforeMerchant() public {
        _expectRevertUnchanged(
            makeAddr("stranger"),
            address(0),
            0,
            abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
        );
    }

    function test_order_termsBeforeMerchant() public {
        address a = _participant(Participant.ApprovedNotSigned);
        _expectRevertUnchanged(
            a, address(0), 0, abi.encodeWithSelector(IIndicoLedger.TermsNotSigned.selector)
        );
    }

    function test_order_zeroAddressBeforeNotApproved() public {
        _expectRevertUnchanged(
            alice, address(0), 0, abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector)
        );
    }

    function test_order_notApprovedMerchantBeforeAmount() public {
        _expectRevertUnchanged(
            alice, bob, 0, abi.encodeWithSelector(IIndicoLedger.NotApprovedMerchant.selector)
        );
    }

    function test_order_merchantTermsBeforeAmount() public {
        address m = makeAddr("unsignedMerchant");
        vm.prank(admin);
        ledger.setMerchantApproved(m, true);
        _expectRevertUnchanged(
            alice, m, 0, abi.encodeWithSelector(IIndicoLedger.MerchantTermsNotSigned.selector, m)
        );
    }

    function test_order_zeroAmountBeforeAvailable() public {
        _expectRevertUnchanged(
            bob, merchantA, 0, abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
        );
    }
}
