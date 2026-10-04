// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LedgerMath} from "../../src/lib/Math.sol";
import {BPS, LTV_BPS} from "../../src/lib/Constants.sol";

/// @dev External boundary so reverts can be asserted with `vm.expectRevert` and `try`.
contract MathHarness {
    function ceilDiv(uint256 a, uint256 b) external pure returns (uint256) {
        return LedgerMath.ceilDiv(a, b);
    }

    function mulDivDown(uint256 x, uint256 y, uint256 d) external pure returns (uint256) {
        return LedgerMath.mulDivDown(x, y, d);
    }

    function mulDivUp(uint256 x, uint256 y, uint256 d) external pure returns (uint256) {
        return LedgerMath.mulDivUp(x, y, d);
    }
}

/*
ceilDiv(a, b), partition table (docs/input-testing.md section 1). "Limit" = an exact multiple of b.

| Param | Class                   | Input                              | Expected                  |
|-------|-------------------------|------------------------------------|---------------------------|
| a     | zero                    | (0, 8000)                          | 0                         |
| a     | one wei                 | (1, 8000)                          | 1                         |
| a     | typical                 | (1_000e6 * BPS, LTV_BPS)           | 1_250e6                   |
| a     | exactly the limit       | (40_000, 8000)                     | 5, not rounded up twice   |
| a     | limit plus one wei      | (40_001, 8000)                     | 6                         |
| a     | limit minus one wei     | (39_999, 8000)                     | 5                         |
| a     | uint128 max             | (u128max * BPS, LTV_BPS)           | ceil(u128max * 1.25)      |
| a     | uint256 max             | (u256max, 8000)                    | u256max / 8000 + 1, no panic |
| a     | rounding boundary       | (10_000, 8000), (8_001, 8000)      | 2, 2                      |
| a     | dust above huge limit   | (k * 8000 + 1), k = u256max / 8000 | k + 1                     |
| b     | zero                    | (a, 0), including a = 0            | revert DivisionByZero     |
| b     | one                     | (a, 1)                             | a                         |
| b     | equal to a              | (a, a)                             | 1                         |
| b     | greater than a          | (7, 8)                             | 1                         |
| b     | uint256 max             | (u256max, u256max), (1, u256max)   | 1, 1                      |

mulDivDown(x, y, d), partition table.

| Param | Class                       | Input                          | Expected              |
|-------|-----------------------------|--------------------------------|-----------------------|
| x,y   | zero                        | (0, 5, 3), (5, 0, 3)           | 0                     |
| x,y   | one wei                     | (1, 1, 1), (1, 1, 2)           | 1, 0 (rounds down)    |
| x,y   | typical                     | (1_000e6, 3_000e6, 2_000e6)    | 1_500e6               |
| x,y   | exact                       | (6, 4, 3)                      | 8                     |
| x,y   | rounding boundary           | (5, 1, 2), (7, 3, 2)           | 2, 10                 |
| x,y   | uint128 max                 | (u128max, u128max, u128max)    | u128max               |
| x,y   | product > 2^256, fits       | (u256max, 4, 8), (2^200, 2^100, 2^150) | u256max / 2, 2^150 |
| res   | exactly the limit           | (u256max, 1, 1), (u256max, u256max, u256max) | u256max |
| res   | limit plus one              | (u256max, 2, 1), (u256max, u256max, u256max - 1) | revert MathOverflow |
| res   | product just below d        | (d - 1, 1, d)                  | 0                     |
| d     | zero                        | (x, y, 0), including (0, 0, 0) | revert DivisionByZero |
| d     | one                         | (x, y, 1)                      | x * y                 |

mulDivUp(x, y, d), partition table (D-39: shares burned by `withdraw` round up).

| Param | Class                       | Input                          | Expected              |
|-------|-----------------------------|--------------------------------|-----------------------|
| x,y   | zero                        | (0, 5, 3), (5, 0, 3)           | 0, never rounded up   |
| x,y   | one wei                     | (1, 1, 1), (1, 1, 2)           | 1, 1 (rounds up)      |
| x,y   | exact                       | (6, 4, 3)                      | 8, not rounded up     |
| x,y   | rounding boundary           | (5, 1, 2), (7, 3, 2)           | 3, 11                 |
| x,y   | product just below d        | (999, 1, 1000)                 | 1                     |
| x,y   | uint128 max                 | (u128max, u128max, u128max)    | u128max               |
| x,y   | product > 2^256, fits       | (u256max, 4, 8)                | 2^255 (inexact)       |
| res   | exactly the limit, exact    | (u256max, 1, 1), (u256max, u256max, u256max) | u256max |
| res   | floor is the limit, inexact | (2^256 - 2, 2^255 + 1, 2^255)  | revert MathOverflow   |
| res   | floor over the limit        | (u256max, 2, 1)                | revert MathOverflow   |
| d     | zero                        | (x, y, 0), including (0, 0, 0) | revert DivisionByZero |
| d     | one                         | (x, y, 1)                      | x * y                 |
*/
contract MathTest is Test {
    MathHarness internal h;

    uint256 internal constant U128 = type(uint128).max;
    uint256 internal constant U256 = type(uint256).max;

    function setUp() public {
        h = new MathHarness();
    }

    /// @dev Independent reference: floor plus one when there is a remainder.
    function _refCeil(uint256 a, uint256 b) internal pure returns (uint256) {
        return a / b + (a % b == 0 ? 0 : 1);
    }

    /// @dev collateralFor as the spec defines it, over the domain where `p * BPS` fits.
    function _collateral(uint256 p) internal view returns (uint256) {
        return h.ceilDiv(p * BPS, LTV_BPS);
    }

    /// @dev maxBorrow as the spec defines it.
    function _maxBorrow(uint256 available) internal view returns (uint256) {
        return h.mulDivDown(available, LTV_BPS, BPS);
    }

    // ------------------------------------------------------------------ ceilDiv, rows

    function test_ceilDiv_zero() public view {
        assertEq(h.ceilDiv(0, 8000), 0);
    }

    function test_ceilDiv_oneWei() public view {
        assertEq(h.ceilDiv(1, 8000), 1);
    }

    function test_ceilDiv_typical() public view {
        assertEq(h.ceilDiv(1_000e6 * BPS, LTV_BPS), 1_250e6);
    }

    function test_ceilDiv_exactlyLimit() public view {
        assertEq(h.ceilDiv(40_000, 8000), 5);
    }

    function test_ceilDiv_limitPlusOne() public view {
        assertEq(h.ceilDiv(40_001, 8000), 6);
    }

    function test_ceilDiv_limitMinusOne() public view {
        assertEq(h.ceilDiv(39_999, 8000), 5);
    }

    function test_ceilDiv_uint128Max() public view {
        assertEq(h.ceilDiv(U128 * BPS, LTV_BPS), 425352958651173079329218259289710264319);
    }

    function test_ceilDiv_uint256Max() public view {
        assertEq(h.ceilDiv(U256, 8000), U256 / 8000 + 1);
    }

    function test_ceilDiv_roundingBoundary() public view {
        assertEq(h.ceilDiv(10_000, 8000), 2);
        assertEq(h.ceilDiv(8_001, 8000), 2);
    }

    function test_ceilDiv_dustAboveHugeLimit() public view {
        uint256 k = U256 / 8000;
        assertEq(h.ceilDiv(k * 8000, 8000), k);
        assertEq(h.ceilDiv(k * 8000 + 1, 8000), k + 1);
    }

    function test_ceilDiv_divisorZero_reverts() public {
        vm.expectRevert(LedgerMath.DivisionByZero.selector);
        h.ceilDiv(1, 0);
        vm.expectRevert(LedgerMath.DivisionByZero.selector);
        h.ceilDiv(0, 0);
    }

    function test_ceilDiv_divisorOne() public view {
        assertEq(h.ceilDiv(12_345, 1), 12_345);
        assertEq(h.ceilDiv(U256, 1), U256);
    }

    function test_ceilDiv_divisorEqualsNumerator() public view {
        assertEq(h.ceilDiv(8000, 8000), 1);
    }

    function test_ceilDiv_divisorGreaterThanNumerator() public view {
        assertEq(h.ceilDiv(7, 8), 1);
    }

    function test_ceilDiv_divisorUint256Max() public view {
        assertEq(h.ceilDiv(U256, U256), 1);
        assertEq(h.ceilDiv(1, U256), 1);
    }

    // ------------------------------------------- collateral maths (testing-strategy 2.2)

    function test_collateral_oneWeiPrincipalLocksTwo() public view {
        assertEq(_collateral(1), 2);
    }

    function test_collateral_fourIsExactFive() public view {
        assertEq(_collateral(4), 5);
    }

    function test_collateral_fiveRoundsUpToSeven() public view {
        assertEq(_collateral(5), 7);
    }

    /// @dev maxBorrow and collateralFor at the boundary, both directions: the max passes the
    ///      collateral check and one wei more fails it.
    function test_maxBorrow_boundary() public view {
        uint256[6] memory avail = [uint256(1), 2, 5, 6, 1_000e6, 1_000e6 + 1];
        uint256[6] memory expect = [uint256(0), 1, 4, 4, 800e6, 800e6];
        for (uint256 i; i < avail.length; ++i) {
            uint256 mb = _maxBorrow(avail[i]);
            assertEq(mb, expect[i]);
            assertLe(_collateral(mb), avail[i]);
            assertGt(_collateral(mb + 1), avail[i]);
        }
    }

    // --------------------------------------------------------------- mulDivDown, rows

    function test_mulDivDown_zeroFactor() public view {
        assertEq(h.mulDivDown(0, 5, 3), 0);
        assertEq(h.mulDivDown(5, 0, 3), 0);
    }

    function test_mulDivDown_oneWei() public view {
        assertEq(h.mulDivDown(1, 1, 1), 1);
        assertEq(h.mulDivDown(1, 1, 2), 0);
    }

    function test_mulDivDown_typical() public view {
        assertEq(h.mulDivDown(1_000e6, 3_000e6, 2_000e6), 1_500e6);
    }

    function test_mulDivDown_exact() public view {
        assertEq(h.mulDivDown(6, 4, 3), 8);
    }

    function test_mulDivDown_roundsDown() public view {
        assertEq(h.mulDivDown(5, 1, 2), 2);
        assertEq(h.mulDivDown(7, 3, 2), 10);
    }

    function test_mulDivDown_uint128Max() public view {
        assertEq(h.mulDivDown(U128, U128, U128), U128);
    }

    function test_mulDivDown_productOver256BitsResultFits() public view {
        assertEq(h.mulDivDown(U256, 4, 8), U256 / 2);
        assertEq(h.mulDivDown(2 ** 200, 2 ** 100, 2 ** 150), 2 ** 150);
    }

    function test_mulDivDown_resultExactlyMax() public view {
        assertEq(h.mulDivDown(U256, 1, 1), U256);
        assertEq(h.mulDivDown(U256, U256, U256), U256);
    }

    function test_mulDivDown_resultOverflow_reverts() public {
        vm.expectRevert(LedgerMath.MathOverflow.selector);
        h.mulDivDown(U256, 2, 1);
        vm.expectRevert(LedgerMath.MathOverflow.selector);
        h.mulDivDown(U256, U256, U256 - 1);
    }

    function test_mulDivDown_productJustBelowDivisor() public view {
        assertEq(h.mulDivDown(999, 1, 1000), 0);
    }

    function test_mulDivDown_divisorZero_reverts() public {
        vm.expectRevert(LedgerMath.DivisionByZero.selector);
        h.mulDivDown(1, 1, 0);
        vm.expectRevert(LedgerMath.DivisionByZero.selector);
        h.mulDivDown(0, 0, 0);
    }

    function test_mulDivDown_divisorOne() public view {
        assertEq(h.mulDivDown(123, 456, 1), 123 * 456);
    }

    // --------------------------------------------------------------- mulDivUp, rows

    function test_mulDivUp_zeroFactor_notRoundedUp() public view {
        assertEq(h.mulDivUp(0, 5, 3), 0);
        assertEq(h.mulDivUp(5, 0, 3), 0);
    }

    function test_mulDivUp_oneWei() public view {
        assertEq(h.mulDivUp(1, 1, 1), 1);
        assertEq(h.mulDivUp(1, 1, 2), 1);
    }

    function test_mulDivUp_exact_notRoundedUp() public view {
        assertEq(h.mulDivUp(6, 4, 3), 8);
    }

    function test_mulDivUp_roundsUp() public view {
        assertEq(h.mulDivUp(5, 1, 2), 3);
        assertEq(h.mulDivUp(7, 3, 2), 11);
        assertEq(h.mulDivUp(999, 1, 1000), 1);
    }

    function test_mulDivUp_uint128Max() public view {
        assertEq(h.mulDivUp(U128, U128, U128), U128);
    }

    function test_mulDivUp_productOver256Bits_inexact() public view {
        assertEq(h.mulDivUp(U256, 4, 8), 2 ** 255);
    }

    function test_mulDivUp_resultExactlyMax() public view {
        assertEq(h.mulDivUp(U256, 1, 1), U256);
        assertEq(h.mulDivUp(U256, U256, U256), U256);
    }

    /// @dev The floor is exactly 2^256 - 1 with a remainder, so the rounded-up result does not
    ///      fit: a named revert, never the `+ 1` overflowing.
    function test_mulDivUp_floorIsMaxWithRemainder_reverts() public {
        assertEq(h.mulDivDown(2 ** 256 - 2, 2 ** 255 + 1, 2 ** 255), U256);
        vm.expectRevert(LedgerMath.MathOverflow.selector);
        h.mulDivUp(2 ** 256 - 2, 2 ** 255 + 1, 2 ** 255);
    }

    function test_mulDivUp_floorOverflow_reverts() public {
        vm.expectRevert(LedgerMath.MathOverflow.selector);
        h.mulDivUp(U256, 2, 1);
    }

    function test_mulDivUp_divisorZero_reverts() public {
        vm.expectRevert(LedgerMath.DivisionByZero.selector);
        h.mulDivUp(1, 1, 0);
        vm.expectRevert(LedgerMath.DivisionByZero.selector);
        h.mulDivUp(0, 0, 0);
    }

    function test_mulDivUp_divisorOne() public view {
        assertEq(h.mulDivUp(123, 456, 1), 123 * 456);
    }

    // ------------------------------------------ properties (input-testing 3.2), 100k runs

    /// forge-config: default.fuzz.runs = 100000
    function testFuzz_ceilDiv_neverBelowExactNeverAbovePlusOne(uint256 a, uint256 b) public view {
        b = bound(b, 1, U256);
        uint256 r = h.ceilDiv(a, b);
        uint256 floor = a / b;
        assertTrue(r == floor || r == floor + 1, "outside [exact, exact + 1]");
        assertEq(r == floor, a % b == 0, "rounded when exact, or not when inexact");
        assertEq(r, _refCeil(a, b));
    }

    /// forge-config: default.fuzz.runs = 100000
    function testFuzz_ceilDiv_monotonicInNumerator(uint256 a1, uint256 a2, uint256 b) public view {
        b = bound(b, 1, U256);
        (a1, a2) = a1 <= a2 ? (a1, a2) : (a2, a1);
        assertLe(h.ceilDiv(a1, b), h.ceilDiv(a2, b));
    }

    /// forge-config: default.fuzz.runs = 100000
    function testFuzz_ceilDiv_antitoneInDivisor(uint256 a, uint256 b1, uint256 b2) public view {
        b1 = bound(b1, 1, U256);
        b2 = bound(b2, 1, U256);
        (b1, b2) = b1 <= b2 ? (b1, b2) : (b2, b1);
        assertGe(h.ceilDiv(a, b1), h.ceilDiv(a, b2));
    }

    /// @dev Over the whole domain the only failure is a named DivisionByZero, never a panic.
    /// forge-config: default.fuzz.runs = 100000
    function testFuzz_ceilDiv_revertsCleanlyNeverPanics(uint256 a, uint256 b) public view {
        try h.ceilDiv(a, b) returns (uint256) {
            assertGt(b, 0);
        } catch (bytes memory err) {
            assertEq(b, 0);
            assertEq(err, abi.encodeWithSelector(LedgerMath.DivisionByZero.selector));
        }
    }

    /// forge-config: default.fuzz.runs = 100000
    function testFuzz_collateral_properties(uint256 p1, uint256 p2) public view {
        p1 = bound(p1, 0, U256 / BPS);
        p2 = bound(p2, 0, U256 / BPS);
        (p1, p2) = p1 <= p2 ? (p1, p2) : (p2, p1);
        uint256 c = _collateral(p1);
        assertGe(c, p1, "below principal");
        assertGe(c, p1 * 125 / 100, "below 1.25x");
        assertLe(c, p1 * 125 / 100 + 1, "more than one wei over 1.25x");
        assertLe(c, _collateral(p2), "not monotonic");
    }

    /// @dev maxBorrow(a) always passes the collateral check, and one wei more never does.
    /// forge-config: default.fuzz.runs = 100000
    function testFuzz_maxBorrow_isExactlyTheLargestBorrowable(uint256 available) public view {
        available = bound(available, 0, U256 / BPS);
        uint256 mb = _maxBorrow(available);
        assertLe(_collateral(mb), available);
        assertGt(_collateral(mb + 1), available);
    }

    /// @dev Differential against plain arithmetic where the product fits in 256 bits.
    /// forge-config: default.fuzz.runs = 100000
    function testFuzz_mulDivDown_matchesPlainArithmetic(uint128 x, uint128 y, uint256 d)
        public
        view
    {
        d = bound(d, 1, U256);
        assertEq(h.mulDivDown(x, y, d), uint256(x) * y / d);
    }

    /// forge-config: default.fuzz.runs = 100000
    function testFuzz_mulDivDown_monotonicInX(uint128 x1, uint128 x2, uint128 y, uint256 d)
        public
        view
    {
        d = bound(d, 1, U256);
        (x1, x2) = x1 <= x2 ? (x1, x2) : (x2, x1);
        assertLe(h.mulDivDown(x1, y, d), h.mulDivDown(x2, y, d));
    }

    /// @dev Over the whole domain: returns, or reverts with one of the two named errors for
    ///      exactly the right reason. Never a panic.
    /// forge-config: default.fuzz.runs = 100000
    function testFuzz_mulDivDown_revertsCleanlyNeverPanics(uint256 x, uint256 y, uint256 d)
        public
        view
    {
        try h.mulDivDown(x, y, d) returns (uint256 r) {
            assertGt(d, 0);
            if (x <= U128 && y <= U128) assertEq(r, x * y / d);
        } catch (bytes memory err) {
            if (d == 0) {
                assertEq(err, abi.encodeWithSelector(LedgerMath.DivisionByZero.selector));
            } else {
                assertEq(err, abi.encodeWithSelector(LedgerMath.MathOverflow.selector));
                // Overflow is only legitimate when the true quotient exceeds 2^256 - 1,
                // which needs x * y >= d * 2^256, so both factors must exceed d / 2^128.
                assertTrue(x > U128 || y > U128, "overflow claimed for a fitting product");
            }
        }
    }

    /// @dev Up is down, plus one exactly when there is a remainder (plain arithmetic reference).
    /// forge-config: default.fuzz.runs = 100000
    function testFuzz_mulDivUp_isDownPlusRemainder(uint128 x, uint128 y, uint256 d) public view {
        d = bound(d, 1, U256);
        uint256 p = uint256(x) * y;
        assertEq(h.mulDivUp(x, y, d), p / d + (p % d == 0 ? 0 : 1));
    }

    /// @dev Over the whole domain: returns up = down or down + 1, or reverts with one of the two
    ///      named errors for exactly the right reason. Never a panic.
    /// forge-config: default.fuzz.runs = 100000
    function testFuzz_mulDivUp_revertsCleanlyNeverPanics(uint256 x, uint256 y, uint256 d)
        public
        view
    {
        try h.mulDivUp(x, y, d) returns (uint256 r) {
            uint256 down = h.mulDivDown(x, y, d);
            assertEq(r, down + (mulmod(x, y, d) == 0 ? 0 : 1));
        } catch (bytes memory err) {
            if (d == 0) {
                assertEq(err, abi.encodeWithSelector(LedgerMath.DivisionByZero.selector));
            } else {
                assertEq(err, abi.encodeWithSelector(LedgerMath.MathOverflow.selector));
                // Legitimate only if the floor overflows, or is exactly 2^256 - 1 with a remainder.
                try h.mulDivDown(x, y, d) returns (uint256 down) {
                    assertEq(down, U256, "overflow claimed below the limit");
                    assertTrue(mulmod(x, y, d) != 0, "overflow claimed for an exact max");
                } catch (bytes memory e2) {
                    assertEq(e2, abi.encodeWithSelector(LedgerMath.MathOverflow.selector));
                }
            }
        }
    }
}
