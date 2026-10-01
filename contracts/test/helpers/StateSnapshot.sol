// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {FixtureBase} from "./Fixture.sol";

/// @notice Every observable value in one struct. A revert test is two lines:
///
///     Snapshot memory s = _snapshot();
///     vm.expectRevert(...); ledger.spend(...);
///     _assertUnchanged(s);
abstract contract StateSnapshot is FixtureBase {
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
        uint256 totalLent;
        uint256 totalCredit;
        uint256 totalShares;
        uint256 poolCredit;
        uint256 ledgerUsdc;
        uint256 nextLoanId;
        bytes32 termsHash;
        bool paused;
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
        }
        s.totalLent = ledger.totalLent();
        s.totalCredit = ledger.totalCredit();
        s.totalShares = ledger.totalShares();
        s.poolCredit = ledger.poolCredit();
        s.ledgerUsdc = usdc.balanceOf(address(ledger));
        s.nextLoanId = ledger.nextLoanId();
        s.termsHash = ledger.termsHash();
        s.paused = Pausable(address(ledger)).paused();
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
        assertEq(s.totalLent, before.totalLent, "totalLent");
        assertEq(s.totalCredit, before.totalCredit, "totalCredit");
        assertEq(s.totalShares, before.totalShares, "totalShares");
        assertEq(s.poolCredit, before.poolCredit, "poolCredit");
        assertEq(s.ledgerUsdc, before.ledgerUsdc, "ledger usdc");
        assertEq(s.nextLoanId, before.nextLoanId, "nextLoanId");
        assertEq(s.termsHash, before.termsHash, "termsHash");
        assertEq(s.paused, before.paused, "paused");
        assertEq(s.loansHash, before.loansHash, "loans");
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
