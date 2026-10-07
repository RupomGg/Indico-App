// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {EXTENSION_WINDOW} from "../../src/lib/Constants.sol";

/// @notice Table-driven cross products. Every cell runs from the same starting state:
///         the chain is snapshotted before a cell and reverted after it.
///
///     function test_loanMatrix() public { _crossProduct(_loanDims(), _loanCell); }
///     function _loanCell(uint256[] memory c) internal {
///         ... c[0] state, c[1] action, c[2] caller, vm.warp(_loanTimeAt(c[3], dueDate)) ...
///     }
abstract contract Matrix is Test {
    error LoanTimeOutOfRange(uint256 t);
    error DueDateBeforeWindow(uint64 dueDate);

    /// @dev Loan states of the loan matrix (`Actors.LoanState`), docs/input-testing.md 2.1.
    uint256 internal constant LOAN_STATES = 4;
    /// @dev Time axis of the loan matrix, docs/input-testing.md 2.1.
    uint256 internal constant LOAN_TIMES = 5;

    /// @dev Loan matrix: 4 states x 3 actions x 3 callers x 5 times = 180 cells.
    function _loanDims() internal pure returns (uint256[] memory) {
        return _dims(LOAN_STATES, 3, 3, LOAN_TIMES);
    }

    /// @notice The five moments the loan matrix tests, around the D-13 extension window:
    ///         0 one second before the window, 1 window opens, 2 middle of the window,
    ///         3 exactly due, 4 one second after due.
    /// @dev Returns uint256, so `dueDate + 1` cannot overflow: the largest result is 2**64.
    ///      A due date inside the first window has no "before the window" moment and reverts.
    function _loanTimeAt(uint256 t, uint64 dueDate) internal pure returns (uint256) {
        if (t >= LOAN_TIMES) revert LoanTimeOutOfRange(t);
        if (dueDate <= EXTENSION_WINDOW) revert DueDateBeforeWindow(dueDate);
        uint256 due = dueDate;
        if (t == 0) return due - EXTENSION_WINDOW - 1;
        if (t == 1) return due - EXTENSION_WINDOW;
        if (t == 2) return due - EXTENSION_WINDOW / 2;
        if (t == 3) return due;
        return due + 1;
    }

    /// @dev Calls `cell` once for every combination of indices `i[k] < dims[k]`.
    function _crossProduct(uint256[] memory dims, function(uint256[] memory) internal cell)
        internal
    {
        for (uint256 k; k < dims.length; ++k) {
            require(dims[k] > 0, "empty dimension");
        }
        uint256[] memory idx = new uint256[](dims.length);
        while (true) {
            uint256 snap = vm.snapshotState();
            cell(_copy(idx));
            vm.revertToState(snap);

            uint256 k;
            for (; k < dims.length; ++k) {
                if (++idx[k] < dims[k]) break;
                idx[k] = 0;
            }
            if (k == dims.length) return;
        }
    }

    function _dims(uint256 a, uint256 b) internal pure returns (uint256[] memory d) {
        d = new uint256[](2);
        (d[0], d[1]) = (a, b);
    }

    function _dims(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory d) {
        d = new uint256[](3);
        (d[0], d[1], d[2]) = (a, b, c);
    }

    function _dims(uint256 a, uint256 b, uint256 c, uint256 e)
        internal
        pure
        returns (uint256[] memory d)
    {
        d = new uint256[](4);
        (d[0], d[1], d[2], d[3]) = (a, b, c, e);
    }

    function _copy(uint256[] memory a) private pure returns (uint256[] memory b) {
        b = new uint256[](a.length);
        for (uint256 i; i < a.length; ++i) {
            b[i] = a[i];
        }
    }
}
