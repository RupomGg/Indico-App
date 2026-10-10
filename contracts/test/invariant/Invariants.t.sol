// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Fixture} from "../helpers/Fixture.sol";
import {Handler} from "./Handler.sol";
import {CREDIT_CAP, ROLE_USER, ROLE_RETIRED, BPS, LTV_BPS} from "../../src/lib/Constants.sol";

/// @notice Permissive invariant suite (P2.1, CS 9, TS 2.3): any sequence of handler actions, valid
///         or refused, and after every call each rule below must hold. One function per rule.
contract InvariantsTest is Fixture {
    Handler internal h;

    function setUp() public override {
        super.setUp();
        h = new Handler(ledger, usdc, admin, guardian);
        targetContract(address(h));
    }

    /// I1: the pool never owes more than it holds plus what is out:
    ///     sum(sharesToAssets(shares[m])) <= poolUsdc + totalLent.
    function invariant_I1_poolCoversClaims() public view {
        uint256 claims;
        for (uint256 i; i < h.trackedCount(); i++) {
            claims += ledger.sharesToAssets(ledger.shares(h.tracked(i)));
        }
        assertLe(claims, ledger.poolUsdc() + ledger.totalLent());
    }

    /// I2: totalLent == sum(principal) over Active loans.
    function invariant_I2_totalLentIsActivePrincipal() public view {
        uint256 sum;
        for (uint256 id = 1; id <= ledger.nextLoanId(); id++) {
            (,,, uint8 status, uint128 principal,) = ledger.loans(id);
            if (status == 0) sum += principal;
        }
        assertEq(ledger.totalLent(), sum);
    }

    /// I3: lockedCredit[a] <= credit[a] for every address.
    function invariant_I3_lockedWithinCredit() public view {
        for (uint256 i; i < h.trackedCount(); i++) {
            address a = h.tracked(i);
            assertLe(ledger.lockedCredit(a), ledger.credit(a));
        }
    }

    /// I4: lockedCredit[u] == sum(collateral) over u's Active loans.
    /// I5: every Active loan locks ceil(principal * BPS / LTV_BPS), computed here independently.
    function invariant_I4_I5_lockedIsActiveCollateral() public view {
        uint256 n = h.trackedCount();
        uint256[] memory locked = new uint256[](n);
        for (uint256 id = 1; id <= ledger.nextLoanId(); id++) {
            (address b,,, uint8 status, uint128 principal, uint128 collateral) = ledger.loans(id);
            if (status != 0) continue;
            assertEq(collateral, (uint256(principal) * BPS + LTV_BPS - 1) / LTV_BPS, "I5");
            for (uint256 i; i < n; i++) {
                if (h.tracked(i) == b) locked[i] += collateral;
            }
        }
        for (uint256 i; i < n; i++) {
            assertEq(ledger.lockedCredit(h.tracked(i)), locked[i], "I4");
        }
    }

    /// I6: totalCredit == sum(credit[a]). I13: sum(credit) + poolCredit == minted - burned.
    function invariant_I6_I13_creditConserved() public view {
        uint256 sum;
        for (uint256 i; i < h.trackedCount(); i++) {
            sum += ledger.credit(h.tracked(i));
        }
        assertEq(ledger.totalCredit(), sum, "I6");
        assertEq(sum + ledger.poolCredit(), h.ghostMinted() - h.ghostBurned(), "I13");
    }

    /// I7: totalShares == sum(shares[m]).
    function invariant_I7_totalSharesIsSum() public view {
        uint256 sum;
        for (uint256 i; i < h.trackedCount(); i++) {
            sum += ledger.shares(h.tracked(i));
        }
        assertEq(ledger.totalShares(), sum);
    }

    /// I8, I9, I10, I11, I12 are checked on every successful call inside the handler: exact credit
    /// deltas (credit moves only by the action's own rule, D-66), spend and debit never below
    /// locked credit, no withdrawal above poolUsdc, and the share-price rules (D-65).
    function invariant_I8_to_I12_perCallRules() public view {
        assertEq(h.violations(), 0, h.firstViolation());
    }

    /// I14: the books balance: usdc.balanceOf(ledger) >= poolUsdc.
    function invariant_I14_booksBalance() public view {
        assertGe(usdc.balanceOf(address(ledger)), ledger.poolUsdc());
    }

    /// L1: the account link is one to one, both directions agreeing.
    function invariant_L1_linkOneToOne() public view {
        for (uint256 i; i < h.trackedCount(); i++) {
            address w = h.tracked(i);
            bytes32 ref = ledger.accountRefOf(w);
            if (ref != 0) assertEq(ledger.walletOfAccount(ref), w, "wallet to account");
        }
        for (uint256 i; i < h.accountCount(); i++) {
            bytes32 ref = h.accountRef(i);
            address w = ledger.walletOfAccount(ref);
            assertEq(w, h.accountWallet(i), "the account's current wallet");
            assertEq(ledger.accountRefOf(w), ref, "account to wallet");
        }
    }

    /// L2: a retired wallet has no credit, no approval and no link.
    function invariant_L2_retiredIsEmpty() public view {
        for (uint256 i; i < h.trackedCount(); i++) {
            address w = h.tracked(i);
            if (ledger.participantRole(w) != ROLE_RETIRED) continue;
            assertEq(ledger.credit(w), 0);
            assertFalse(ledger.approvedUser(w));
            assertEq(ledger.accountRefOf(w), bytes32(0));
        }
    }

    /// C1: every user's credit is at most CREDIT_CAP (D-27, D-33); merchants may exceed it.
    function invariant_C1_usersWithinCap() public view {
        for (uint256 i; i < h.trackedCount(); i++) {
            address w = h.tracked(i);
            if (ledger.participantRole(w) == ROLE_USER) assertLe(ledger.credit(w), CREDIT_CAP);
        }
    }
}
