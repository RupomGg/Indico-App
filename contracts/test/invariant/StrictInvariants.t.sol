// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {InvariantsBase} from "./Invariants.t.sol";
import {Handler} from "./Handler.sol";
import {StrictHandler} from "./StrictHandler.sol";

/// @notice Strict suite (P2.2, TS 2.3): the handler only makes calls the rules say must succeed,
///         and any revert fails the run, so a valid call wrongly refused is caught. The same rules
///         as the permissive suite are checked after every call.
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: ci.invariant.fail-on-revert = true
/// forge-config: deep.invariant.fail-on-revert = true
contract StrictInvariantsTest is InvariantsBase {
    function _deployHandler() internal override returns (Handler) {
        StrictHandler s = new StrictHandler(ledger, usdc, admin, guardian);
        bytes4[] memory sel = new bytes4[](19);
        sel[0] = s.s_registerAsset.selector;
        sel[1] = s.s_adminIssue.selector;
        sel[2] = s.s_adminDebit.selector;
        sel[3] = s.s_spend.selector;
        sel[4] = s.s_deposit.selector;
        sel[5] = s.s_withdraw.selector;
        sel[6] = s.s_withdrawAll.selector;
        sel[7] = s.s_requestLoan.selector;
        sel[8] = s.s_repay.selector;
        sel[9] = s.s_extend.selector;
        sel[10] = s.s_liquidate.selector;
        sel[11] = s.s_setUser.selector;
        sel[12] = s.s_setMerchant.selector;
        sel[13] = s.s_newTermsVersion.selector;
        sel[14] = s.s_signTerms.selector;
        sel[15] = s.s_moveAccount.selector;
        sel[16] = s.s_togglePause.selector;
        sel[17] = s.warp.selector;
        sel[18] = s.warpToEdge.selector;
        targetSelector(FuzzSelector({addr: address(s), selectors: sel}));
        selectors = sel;
        return s;
    }

    bytes4[] internal selectors;

    /// @dev Reachability: 4,000 seeded random strict actions; none may revert, and every action
    ///      that calls the ledger must have made at least one call (a strict action that always
    ///      skips would prove nothing). The last two selectors, the warps, never call the ledger.
    function test_everyStrictActionMakesValidCalls() public {
        uint256 seed = 1;
        for (uint256 k; k < 4000; k++) {
            seed = uint256(keccak256(abi.encode(seed)));
            bytes4 f = selectors[seed % selectors.length];
            (bool ok, bytes memory ret) = address(h)
                .call(
                    abi.encodeWithSelector(
                        f,
                        uint256(keccak256(abi.encode(seed, 1))),
                        uint256(keccak256(abi.encode(seed, 2))),
                        uint256(keccak256(abi.encode(seed, 3)))
                    )
                );
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        for (uint256 i; i < selectors.length - 2; i++) {
            assertGt(h.made(selectors[i]), 0, vm.toString(abi.encodePacked(selectors[i])));
        }
    }
}
