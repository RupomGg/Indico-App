// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Fixture, FixtureBase} from "./Fixture.sol";
import {ROLE_USER, ROLE_MERCHANT} from "../../src/lib/Constants.sol";

/// @notice Self-check for the full onboarding `Fixture`, which first runs in P1.3.
contract FixtureTest is Fixture {
    function test_termsHashIsTerms() public view {
        assertEq(ledger.termsHash(), TERMS);
    }

    function test_usersApprovedAndSigned() public view {
        address[2] memory u = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            assertTrue(ledger.approvedUser(u[i]), "approved");
            assertFalse(ledger.approvedMerchant(u[i]), "not merchant");
            assertTrue(ledger.termsSigned(u[i]), "signed");
            assertEq(ledger.signedTermsHash(u[i]), TERMS);
            assertEq(ledger.participantRole(u[i]), ROLE_USER);
        }
    }

    function test_merchantsApprovedAndSigned() public view {
        address[2] memory m = [merchantA, merchantB];
        for (uint256 i; i < 2; ++i) {
            assertTrue(ledger.approvedMerchant(m[i]), "approved");
            assertFalse(ledger.approvedUser(m[i]), "not user");
            assertTrue(ledger.termsSigned(m[i]), "signed");
            assertEq(ledger.signedTermsHash(m[i]), TERMS);
            assertEq(ledger.participantRole(m[i]), ROLE_MERCHANT);
        }
    }

    function test_adminAndGuardianNotOnboarded() public view {
        address[2] memory a = [admin, guardian];
        for (uint256 i; i < 2; ++i) {
            assertFalse(ledger.approvedUser(a[i]));
            assertFalse(ledger.approvedMerchant(a[i]));
            assertFalse(ledger.termsSigned(a[i]));
        }
    }

    function test_actorsStillTheSixNamed_eachFunded() public view {
        assertEq(actors.length, 6);
        for (uint256 i; i < actors.length; ++i) {
            assertEq(usdc.balanceOf(actors[i]), FUND);
        }
    }
}

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
