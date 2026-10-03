// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {CREDIT_CAP, MAX_ASSET_TYPE} from "../../src/lib/Constants.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice `registerAsset`, contract-spec 6.3, PRD A-06 to A-08, U-08, C-01, D-12, D-27 to D-29.
///
/// value (uint256), caller balance before = b
/// | Class                       | Value                      | Expected                                  |
/// |-----------------------------|----------------------------|-------------------------------------------|
/// | zero                        | 0                          | ZeroAmount                                |
/// | one wei                     | 1                          | minted                                    |
/// | typical                     | 1_000e6                    | minted                                    |
/// | exactly the cap, b = 0      | 2^128 - 1                  | minted                                    |
/// | cap plus one, b = 0         | 2^128                      | CreditCapExceeded(2^128, 2^128 - 1)       |
/// | uint256 max                 | 2^256 - 1                  | CreditCapExceeded(max, 2^128 - 1), no panic |
/// | exactly the room left       | cap - b                    | minted, balance at the cap                |
/// | room plus one               | cap - b + 1                | CreditCapExceeded(value, cap - b)         |
/// | any value at a full account | b = cap, value 1           | CreditCapExceeded(1, 0)                   |
/// docHash (bytes32)
/// | zero                        | 0x00                       | ZeroDocHash                               |
/// | typical, max                | keccak, bytes32 max        | registered                                |
/// | already registered by self  |                            | AssetAlreadyRegistered                    |
/// | already registered by other |                            | AssetAlreadyRegistered                    |
/// assetType (uint8), all 256 values
/// | 0 to 5                      |                            | registered, type emitted                  |
/// | 6 to 255                    |                            | InvalidAssetType(t)                       |
/// caller: approved and signed succeeds; unknown, signed-not-approved, revoked, merchant, admin,
/// guardian -> NotApprovedUser; approved-not-signed -> TermsNotSigned; signed an older terms
/// version only -> allowed (D-25); paused -> EnforcedPause.
/// Check order: EnforcedPause, NotApprovedUser, TermsNotSigned, ZeroAmount, ZeroDocHash,
/// InvalidAssetType, AssetAlreadyRegistered, CreditCapExceeded.
/// One account at the cap never stops another registering (D-27).
/// Every revert leaves the full state snapshot unchanged.
contract RegisterAssetTest is Actors {
    bytes32 internal constant DOC = keccak256("doc-1");
    uint256 internal nonce;

    function _doc() internal returns (bytes32) {
        return keccak256(abi.encode("doc", ++nonce));
    }

    function _register(address who, bytes32 h, uint8 t, uint256 v) internal {
        vm.prank(who);
        ledger.registerAsset(h, t, v);
    }

    function _expectRevertUnchanged(address who, bytes32 h, uint8 t, uint256 v, bytes memory err)
        internal
    {
        Snapshot memory s = _snapshot();
        vm.expectRevert(err);
        _register(who, h, t, v);
        _assertUnchanged(s);
    }

    function _index(address a) internal view returns (uint256) {
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] == a) return i;
        }
        revert("not an actor");
    }

    // ================================================================== happy path

    function test_register_mintsExactly_marksHash_emitsBoth() public {
        uint256 v = 1_000e6;
        Snapshot memory s = _snapshot();

        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.AssetRegistered(alice, DOC, 2, v);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.CreditMinted(alice, v, DOC);
        _register(alice, DOC, 2, v);

        assertTrue(ledger.assetRegistered(DOC));
        s.credit[_index(alice)] += v;
        s.totalCredit += v;
        _assertUnchanged(s);
    }

    function test_register_emitsExactlyTwoEvents() public {
        vm.recordLogs();
        _register(alice, DOC, 0, 1);
        assertEq(vm.getRecordedLogs().length, 2);
    }

    function test_register_oneWei() public {
        _register(alice, DOC, 0, 1);
        assertEq(ledger.credit(alice), 1);
        assertEq(ledger.totalCredit(), 1);
    }

    function test_register_maxDocHash() public {
        bytes32 h = bytes32(type(uint256).max);
        _register(alice, h, 0, 1);
        assertTrue(ledger.assetRegistered(h));
    }

    function test_register_severalAssets_creditIsOneFungibleSum() public {
        _register(alice, _doc(), 0, 100e6);
        _register(alice, _doc(), 3, 250e6);
        _register(bob, _doc(), 5, 7e6);
        assertEq(ledger.credit(alice), 350e6);
        assertEq(ledger.credit(bob), 7e6);
        assertEq(ledger.totalCredit(), 357e6, "totalCredit == sum of balances");
    }

    /// @dev D-25: access needs a signature of any version, not the current one.
    function test_register_signedOnlyOlderTerms_allowed() public {
        vm.prank(admin);
        ledger.setTermsHash(keccak256("terms-v2"));
        _register(alice, DOC, 0, 1);
        assertEq(ledger.credit(alice), 1);
    }

    function testFuzz_register_anyValueWithinCap_mintsExactly(uint256 v, bytes32 h) public {
        v = bound(v, 1, CREDIT_CAP);
        if (h == bytes32(0)) h = DOC; // remapped, never discarded (INSTRUCTION 1.2)
        _register(alice, h, 1, v);
        assertEq(ledger.credit(alice), v);
        assertEq(ledger.totalCredit(), v);
        assertTrue(ledger.assetRegistered(h));
    }

    // ================================================================== value

    function test_value_zero_revertsZeroAmount() public {
        _expectRevertUnchanged(
            alice, DOC, 0, 0, abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
        );
    }

    function test_value_exactlyCap_fromZero_minted() public {
        _register(alice, DOC, 0, CREDIT_CAP);
        assertEq(ledger.credit(alice), CREDIT_CAP);
    }

    function test_value_capPlusOne_fromZero_reverts() public {
        _expectRevertUnchanged(
            alice,
            DOC,
            0,
            CREDIT_CAP + 1,
            abi.encodeWithSelector(
                IIndicoLedger.CreditCapExceeded.selector, CREDIT_CAP + 1, CREDIT_CAP
            )
        );
    }

    function test_value_uint256Max_revertsNamed_noPanic() public {
        _expectRevertUnchanged(
            alice,
            DOC,
            0,
            type(uint256).max,
            abi.encodeWithSelector(
                IIndicoLedger.CreditCapExceeded.selector, type(uint256).max, CREDIT_CAP
            )
        );
    }

    function test_value_exactlyRoomLeft_minted_reachesCap() public {
        uint256 b = 123_456e6;
        _register(alice, _doc(), 0, b);
        _register(alice, _doc(), 0, CREDIT_CAP - b);
        assertEq(ledger.credit(alice), CREDIT_CAP);
    }

    function test_value_roomPlusOne_reverts() public {
        uint256 b = CREDIT_CAP - 1;
        _register(alice, _doc(), 0, b);
        _expectRevertUnchanged(
            alice,
            _doc(),
            0,
            2,
            abi.encodeWithSelector(IIndicoLedger.CreditCapExceeded.selector, 2, 1)
        );
    }

    function test_value_fullAccount_anyMint_reverts() public {
        _register(alice, _doc(), 0, CREDIT_CAP);
        _expectRevertUnchanged(
            alice,
            _doc(),
            0,
            1,
            abi.encodeWithSelector(IIndicoLedger.CreditCapExceeded.selector, 1, 0)
        );
    }

    function testFuzz_value_aboveRoom_alwaysNamedRevert(uint256 b, uint256 v) public {
        b = bound(b, 1, CREDIT_CAP);
        _register(alice, _doc(), 0, b);
        uint256 room = CREDIT_CAP - b;
        v = bound(v, room + 1, type(uint256).max);
        _expectRevertUnchanged(
            alice,
            _doc(),
            0,
            v,
            abi.encodeWithSelector(IIndicoLedger.CreditCapExceeded.selector, v, room)
        );
    }

    /// @dev D-27: the cap is per account, so one user at the cap blocks nobody else.
    function test_oneUserAtCap_doesNotStopAnother() public {
        _register(alice, _doc(), 0, CREDIT_CAP);
        _register(bob, _doc(), 0, CREDIT_CAP);
        assertEq(ledger.credit(bob), CREDIT_CAP);
        assertEq(ledger.totalCredit(), 2 * CREDIT_CAP, "total is uint256, above 2^128");
    }

    // ================================================================== docHash

    function test_docHash_zero_revertsZeroDocHash() public {
        _expectRevertUnchanged(
            alice, bytes32(0), 0, 1, abi.encodeWithSelector(IIndicoLedger.ZeroDocHash.selector)
        );
    }

    function test_docHash_againBySameUser_reverts() public {
        _register(alice, DOC, 0, 1);
        _expectRevertUnchanged(
            alice, DOC, 0, 1, abi.encodeWithSelector(IIndicoLedger.AssetAlreadyRegistered.selector)
        );
    }

    function test_docHash_againByOtherUser_reverts() public {
        _register(alice, DOC, 0, 1);
        _expectRevertUnchanged(
            bob,
            DOC,
            4,
            999e6,
            abi.encodeWithSelector(IIndicoLedger.AssetAlreadyRegistered.selector)
        );
    }

    // ================================================================== assetType, IT 2.5

    /// @dev Every uint8 value: 0 to 5 register and are emitted as given, 6 to 255 revert.
    function test_assetType_all256Values() public {
        for (uint256 t; t <= type(uint8).max; ++t) {
            bytes32 h = keccak256(abi.encode("type", t));
            if (t <= MAX_ASSET_TYPE) {
                vm.expectEmit(true, true, true, true, address(ledger));
                emit IIndicoLedger.AssetRegistered(alice, h, uint8(t), 1);
                _register(alice, h, uint8(t), 1);
                assertTrue(ledger.assetRegistered(h));
            } else {
                _expectRevertUnchanged(
                    alice,
                    h,
                    uint8(t),
                    1,
                    abi.encodeWithSelector(IIndicoLedger.InvalidAssetType.selector, uint8(t))
                );
            }
        }
        assertEq(ledger.credit(alice), MAX_ASSET_TYPE + 1, "one wei per valid type");
    }

    // ================================================================== caller

    function test_caller_notApproved_reverts() public {
        address[6] memory who =
            [makeAddr("stranger"), merchantA, merchantB, admin, guardian, address(this)];
        for (uint256 i; i < who.length; ++i) {
            _expectRevertUnchanged(
                who[i], _doc(), 0, 1, abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
            );
        }
    }

    function test_caller_approvedNotSigned_revertsTermsNotSigned() public {
        address a = _participant(Participant.ApprovedNotSigned);
        _expectRevertUnchanged(
            a, _doc(), 0, 1, abi.encodeWithSelector(IIndicoLedger.TermsNotSigned.selector)
        );
    }

    function test_caller_revoked_reverts() public {
        _revokeUser(alice);
        _expectRevertUnchanged(
            alice, _doc(), 0, 1, abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
        );
    }

    function test_paused_reverts() public {
        _pause();
        _expectRevertUnchanged(
            alice, _doc(), 0, 1, abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    // ================================================================== check order

    function test_order_pausedBeforeNotApproved() public {
        _pause();
        _expectRevertUnchanged(
            makeAddr("stranger"),
            bytes32(0),
            9,
            0,
            abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    function test_order_notApprovedBeforeZeroAmount() public {
        _expectRevertUnchanged(
            makeAddr("stranger"),
            bytes32(0),
            9,
            0,
            abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
        );
    }

    function test_order_termsBeforeZeroAmount() public {
        address a = _participant(Participant.ApprovedNotSigned);
        _expectRevertUnchanged(
            a, bytes32(0), 9, 0, abi.encodeWithSelector(IIndicoLedger.TermsNotSigned.selector)
        );
    }

    function test_order_zeroAmountBeforeZeroDocHash() public {
        _expectRevertUnchanged(
            alice, bytes32(0), 9, 0, abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
        );
    }

    function test_order_zeroDocHashBeforeInvalidType() public {
        _expectRevertUnchanged(
            alice, bytes32(0), 9, 1, abi.encodeWithSelector(IIndicoLedger.ZeroDocHash.selector)
        );
    }

    function test_order_invalidTypeBeforeAlreadyRegistered() public {
        _register(alice, DOC, 0, 1);
        _expectRevertUnchanged(
            alice, DOC, 9, 1, abi.encodeWithSelector(IIndicoLedger.InvalidAssetType.selector, 9)
        );
    }

    function test_order_alreadyRegisteredBeforeCap() public {
        _register(alice, DOC, 0, CREDIT_CAP);
        _expectRevertUnchanged(
            alice, DOC, 0, 1, abi.encodeWithSelector(IIndicoLedger.AssetAlreadyRegistered.selector)
        );
    }
}
