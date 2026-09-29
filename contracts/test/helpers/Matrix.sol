// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @notice Table-driven cross products. Every cell runs from the same starting state:
///         the chain is snapshotted before a cell and reverted after it.
///
///     function test_loanMatrix() public { _crossProduct(_dims(4, 3, 3, 3), _loanCell); }
///     function _loanCell(uint256[] memory c) internal { ... c[0] state, c[1] action ... }
abstract contract Matrix is Test {
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
