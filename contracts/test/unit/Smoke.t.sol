// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {FixtureBase} from "../helpers/Fixture.sol";

/// @notice Failed by design in phase 0, when `src/IndicoLedger.sol` did not exist. Passes from
///         P1.1, the first portion with a ledger. Uses `FixtureBase`, which needs only the
///         constructor.
contract SmokeTest is FixtureBase {
    function test_usdcIsTheMock() public view {
        assertEq(address(ledger.usdc()), address(usdc));
    }
}
