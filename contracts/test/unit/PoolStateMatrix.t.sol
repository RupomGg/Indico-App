// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice The pool-state matrix, docs/input-testing.md 2.4 (O-034): 6 pool states x {deposit,
///         withdraw, requestLoan, repay} = 24 cells, every one asserted, on real loans and a real
///         default (`Actors._poolInState`). merchantA holds the pool's shares; alice (and in the
///         default states bob) borrowed; a fresh approved user asks for the new loan.
///
/// | State                 | deposit(1e6) | withdraw(1e6)                | requestLoan(1e6)        | repay                |
/// |-----------------------|--------------|------------------------------|-------------------------|----------------------|
/// | Empty                 | ok           | InsufficientShares(1e12, 0)  | InsufficientLiquidity(1e6, 0) | LoanNotFound (id 1) |
/// | HasDepositsNoneLent   | ok           | ok                           | ok                      | LoanNotFound (id 1)  |
/// | PartiallyLent         | ok           | ok                           | ok                      | ok (the Active loan) |
/// | FullyLent             | ok           | InsufficientLiquidity(1e6, 0)| InsufficientLiquidity(1e6, 0) | ok (the Active loan) |
/// | LentWithADefault      | ok           | ok                           | ok                      | ok (alice's loan)    |
/// | AllRepaidAfterDefault | ok           | ok                           | ok                      | LoanNotActive (id 1) |
/// FullyLent x withdraw is a named InsufficientLiquidity, never a panic (IT 2.4). Every success:
/// exact USDC, share and book movements, and `usdc.balanceOf(ledger) >= poolUsdc`.
contract PoolStateMatrixTest is Actors {
    uint256 internal constant AMOUNT = 1e6;
    uint64 internal constant START = 1_800_000_000;

    function test_poolStateMatrix_everyCell() public {
        _crossProduct(_dims(POOL_STATES, 4), _cell);
    }

    function _cell(uint256[] memory c) internal {
        vm.warp(START);
        PoolState ps = PoolState(c[0]);
        uint256 active = _poolInState(ps);
        uint256 cash = ledger.poolUsdc();
        uint256 lent = ledger.totalLent();

        if (c[1] == 0) {
            uint256 minted = _modelSharesFor(AMOUNT);
            uint256 before = ledger.shares(merchantA);
            _deposit(merchantA, AMOUNT);
            assertEq(ledger.shares(merchantA), before + minted, "shares minted");
            assertEq(ledger.poolUsdc(), cash + AMOUNT, "poolUsdc");
        } else if (c[1] == 1) {
            uint256 needed = _modelSharesToBurn(AMOUNT);
            uint256 held = ledger.shares(merchantA);
            bytes memory data = abi.encodeCall(IIndicoLedger.withdraw, (AMOUNT));
            if (ps == PoolState.Empty) {
                return _revertsUnchanged(
                    merchantA,
                    data,
                    abi.encodeWithSelector(IIndicoLedger.InsufficientShares.selector, needed, 0)
                );
            }
            if (ps == PoolState.FullyLent) {
                return _revertsUnchanged(
                    merchantA,
                    data,
                    abi.encodeWithSelector(IIndicoLedger.InsufficientLiquidity.selector, AMOUNT, 0)
                );
            }
            uint256 usdcBefore = usdc.balanceOf(merchantA);
            vm.prank(merchantA);
            ledger.withdraw(AMOUNT);
            assertEq(usdc.balanceOf(merchantA), usdcBefore + AMOUNT, "paid");
            assertEq(ledger.shares(merchantA), held - needed, "burned");
            assertEq(ledger.poolUsdc(), cash - AMOUNT, "poolUsdc");
        } else if (c[1] == 2) {
            address carol = _participant(Participant.ApprovedAndSigned);
            _mintCredit(carol, _collateralFor(AMOUNT));
            bytes memory data = abi.encodeCall(IIndicoLedger.requestLoan, (AMOUNT));
            if (ps == PoolState.Empty || ps == PoolState.FullyLent) {
                return _revertsUnchanged(
                    carol,
                    data,
                    abi.encodeWithSelector(IIndicoLedger.InsufficientLiquidity.selector, AMOUNT, 0)
                );
            }
            vm.prank(carol);
            ledger.requestLoan(AMOUNT);
            assertEq(ledger.poolUsdc(), cash - AMOUNT, "poolUsdc");
            assertEq(ledger.totalLent(), lent + AMOUNT, "totalLent");
        } else {
            if (active == NO_LOAN) {
                bytes4 sel = ps == PoolState.AllRepaidAfterDefault
                    ? IIndicoLedger.LoanNotActive.selector
                    : IIndicoLedger.LoanNotFound.selector;
                return _revertsUnchanged(
                    alice, abi.encodeCall(IIndicoLedger.repay, (1)), abi.encodeWithSelector(sel)
                );
            }
            (,,,, uint128 p,) = ledger.loans(active);
            vm.prank(alice);
            ledger.repay(active);
            assertEq(ledger.poolUsdc(), cash + p, "poolUsdc");
            assertEq(ledger.totalLent(), lent - p, "totalLent");
        }
        assertGe(usdc.balanceOf(address(ledger)), ledger.poolUsdc(), "books");
    }
}
