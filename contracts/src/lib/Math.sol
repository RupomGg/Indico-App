// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Math as OZMath} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Math
/// @notice Integer maths with explicit rounding. Rounding always favours the pool:
///         collateral rounds up (`ceilDiv`), payouts and share conversions round down
///         (`mulDivDown`).
/// @dev Every failure is a named revert, never a panic.
library Math {
    error DivisionByZero();
    error MathOverflow();

    /// @notice `a / b`, rounded up.
    /// @dev `(a - 1) / b + 1` cannot overflow for any `a`, unlike `(a + b - 1) / b`.
    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        if (b == 0) revert DivisionByZero();
        if (a == 0) return 0;
        unchecked {
            return (a - 1) / b + 1;
        }
    }

    /// @notice `x * y / d`, rounded down, with a full 512-bit intermediate product.
    /// @dev Reverts `MathOverflow` when the result does not fit in 256 bits.
    function mulDivDown(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        if (d == 0) revert DivisionByZero();
        // Only the high word matters: the result fits in 256 bits iff high < d.
        // slither-disable-next-line unused-return
        (uint256 high,) = OZMath.mul512(x, y);
        if (high >= d) revert MathOverflow();
        return OZMath.mulDiv(x, y, d);
    }
}
