// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {TERM, EXTENSION_WINDOW} from "../../src/lib/Constants.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice The loan state matrix, docs/input-testing.md 2.1: 4 states x {repay, extend,
///         liquidate} x {borrower, another user, admin} x 5 moments = 180 cells, every one
///         asserted, on real loans. No pause happens, so no grace applies (D-54).
///
/// | State       | repay                    | extend                                    | liquidate                 |
/// |-------------|--------------------------|-------------------------------------------|---------------------------|
/// | NonExistent | LoanNotFound             | LoanNotFound                              | LoanNotFound              |
/// | Active      | borrower: ok, any time   | others: NotBorrower; borrower: before the | any caller (D-56): at or  |
/// |             | (D-09); others:          | window NotOpen(d - 30 days), window opens | before due NotYetDue(d);  |
/// |             | NotBorrower              | to due ok, after due Closed               | one second after: ok      |
/// | Repaid      | LoanNotActive            | LoanNotActive                             | LoanNotActive             |
/// | Defaulted   | LoanNotActive            | LoanNotActive                             | LoanNotActive             |
/// Moments, against the loan's due date d (`_loanTimeAt`): d - 30 days - 1, d - 30 days,
/// d - 15 days, d, d + 1. A NonExistent loan is timed against now + TERM.
/// Every revert: `_revertsUnchanged`. Every success: the action's effects, and after a
/// liquidation credit >= lockedCredit for every actor.
contract LoanMatrixTest is Actors {
    uint256 internal constant P = 1e6;
    uint64 internal constant START = 1_800_000_000;

    uint8 internal constant OK = 0;
    uint8 internal constant NOT_FOUND = 1;
    uint8 internal constant NOT_ACTIVE = 2;
    uint8 internal constant NOT_BORROWER = 3;
    uint8 internal constant NOT_OPEN = 4;
    uint8 internal constant CLOSED = 5;
    uint8 internal constant NOT_YET_DUE = 6;

    function test_loanMatrix_everyCell() public {
        _crossProduct(_loanDims(), _cell);
    }

    /// @dev The table above, as code: c[0] state, c[1] action, c[2] caller, c[3] moment.
    function _expected(uint256[] memory c) internal pure returns (uint8) {
        LoanState s = LoanState(c[0]);
        if (s == LoanState.NonExistent) return NOT_FOUND;
        if (s != LoanState.Active) return NOT_ACTIVE;
        if (c[1] == 0) return c[2] == 0 ? OK : NOT_BORROWER;
        if (c[1] == 1) {
            if (c[2] != 0) return NOT_BORROWER;
            if (c[3] == 0) return NOT_OPEN;
            return c[3] == 4 ? CLOSED : OK;
        }
        return c[3] == 4 ? OK : NOT_YET_DUE;
    }

    function _cell(uint256[] memory c) internal {
        vm.warp(START);
        uint256 id = _loanInState(LoanState(c[0]), P);
        uint64 due = START + TERM;
        if (LoanState(c[0]) != LoanState.NonExistent) (, due,,,,) = ledger.loans(id);
        vm.warp(_loanTimeAt(c[3], due));

        address who = c[2] == 0 ? alice : c[2] == 1 ? bob : admin;
        bytes memory data = c[1] == 0
            ? abi.encodeCall(IIndicoLedger.repay, (id))
            : c[1] == 1
                ? abi.encodeCall(IIndicoLedger.extend, (id))
                : abi.encodeCall(IIndicoLedger.liquidate, (id));
        uint8 e = _expected(c);

        if (e != OK) return _revertsUnchanged(who, data, _error(e, due));

        vm.prank(who);
        (bool ok,) = address(ledger).call(data);
        assertTrue(ok, "expected success");
        (, uint64 d, uint16 n, uint8 st,,) = ledger.loans(id);
        if (c[1] == 0) {
            assertEq(st, uint8(IIndicoLedger.LoanStatus.Repaid), "repaid");
            assertEq(ledger.lockedCredit(alice), 0, "released");
            assertEq(ledger.totalLent(), 0, "lent");
        } else if (c[1] == 1) {
            assertEq(d, due + TERM, "extended from the due date");
            assertEq(n, 1, "count");
        } else {
            assertEq(st, uint8(IIndicoLedger.LoanStatus.Defaulted), "defaulted");
            assertEq(ledger.poolCredit(), _collateralFor(P), "collateral to the pool");
            for (uint256 i; i < actors.length; ++i) {
                assertGe(
                    ledger.credit(actors[i]), ledger.lockedCredit(actors[i]), "credit < locked"
                );
            }
        }
    }

    function _error(uint8 e, uint64 due) internal pure returns (bytes memory) {
        if (e == NOT_FOUND) return abi.encodeWithSelector(IIndicoLedger.LoanNotFound.selector);
        if (e == NOT_ACTIVE) return abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector);
        if (e == NOT_BORROWER) return abi.encodeWithSelector(IIndicoLedger.NotBorrower.selector);
        if (e == NOT_OPEN) {
            return abi.encodeWithSelector(
                IIndicoLedger.ExtensionWindowNotOpen.selector, due - EXTENSION_WINDOW
            );
        }
        if (e == CLOSED) {
            return abi.encodeWithSelector(IIndicoLedger.ExtensionWindowClosed.selector);
        }
        return abi.encodeWithSelector(IIndicoLedger.NotYetDue.selector, due);
    }

    /// @dev The table's own size: 4 x 3 x 3 x 5.
    function test_loanMatrix_is180Cells() public pure {
        uint256[] memory d = _loanDims();
        assertEq(d[0] * d[1] * d[2] * d[3], 180);
    }
}
