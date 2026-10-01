// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {FixtureBase} from "./Fixture.sol";

/// @notice Self-check for `FixtureBase`: a deployed ledger and funded actors, and nothing that
///         needs a later portion. Onboarding (terms, approvals, signatures) is `Fixture`'s job.
contract FixtureBaseTest is FixtureBase {
    function test_deploysLedgerOnTheMock() public view {
        assertEq(address(ledger.usdc()), address(usdc));
    }

    function test_actorsAreTheSixNamed_inOrder() public view {
        assertEq(actors.length, 6);
        assertEq(actors[0], admin);
        assertEq(actors[1], guardian);
        assertEq(actors[2], alice);
        assertEq(actors[3], bob);
        assertEq(actors[4], merchantA);
        assertEq(actors[5], merchantB);
    }

    function test_everyActorFundedAndApprovedTheLedger() public view {
        for (uint256 i; i < actors.length; ++i) {
            assertEq(usdc.balanceOf(actors[i]), FUND, "funded");
            assertEq(usdc.allowance(actors[i], address(ledger)), type(uint256).max, "allowance");
        }
    }

    function test_noOnboarding() public view {
        assertEq(ledger.termsHash(), bytes32(0), "terms hash");
        for (uint256 i; i < actors.length; ++i) {
            assertFalse(ledger.approvedUser(actors[i]), "approved user");
            assertFalse(ledger.approvedMerchant(actors[i]), "approved merchant");
            assertFalse(ledger.termsSigned(actors[i]), "signed");
        }
    }
}
