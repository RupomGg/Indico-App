// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {FixtureBase} from "./Fixture.sol";
import {LIQUIDATION_GRACE} from "../../src/lib/Constants.sol";

/// @notice Two ways to prove what a call changed.
///
/// State diff (D-43), used by every revert helper and every fuzz test:
///
///     _revertsUnchanged(alice, abi.encodeCall(IIndicoLedger.spend, (m, x)), expectedError);
///     _startDiff(); ledger.spend(...); _assertWrites(expectedNetWrites);
///
/// `_assertNoChange` fails on any storage write that survived, on any account, any ETH moved, or
/// any contract created. `_assertWrites` fails unless the net changed slots (ledger, USDC, any
/// account) are exactly the expected ones with exactly the expected values. A slot written and
/// restored within the call (the reentrancy guard's lock) is not a net change.
///
/// Value snapshot, kept for non-fuzz success tests, where it runs once:
///
///     Snapshot memory s = _snapshot(); ...; s.credit[i] += x; _assertUnchanged(s);
abstract contract StateSnapshot is FixtureBase {
    struct Write {
        address account;
        bytes32 slot;
        bytes32 value;
    }

    /// @dev Slot of `mapping[k]` for a mapping at `slot`.
    function _key(address k, uint256 slot) internal pure returns (bytes32) {
        return keccak256(abi.encode(k, slot));
    }

    function _key(bytes32 k, uint256 slot) internal pure returns (bytes32) {
        return keccak256(abi.encode(k, slot));
    }

    function _w(address account, bytes32 slot, uint256 value) internal pure returns (Write memory) {
        return Write(account, slot, bytes32(value));
    }

    /// @dev `who` calls the ledger with `data`; the call must revert with exactly `err` and leave
    ///      no state change. A low-level call, never `vm.expectRevert`: under `expectRevert`,
    ///      Forge 1.8.3's state diff reports the reverted frame as not reverted, so a write made
    ///      before the revert (undone by the EVM) would look like a change (D-43). That is a false
    ///      alarm, never a false pass, but it is why this helper exists.
    function _revertsUnchanged(address who, bytes memory data, bytes memory err) internal {
        _startDiff();
        vm.prank(who);
        (bool ok, bytes memory ret) = address(ledger).call(data);
        assertFalse(ok, "did not revert");
        assertEq(ret, err, "wrong revert");
        _assertNoChange();
    }

    function _startDiff() internal {
        vm.startStateDiffRecording();
    }

    /// @dev Stops recording. Returns the net storage changes (first value before, last value
    ///      written, writes in reverted frames dropped, unchanged slots dropped), and whether any
    ///      ETH moved or any account was created or destroyed outside a reverted frame.
    function _stopDiff() internal returns (Write[] memory net, bool other) {
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        uint256 n;
        for (uint256 i; i < acc.length; ++i) {
            n += acc[i].storageAccesses.length;
        }
        Write[] memory last = new Write[](n);
        bytes32[] memory first = new bytes32[](n);
        uint256 m;
        for (uint256 i; i < acc.length; ++i) {
            VmSafe.AccountAccess memory a = acc[i];
            if (!a.reverted) {
                if (a.oldBalance != a.newBalance) other = true;
                if (
                    a.kind == VmSafe.AccountAccessKind.Create
                        || a.kind == VmSafe.AccountAccessKind.SelfDestruct
                ) other = true;
            }
            for (uint256 j; j < a.storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory sa = a.storageAccesses[j];
                if (!sa.isWrite || sa.reverted || a.reverted) continue;
                uint256 k;
                while (k < m && (last[k].account != sa.account || last[k].slot != sa.slot)) ++k;
                if (k == m) {
                    first[m] = sa.previousValue;
                    ++m;
                }
                last[k] = Write(sa.account, sa.slot, sa.newValue);
            }
        }
        uint256 changed;
        for (uint256 k; k < m; ++k) {
            if (last[k].value != first[k]) last[changed++] = last[k];
        }
        net = new Write[](changed);
        for (uint256 k; k < changed; ++k) {
            net[k] = last[k];
        }
    }

    function _assertNoChange() internal {
        (Write[] memory net, bool other) = _stopDiff();
        if (net.length > 0) {
            fail(string.concat("state changed: ", _describe(net[0])));
        }
        assertFalse(other, "ETH moved or an account was created");
    }

    function _assertWrites(Write[] memory expected) internal {
        (Write[] memory net, bool other) = _stopDiff();
        assertFalse(other, "ETH moved or an account was created");
        for (uint256 i; i < net.length; ++i) {
            bool found;
            for (uint256 j; j < expected.length; ++j) {
                if (expected[j].account == net[i].account && expected[j].slot == net[i].slot) {
                    assertEq(net[i].value, expected[j].value, _describe(net[i]));
                    found = true;
                }
            }
            if (!found) fail(string.concat("unexpected write: ", _describe(net[i])));
        }
        assertEq(net.length, expected.length, "fewer slots written than expected");
    }

    function _describe(Write memory w) private pure returns (string memory) {
        return string.concat(
            vm.toString(w.account), " slot ", vm.toString(w.slot), " = ", vm.toString(w.value)
        );
    }

    struct Snapshot {
        address[] who;
        uint256[] credit;
        uint256[] lockedCredit;
        uint256[] usdc;
        uint256[] shares;
        bool[] approvedUser;
        bool[] approvedMerchant;
        uint8[] participantRole;
        bool[] termsSigned;
        bytes32[] signedTermsHash;
        bytes32[] accountRef;
        uint256 totalLent;
        uint256 poolUsdc;
        uint256 totalCredit;
        uint256 totalShares;
        uint256 poolCredit;
        uint256 ledgerUsdc;
        uint256 nextLoanId;
        bytes32 termsHash;
        bool paused;
        uint64 lastPausedAt;
        uint64 lastUnpausedAt;
        /// @dev keccak of every stored loan, so any change to any loan field shows up.
        bytes32 loansHash;
    }

    function _snapshot() internal view returns (Snapshot memory s) {
        uint256 n = actors.length;
        s.who = actors;
        s.credit = new uint256[](n);
        s.lockedCredit = new uint256[](n);
        s.usdc = new uint256[](n);
        s.shares = new uint256[](n);
        s.approvedUser = new bool[](n);
        s.approvedMerchant = new bool[](n);
        s.participantRole = new uint8[](n);
        s.termsSigned = new bool[](n);
        s.signedTermsHash = new bytes32[](n);
        s.accountRef = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            address a = actors[i];
            s.credit[i] = ledger.credit(a);
            s.lockedCredit[i] = ledger.lockedCredit(a);
            s.usdc[i] = usdc.balanceOf(a);
            s.shares[i] = ledger.shares(a);
            s.approvedUser[i] = ledger.approvedUser(a);
            s.approvedMerchant[i] = ledger.approvedMerchant(a);
            s.participantRole[i] = ledger.participantRole(a);
            s.termsSigned[i] = ledger.termsSigned(a);
            s.signedTermsHash[i] = ledger.signedTermsHash(a);
            s.accountRef[i] = ledger.accountRefOf(a);
        }
        s.totalLent = ledger.totalLent();
        s.poolUsdc = ledger.poolUsdc();
        s.totalCredit = ledger.totalCredit();
        s.totalShares = ledger.totalShares();
        s.poolCredit = ledger.poolCredit();
        s.ledgerUsdc = usdc.balanceOf(address(ledger));
        s.nextLoanId = ledger.nextLoanId();
        s.termsHash = ledger.termsHash();
        s.paused = Pausable(address(ledger)).paused();
        s.lastPausedAt = ledger.lastPausedAt();
        s.lastUnpausedAt = ledger.lastUnpausedAt();
        s.loansHash = _loansHash(s.nextLoanId);
    }

    function _assertUnchanged(Snapshot memory before) internal view {
        Snapshot memory s = _snapshot();
        assertEq(s.who, before.who, "actor set");
        assertEq(s.credit, before.credit, "credit");
        assertEq(s.lockedCredit, before.lockedCredit, "lockedCredit");
        assertEq(s.usdc, before.usdc, "usdc balances");
        assertEq(s.shares, before.shares, "shares");
        assertEq(s.approvedUser, before.approvedUser, "approvedUser");
        assertEq(s.approvedMerchant, before.approvedMerchant, "approvedMerchant");
        _assertEqU8(s.participantRole, before.participantRole, "participantRole");
        assertEq(s.termsSigned, before.termsSigned, "termsSigned");
        assertEq(s.signedTermsHash, before.signedTermsHash, "signedTermsHash");
        assertEq(s.accountRef, before.accountRef, "accountRef");
        assertEq(s.totalLent, before.totalLent, "totalLent");
        assertEq(s.poolUsdc, before.poolUsdc, "poolUsdc");
        assertEq(s.totalCredit, before.totalCredit, "totalCredit");
        assertEq(s.totalShares, before.totalShares, "totalShares");
        assertEq(s.poolCredit, before.poolCredit, "poolCredit");
        assertEq(s.ledgerUsdc, before.ledgerUsdc, "ledger usdc");
        assertEq(s.nextLoanId, before.nextLoanId, "nextLoanId");
        assertEq(s.termsHash, before.termsHash, "termsHash");
        assertEq(s.paused, before.paused, "paused");
        assertEq(s.lastPausedAt, before.lastPausedAt, "lastPausedAt");
        assertEq(s.lastUnpausedAt, before.lastUnpausedAt, "lastUnpausedAt");
        assertEq(s.loansHash, before.loansHash, "loans");
    }

    /// @dev Expected pause timestamps after a successful `pause` (D-58: a pause starting inside
    ///      the previous grace keeps the earlier start) or `unpause`, at the current time.
    function _expectPaused(Snapshot memory s) internal view {
        s.paused = true;
        if (block.timestamp > uint256(s.lastUnpausedAt) + LIQUIDATION_GRACE) {
            s.lastPausedAt = uint64(block.timestamp);
        }
    }

    function _expectUnpaused(Snapshot memory s) internal view {
        s.paused = false;
        s.lastUnpausedAt = uint64(block.timestamp);
    }

    function _assertEqU8(uint8[] memory a, uint8[] memory b, string memory what) private pure {
        assertEq(a.length, b.length, what);
        for (uint256 i; i < a.length; ++i) {
            assertEq(a[i], b[i], what);
        }
    }

    /// @dev Hashes loan ids `0..end` inclusive, so a phantom write one past the end is caught.
    function _loansHash(uint256 end) private view returns (bytes32 h) {
        for (uint256 id; id <= end; ++id) {
            (address b, uint64 due, uint16 n, uint8 st, uint128 p, uint128 c) = ledger.loans(id);
            h = keccak256(abi.encode(h, b, due, n, st, p, c));
        }
    }
}
