// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {ROLE_USER} from "../../src/lib/Constants.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice The account link (D-60): `setUserApproved(user, approved, accountRef)` links an
///         approved user wallet to exactly one app account, and an account to exactly one
///         wallet, permanently (moving an account is O-040). `accountRef` is an opaque random id;
///         the email never reaches the chain. Every case asserts its exact net writes.
///
/// | Case                                                   | Outcome                                   | Net writes |
/// |--------------------------------------------------------|-------------------------------------------|------------|
/// | first approval, fresh wallet and ref                   | allowed, emits                            | flag, role, both links |
/// | repeat approval, same wallet and ref (D-20)            | allowed, emits again, link unchanged      | none       |
/// | revoke, then re-approve with the same ref              | allowed, link unchanged                   | flag only, each time |
/// | revoke, then re-approve with a different ref           | WalletAlreadyLinked(user, linkedRef)      | none       |
/// | new wallet, ref of a revoked wallet                    | AccountAlreadyLinked(ref, revokedWallet)  | none       |
/// | new wallet, ref of an approved wallet                  | AccountAlreadyLinked(ref, wallet)         | none       |
/// | approval with ref 0                                    | ZeroAccountRef                            | none       |
/// | revoke a linked wallet with its own ref                | allowed, emits                            | flag only  |
/// | revoke a linked wallet with ref 0 or another ref       | AccountRefMismatch(user, linkedRef)       | none       |
/// | revoke a wallet never linked, ref 0                    | allowed, emits (D-22)                     | none       |
/// | revoke a wallet never linked, non-zero ref             | AccountRefMismatch(user, 0)               | none       |
/// | approve a merchant's wallet as a user                  | ParticipantRoleConflict (D-22)            | none       |
/// | ref 0 on a merchant's wallet                           | ParticipantRoleConflict first             | none       |
/// Order on approval: ZeroAddress, InvalidParticipant, ParticipantRoleConflict, ZeroAccountRef,
/// WalletAlreadyLinked, AccountAlreadyLinked. On revoke: ZeroAddress, AccountRefMismatch.
/// Property: after any sequence of approvals and revokes the link is one-to-one.
contract AccountLinkTest is Actors {
    address internal w1 = makeAddr("wallet-1");
    address internal w2 = makeAddr("wallet-2");
    bytes32 internal constant R1 = keccak256("account-1");
    bytes32 internal constant R2 = keccak256("account-2");

    function _call(address user, bool approved, bytes32 ref) internal pure returns (bytes memory) {
        return abi.encodeCall(IIndicoLedger.setUserApproved, (user, approved, ref));
    }

    function _set(address user, bool approved, bytes32 ref) internal {
        vm.prank(admin);
        ledger.setUserApproved(user, approved, ref);
    }

    function _assertLinked(address wallet, bytes32 ref) internal view {
        assertEq(ledger.accountRefOf(wallet), ref, "wallet -> account");
        assertEq(ledger.walletOfAccount(ref), wallet, "account -> wallet");
    }

    function _assertUnlinked(address wallet) internal view {
        assertEq(ledger.accountRefOf(wallet), bytes32(0), "wallet linked");
    }

    function _noWrites() internal pure returns (Write[] memory) {
        return new Write[](0);
    }

    function _flagWrite(address wallet, bool v) internal view returns (Write memory) {
        return _w(address(ledger), _key(wallet, SLOT_APPROVED_USER), v ? 1 : 0);
    }

    // ================================================================== approval

    function test_firstApproval_linksBothWays_exactWrites() public {
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.UserApprovalSet(w1, true, R1);
        _startDiff();
        _set(w1, true, R1);
        Write[] memory w = new Write[](4);
        w[0] = _flagWrite(w1, true);
        w[1] = _w(address(ledger), _key(w1, SLOT_PARTICIPANT_ROLE), ROLE_USER);
        w[2] = _w(address(ledger), _key(w1, SLOT_ACCOUNT_REF_OF), uint256(R1));
        w[3] = _w(address(ledger), _key(R1, SLOT_WALLET_OF_ACCOUNT), uint256(uint160(w1)));
        _assertWrites(w);
        _assertLinked(w1, R1);
    }

    /// @dev D-20: a repeat approval is allowed and emits again; nothing is written.
    function test_repeatApproval_sameWalletAndRef_emitsAgain_noWrites() public {
        _set(w1, true, R1);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.UserApprovalSet(w1, true, R1);
        _startDiff();
        _set(w1, true, R1);
        _assertWrites(_noWrites());
        _assertLinked(w1, R1);
    }

    function test_revokeThenReapprove_sameRef_linkUnchanged() public {
        _set(w1, true, R1);
        _startDiff();
        _set(w1, false, R1);
        Write[] memory w = new Write[](1);
        w[0] = _flagWrite(w1, false);
        _assertWrites(w);
        _assertLinked(w1, R1);

        _startDiff();
        _set(w1, true, R1);
        w[0] = _flagWrite(w1, true);
        _assertWrites(w);
        _assertLinked(w1, R1);
    }

    function test_revokeThenReapprove_differentRef_revertsWalletAlreadyLinked() public {
        _set(w1, true, R1);
        _set(w1, false, R1);
        _revertsUnchanged(
            admin,
            _call(w1, true, R2),
            abi.encodeWithSelector(IIndicoLedger.WalletAlreadyLinked.selector, w1, R1)
        );
    }

    function test_approvedWallet_differentRef_revertsWalletAlreadyLinked() public {
        _set(w1, true, R1);
        _revertsUnchanged(
            admin,
            _call(w1, true, R2),
            abi.encodeWithSelector(IIndicoLedger.WalletAlreadyLinked.selector, w1, R1)
        );
    }

    /// @dev The account of a revoked wallet stays linked to it: a new wallet cannot take it.
    function test_newWallet_refOfRevokedWallet_revertsAccountAlreadyLinked() public {
        _set(w1, true, R1);
        _set(w1, false, R1);
        _revertsUnchanged(
            admin,
            _call(w2, true, R1),
            abi.encodeWithSelector(IIndicoLedger.AccountAlreadyLinked.selector, R1, w1)
        );
    }

    function test_newWallet_refOfApprovedWallet_revertsAccountAlreadyLinked() public {
        _set(w1, true, R1);
        _revertsUnchanged(
            admin,
            _call(w2, true, R1),
            abi.encodeWithSelector(IIndicoLedger.AccountAlreadyLinked.selector, R1, w1)
        );
    }

    function test_approval_zeroRef_revertsZeroAccountRef() public {
        _revertsUnchanged(
            admin,
            _call(w1, true, bytes32(0)),
            abi.encodeWithSelector(IIndicoLedger.ZeroAccountRef.selector)
        );
    }

    // ================================================================== revoke

    function test_revokeLinked_ownRef_flagOnly() public {
        _set(w1, true, R1);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.UserApprovalSet(w1, false, R1);
        _startDiff();
        _set(w1, false, R1);
        Write[] memory w = new Write[](1);
        w[0] = _flagWrite(w1, false);
        _assertWrites(w);
        _assertLinked(w1, R1);
    }

    /// @dev Ref 0 on a linked wallet is a mismatch, not ZeroAccountRef: on a revoke the one rule
    ///      is "equal to the wallet's link" (D-60).
    function test_revokeLinked_zeroRef_revertsMismatch() public {
        _set(w1, true, R1);
        _revertsUnchanged(
            admin,
            _call(w1, false, bytes32(0)),
            abi.encodeWithSelector(IIndicoLedger.AccountRefMismatch.selector, w1, R1)
        );
    }

    function test_revokeLinked_otherRef_revertsMismatch() public {
        _set(w1, true, R1);
        _revertsUnchanged(
            admin,
            _call(w1, false, R2),
            abi.encodeWithSelector(IIndicoLedger.AccountRefMismatch.selector, w1, R1)
        );
    }

    /// @dev D-22: revoking an address never approved is allowed, with ref 0; nothing is written.
    function test_revokeNeverLinked_zeroRef_allowed_noWrites() public {
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.UserApprovalSet(w1, false, bytes32(0));
        _startDiff();
        _set(w1, false, bytes32(0));
        _assertWrites(_noWrites());
        _assertUnlinked(w1);
        assertEq(ledger.walletOfAccount(bytes32(0)), address(0), "nothing linked to ref 0");
    }

    function test_revokeNeverLinked_nonZeroRef_revertsMismatch() public {
        _revertsUnchanged(
            admin,
            _call(w1, false, R1),
            abi.encodeWithSelector(IIndicoLedger.AccountRefMismatch.selector, w1, bytes32(0))
        );
    }

    // ================================================================== roles, order

    /// @dev D-22: a merchant's wallet cannot become a user; no link is written.
    function test_merchantWallet_approveAsUser_roleConflict_noLink() public {
        _revertsUnchanged(
            admin,
            _call(merchantA, true, R1),
            abi.encodeWithSelector(IIndicoLedger.ParticipantRoleConflict.selector, merchantA)
        );
        assertEq(ledger.walletOfAccount(R1), address(0));
    }

    function test_order_roleConflictBeforeZeroRef() public {
        _revertsUnchanged(
            admin,
            _call(merchantA, true, bytes32(0)),
            abi.encodeWithSelector(IIndicoLedger.ParticipantRoleConflict.selector, merchantA)
        );
    }

    function test_order_zeroAddressFirst_bothValues() public {
        _revertsUnchanged(
            admin,
            _call(address(0), true, bytes32(0)),
            abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector)
        );
        _revertsUnchanged(
            admin,
            _call(address(0), false, R1),
            abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector)
        );
    }

    function test_order_invalidParticipantBeforeZeroRef() public {
        _revertsUnchanged(
            admin,
            _call(address(ledger), true, bytes32(0)),
            abi.encodeWithSelector(IIndicoLedger.InvalidParticipant.selector, address(ledger))
        );
    }

    /// @dev Both conflicts at once: the wallet's own link is checked first.
    function test_order_walletLinkedBeforeAccountLinked() public {
        _set(w1, true, R1);
        _set(w2, true, R2);
        _revertsUnchanged(
            admin,
            _call(w1, true, R2),
            abi.encodeWithSelector(IIndicoLedger.WalletAlreadyLinked.selector, w1, R1)
        );
    }

    function test_nonAdmin_reverts() public {
        address[3] memory who = [alice, guardian, merchantA];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            (bool ok,) = address(ledger).call(_call(w1, true, R1));
            assertFalse(ok, "non-admin approved");
        }
        _assertUnlinked(w1);
        assertEq(ledger.walletOfAccount(R1), address(0), "account linked");
    }

    // ================================================================== property

    /// @dev Any fresh wallet and any non-zero reference: exactly the four writes of a first
    ///      approval, and both links readable.
    function testFuzz_firstApproval_anyWalletAndRef_exactWrites(address wallet, bytes32 ref)
        public
    {
        wallet = _remapForgeAddress(wallet);
        if (
            wallet == address(0) || wallet == address(ledger) || wallet == address(usdc)
                || ledger.participantRole(wallet) != 0
        ) wallet = makeAddr("remapped-wallet");
        // Remapped, never discarded: zero, or a reference the fixture already linked (the
        // fuzzer harvests values from state).
        if (ref == bytes32(0) || ledger.walletOfAccount(ref) != address(0)) {
            ref = keccak256("remapped-ref");
        }
        _startDiff();
        _set(wallet, true, ref);
        Write[] memory w = new Write[](4);
        w[0] = _flagWrite(wallet, true);
        w[1] = _w(address(ledger), _key(wallet, SLOT_PARTICIPANT_ROLE), ROLE_USER);
        w[2] = _w(address(ledger), _key(wallet, SLOT_ACCOUNT_REF_OF), uint256(ref));
        w[3] = _w(address(ledger), _key(ref, SLOT_WALLET_OF_ACCOUNT), uint256(uint160(wallet)));
        _assertWrites(w);
        _assertLinked(wallet, ref);
    }

    /// @dev Any sequence of approvals and revokes over three wallets and three references, valid
    ///      or not: every link stays one-to-one, both directions agree, and a link never changes
    ///      once made.
    function testFuzz_linkStaysOneToOne(uint256 seed) public {
        address[3] memory ws = [w1, w2, makeAddr("wallet-3")];
        bytes32[3] memory rs = [R1, R2, keccak256("account-3")];
        bytes32[3] memory first;
        for (uint256 step; step < 12; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            address wallet = ws[r % 3];
            bytes32 ref = rs[(r >> 8) % 3];
            bool approved = (r >> 16) % 3 != 0;
            if ((r >> 24) % 5 == 0) ref = ledger.accountRefOf(wallet); // sometimes the right one
            vm.prank(admin);
            (bool ok,) = address(ledger).call(_call(wallet, approved, ref));
            ok;
            for (uint256 i; i < 3; ++i) {
                bytes32 linked = ledger.accountRefOf(ws[i]);
                if (linked != bytes32(0)) {
                    assertEq(ledger.walletOfAccount(linked), ws[i], "directions disagree");
                    if (first[i] == bytes32(0)) first[i] = linked;
                    assertEq(linked, first[i], "a link changed");
                }
                address back = ledger.walletOfAccount(rs[i]);
                if (back != address(0)) assertEq(ledger.accountRefOf(back), rs[i], "not 1:1");
            }
        }
    }
}
