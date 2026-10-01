// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {StateSnapshot} from "../helpers/StateSnapshot.sol";

/// @notice `signTerms`, contract-spec 6.2, PRD U-06 to U-08 and S-02, D-10, D-25, D-26.
///
/// signTerms(bytes32 acceptedHash), by caller state and stored hash
/// | termsHash  | Caller                                  | acceptedHash     | Expected                               |
/// |------------|-----------------------------------------|------------------|----------------------------------------|
/// | unset      | anyone                                  | zero             | TermsNotSet                            |
/// | unset      | anyone                                  | any non-zero     | TermsNotSet                            |
/// | H1         | never signed, not approved              | H1               | signed, signedTermsHash H1, event      |
/// | H1         | approved user / merchant / admin / guardian | H1           | signed (no approval check, CS 6.2)     |
/// | H1         | anyone                                  | zero             | WrongTermsHash                         |
/// | H1         | anyone                                  | H2, bytes32 max  | WrongTermsHash                         |
/// | H1         | signed H1                               | H1               | AlreadySigned                          |
/// | H2 (new)   | signed H1                               | H1 (stale)       | WrongTermsHash                         |
/// | H2 (new)   | signed H1                               | H2               | allowed, signedTermsHash H2, event (D-25) |
/// | H1 (reset) | last signed H1                          | H1               | AlreadySigned                          |
/// | H1 (reset) | signed only H2                          | H1               | allowed, signedTermsHash back to H1    |
/// | H1         | signed H1, paused                       | H1               | EnforcedPause                          |
/// | H1         | never signed, paused                    | H1               | EnforcedPause                          |
/// Check order: EnforcedPause, TermsNotSet, WrongTermsHash, AlreadySigned.
/// `termsSigned` becomes true on the first signature and is never cleared by a hash change.
/// Every revert leaves the full state snapshot unchanged.
contract SignTermsTest is StateSnapshot {
    bytes32 internal constant H1 = keccak256("terms-v1");
    bytes32 internal constant H2 = keccak256("terms-v2");

    address internal x = makeAddr("x");

    function setUp() public override {
        super.setUp();
        _addActor(x);
    }

    function _setHash(bytes32 h) internal {
        vm.prank(admin);
        ledger.setTermsHash(h);
    }

    function _signAs(address who, bytes32 h) internal {
        vm.prank(who);
        ledger.signTerms(h);
    }

    function _expectRevertUnchanged(address who, bytes32 h, bytes memory err) internal {
        Snapshot memory s = _snapshot();
        vm.expectRevert(err);
        _signAs(who, h);
        _assertUnchanged(s);
    }

    // ------------------------------------------------------------------ not set

    function test_beforeAnyHash_zero_revertsTermsNotSet() public {
        _expectRevertUnchanged(
            x, bytes32(0), abi.encodeWithSelector(IIndicoLedger.TermsNotSet.selector)
        );
    }

    function test_beforeAnyHash_nonZero_revertsTermsNotSet() public {
        _expectRevertUnchanged(x, H1, abi.encodeWithSelector(IIndicoLedger.TermsNotSet.selector));
    }

    // ------------------------------------------------------------------ happy path

    function test_currentHash_signs_recordsVersion_emitsWithTime() public {
        _setHash(H1);
        vm.warp(1_800_000_000);
        Snapshot memory s = _snapshot();

        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.TermsSigned(x, H1, 1_800_000_000);
        _signAs(x, H1);

        assertTrue(ledger.termsSigned(x));
        assertEq(ledger.signedTermsHash(x), H1);
        uint256 i = s.who.length - 1;
        s.termsSigned[i] = true;
        s.signedTermsHash[i] = H1;
        _assertUnchanged(s);
    }

    function test_sign_emitsNothingElse() public {
        _setHash(H1);
        vm.recordLogs();
        _signAs(x, H1);
        assertEq(vm.getRecordedLogs().length, 1);
    }

    /// @dev No approval check (CS 6.2): every kind of address may sign.
    function test_anyone_canSign_noApprovalNeeded() public {
        _setHash(H1);
        vm.prank(admin);
        ledger.setUserApproved(alice, true);
        vm.prank(admin);
        ledger.setMerchantApproved(merchantA, true);
        address[5] memory who = [x, alice, merchantA, admin, guardian];
        for (uint256 i; i < who.length; ++i) {
            _signAs(who[i], H1);
            assertTrue(ledger.termsSigned(who[i]));
            assertEq(ledger.signedTermsHash(who[i]), H1);
        }
        assertFalse(ledger.approvedUser(x), "signing approves nobody");
    }

    // ------------------------------------------------------------------ wrong hash

    function test_zeroHash_whenSet_revertsWrongTermsHash() public {
        _setHash(H1);
        _expectRevertUnchanged(
            x, bytes32(0), abi.encodeWithSelector(IIndicoLedger.WrongTermsHash.selector)
        );
    }

    function test_otherHash_revertsWrongTermsHash() public {
        _setHash(H1);
        _expectRevertUnchanged(x, H2, abi.encodeWithSelector(IIndicoLedger.WrongTermsHash.selector));
        _expectRevertUnchanged(
            x,
            bytes32(type(uint256).max),
            abi.encodeWithSelector(IIndicoLedger.WrongTermsHash.selector)
        );
    }

    function testFuzz_anyHashButCurrent_revertsWrongTermsHash(bytes32 h) public {
        _setHash(H1);
        vm.assume(h != H1);
        _expectRevertUnchanged(x, h, abi.encodeWithSelector(IIndicoLedger.WrongTermsHash.selector));
    }

    /// @dev The test that matters (testing-strategy 2.2): a user cannot be recorded as
    ///      accepting terms they never saw.
    function test_staleHash_afterChange_revertsWrongTermsHash() public {
        _setHash(H1);
        _signAs(x, H1);
        _setHash(H2);
        _expectRevertUnchanged(x, H1, abi.encodeWithSelector(IIndicoLedger.WrongTermsHash.selector));
        address y = makeAddr("y");
        _expectRevertUnchanged(y, H1, abi.encodeWithSelector(IIndicoLedger.WrongTermsHash.selector));
    }

    // ------------------------------------------------------------------ already signed

    function test_secondSignature_sameVersion_revertsAlreadySigned() public {
        _setHash(H1);
        _signAs(x, H1);
        _expectRevertUnchanged(x, H1, abi.encodeWithSelector(IIndicoLedger.AlreadySigned.selector));
    }

    function testFuzz_anyCaller_signsOnce_thenAlreadySigned(address who) public {
        assumeNotForgeAddress(who);
        _setHash(H1);
        _signAs(who, H1);
        assertEq(ledger.signedTermsHash(who), H1);
        vm.expectRevert(IIndicoLedger.AlreadySigned.selector);
        _signAs(who, H1);
    }

    // ------------------------------------------------------------------ versions, D-25

    function test_hashChange_keepsExistingSignature() public {
        _setHash(H1);
        _signAs(x, H1);
        _setHash(H2);
        assertTrue(ledger.termsSigned(x), "not cleared");
        assertEq(ledger.signedTermsHash(x), H1, "still names the old version");
    }

    function test_newVersion_canBeSigned_recordsAndEmitsAgain() public {
        _setHash(H1);
        _signAs(x, H1);
        _setHash(H2);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.TermsSigned(x, H2, block.timestamp);
        _signAs(x, H2);
        assertTrue(ledger.termsSigned(x));
        assertEq(ledger.signedTermsHash(x), H2);
    }

    /// @dev Admin sets an old hash again. Last signed that version: AlreadySigned.
    function test_oldHashReset_lastSignedThatVersion_revertsAlreadySigned() public {
        _setHash(H1);
        _signAs(x, H1);
        _setHash(H2);
        _setHash(H1);
        _expectRevertUnchanged(x, H1, abi.encodeWithSelector(IIndicoLedger.AlreadySigned.selector));
        assertEq(ledger.signedTermsHash(x), H1);
    }

    /// @dev Admin sets an old hash again. Signed only the newer one: may sign the old again.
    function test_oldHashReset_signedOnlyNewer_canSignAgain() public {
        _setHash(H1);
        _signAs(x, H1);
        _setHash(H2);
        _signAs(x, H2);
        _setHash(H1);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.TermsSigned(x, H1, block.timestamp);
        _signAs(x, H1);
        assertEq(ledger.signedTermsHash(x), H1);
        assertTrue(ledger.termsSigned(x));
    }

    // ------------------------------------------------------------------ paused, order

    function test_paused_neverSigned_reverts() public {
        _setHash(H1);
        _pause();
        _expectRevertUnchanged(x, H1, abi.encodeWithSelector(Pausable.EnforcedPause.selector));
    }

    function test_paused_alreadySigned_revertsEnforcedPauseFirst() public {
        _setHash(H1);
        _signAs(x, H1);
        _pause();
        _expectRevertUnchanged(x, H1, abi.encodeWithSelector(Pausable.EnforcedPause.selector));
    }

    function test_order_notSetBeforeWrongHash() public {
        _expectRevertUnchanged(x, H2, abi.encodeWithSelector(IIndicoLedger.TermsNotSet.selector));
    }

    function test_order_wrongHashBeforeAlreadySigned() public {
        _setHash(H1);
        _signAs(x, H1);
        _expectRevertUnchanged(x, H2, abi.encodeWithSelector(IIndicoLedger.WrongTermsHash.selector));
    }
}
