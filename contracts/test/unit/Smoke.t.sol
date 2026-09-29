// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Fixture} from "../helpers/Fixture.sol";

/// @notice Deliberately failing at the end of phase 0: `src/IndicoLedger.sol` does not exist
///         yet, so this does not compile. Phase 1 makes it pass.
contract SmokeTest is Fixture {
    function test_usdcIsTheMock() public view {
        assertEq(address(ledger.usdc()), address(usdc));
    }
}
