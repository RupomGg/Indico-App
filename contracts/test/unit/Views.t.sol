// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {LedgerMath} from "../../src/lib/Math.sol";
import {BPS, LTV_BPS} from "../../src/lib/Constants.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice The read views, contract-spec 5; IT 3.2; D-38 (pool figures from `poolUsdc`, never
///         `balanceOf`), D-45 (`collateralFor` is the same `mulDivUp` the loan check uses).
///
/// | View               | Class                                   | Expected                          |
/// |--------------------|-----------------------------------------|-----------------------------------|
/// | available(u)       | unknown / minted / locked / defaulted   | credit - lockedCredit             |
/// | maxBorrow(u)       | a = 0, 1, 2, 999_999_999, 1_000e6       | floor(a * 0.8): 0, 0, 1, 799_999_999, 800e6 |
/// |                    | any a                                   | collateralFor(mb) <= a < collateralFor(mb + 1) |
/// |                    | credit near 2^256 (a merchant)          | no panic                          |
/// | collateralFor(p)   | 0, 1, 4, 800e6, uint128 max             | 0, 2, 5, 1_000e6, exact ceil      |
/// |                    | uint256 max                             | MathOverflow, never a panic       |
/// |                    | any p                                   | equals the lock requestLoan takes; monotonic |
/// | poolTotalAssets()  | empty, deposited, lent, defaulted       | poolUsdc + totalLent              |
/// | poolAvailable()    | same, fully lent                        | poolUsdc (0 when fully lent)      |
/// | sharesToAssets(s)  | empty pool, 1e12 shares                 | 1e6                               |
/// | assetsToShares(a)  | empty pool, 1e6                         | 1e12; equals what deposit mints   |
/// | both, uint256 max  | empty pool                              | max / 1e6; MathOverflow, no panic |
/// | maxWithdraw(m)     | no shares, empty, partly / fully lent, after a default | min(claim, poolUsdc); what withdrawAll pays |
/// Direct USDC transfers to the ledger move no pool figure (D-38). Every view works while
/// paused and writes nothing.
contract ViewsTest is Actors {
    uint64 internal constant START = 1_800_000_000;
    uint256 internal constant DEP = 1_000e6;

    function setUp() public override {
        super.setUp();
        vm.warp(START);
    }

    // ================================================================== available

    function test_available_unknownIsZero() public {
        assertEq(ledger.available(makeAddr("stranger")), 0);
    }

    function test_available_tracksCreditAndLock() public {
        _mintCredit(alice, 1_500e6);
        assertEq(ledger.available(alice), 1_500e6);
        _fundPool(DEP);
        vm.prank(alice);
        ledger.requestLoan(800e6); // locks 1_000e6
        assertEq(ledger.available(alice), 500e6);
        assertEq(ledger.available(alice), ledger.credit(alice) - ledger.lockedCredit(alice));
    }

    /// @dev A liquidation burns exactly the lock, so available credit does not move.
    function test_available_unchangedByDefault() public {
        _mintCredit(alice, 1_500e6);
        _fundPool(DEP);
        vm.prank(alice);
        uint256 id = ledger.requestLoan(800e6);
        uint256 before = ledger.available(alice);
        _default(id);
        assertEq(ledger.available(alice), before);
    }

    // ================================================================== maxBorrow

    function test_maxBorrow_exactValues() public {
        uint256[5] memory a = [uint256(0), 1, 2, 999_999_999, 1_000e6];
        uint256[5] memory mb = [uint256(0), 0, 1, 799_999_999, 800e6];
        for (uint256 i; i < a.length; ++i) {
            address u = makeAddr(string.concat("u", vm.toString(i)));
            _approveAndSign(u);
            if (a[i] > 0) _mintCredit(u, a[i]);
            assertEq(ledger.maxBorrow(u), mb[i], "maxBorrow");
        }
    }

    /// @dev TS 2.2: requestLoan(maxBorrow(u)) succeeds; one wei more reverts on credit.
    function test_maxBorrow_opens_andOneMoreReverts() public {
        _mintCredit(alice, 999_999_999);
        _fundPool(DEP);
        uint256 mb = ledger.maxBorrow(alice);
        _revertsUnchanged(
            alice,
            abi.encodeCall(IIndicoLedger.requestLoan, (mb + 1)),
            abi.encodeWithSelector(
                IIndicoLedger.InsufficientAvailableCredit.selector,
                ledger.collateralFor(mb + 1),
                999_999_999
            )
        );
        vm.prank(alice);
        ledger.requestLoan(mb);
        assertLe(ledger.lockedCredit(alice), ledger.credit(alice));
    }

    /// @dev A merchant may hold more than 2^128 credit (D-27): no overflow, never a panic.
    function test_maxBorrow_hugeCredit_noPanic() public {
        vm.store(address(ledger), _key(merchantA, SLOT_CREDIT), bytes32(type(uint256).max));
        // 2^256 - 1 is a multiple of 5, so 80% of it is exact.
        assertEq(ledger.maxBorrow(merchantA), type(uint256).max / 5 * 4);
    }

    // ================================================================== collateralFor

    function test_collateralFor_exactValues() public view {
        assertEq(ledger.collateralFor(0), 0);
        assertEq(ledger.collateralFor(1), 2, "1.25 rounds up to 2");
        assertEq(ledger.collateralFor(4), 5, "exact, no double rounding");
        assertEq(ledger.collateralFor(800e6), 1_000e6);
        uint256 m = type(uint128).max;
        assertEq(ledger.collateralFor(m), LedgerMath.ceilDiv(m * BPS, LTV_BPS));
    }

    function test_collateralFor_uint256Max_revertsMathOverflow() public {
        vm.expectRevert(LedgerMath.MathOverflow.selector);
        ledger.collateralFor(type(uint256).max);
    }

    // ================================================================== pool figures

    /// @dev uint256 max: a value or the named MathOverflow, never a panic. On an empty pool one
    ///      share is worth 1e-6 of a unit, so max shares convert, and max assets overflow.
    function test_shareConversions_uint256Max_noPanic() public {
        assertEq(ledger.sharesToAssets(type(uint256).max), type(uint256).max / 1e6);
        vm.expectRevert(LedgerMath.MathOverflow.selector);
        ledger.assetsToShares(type(uint256).max);
    }

    function test_pool_empty() public view {
        assertEq(ledger.poolTotalAssets(), 0);
        assertEq(ledger.poolAvailable(), 0);
        assertEq(ledger.assetsToShares(1e6), 1e12, "offset: 1e6 shares per unit");
        assertEq(ledger.sharesToAssets(1e12), 1e6);
        assertEq(ledger.maxWithdraw(merchantA), 0);
    }

    function test_pool_deposited_lent_defaulted() public {
        _deposit(merchantA, DEP);
        assertEq(ledger.poolTotalAssets(), DEP);
        assertEq(ledger.poolAvailable(), DEP);
        assertEq(ledger.maxWithdraw(merchantA), DEP);

        uint256 active = _lendOut(600e6, 200e6); // 200e6 defaulted, 400e6 still lent
        assertGt(active, 0);
        assertEq(ledger.poolAvailable(), DEP - 600e6);
        assertEq(ledger.poolTotalAssets(), DEP - 200e6, "the default is a loss");
        assertEq(ledger.maxWithdraw(merchantA), DEP - 600e6, "capped by the cash");
    }

    function test_pool_fullyLent_noCash_maxWithdrawZero() public {
        _deposit(merchantA, DEP);
        _lendOut(DEP, 0);
        assertEq(ledger.poolAvailable(), 0);
        assertEq(ledger.poolTotalAssets(), DEP);
        assertEq(ledger.maxWithdraw(merchantA), 0);
    }

    function test_maxWithdraw_noShares_isZero() public {
        _deposit(merchantA, DEP);
        assertEq(ledger.maxWithdraw(merchantB), 0);
    }

    /// @dev D-38: USDC sent straight to the ledger moves no pool figure. With a loan out the
    ///      claim exceeds the cash, so `maxWithdraw` is capped by `poolUsdc`; the stray USDC
    ///      would lift a cap taken from `balanceOf`, and must not.
    function test_pool_directTransfer_movesNothing() public {
        _deposit(merchantA, DEP);
        _lendOut(600e6, 0);
        assertEq(ledger.maxWithdraw(merchantA), DEP - 600e6, "capped by the cash");
        uint256 total = ledger.poolTotalAssets();
        uint256 cash = ledger.poolAvailable();
        uint256 claim = ledger.maxWithdraw(merchantA);
        vm.prank(alice);
        usdc.transfer(address(ledger), 500e6);
        assertEq(ledger.poolTotalAssets(), total);
        assertEq(ledger.poolAvailable(), cash);
        assertEq(ledger.maxWithdraw(merchantA), claim);
    }

    // ================================================================== paused, no writes

    /// @dev Every view works while paused and writes nothing.
    function test_views_workWhilePaused_writeNothing() public {
        _mintCredit(alice, 1_000e6);
        _deposit(merchantA, DEP);
        _pause();
        _startDiff();
        ledger.available(alice);
        ledger.maxBorrow(alice);
        ledger.collateralFor(800e6);
        ledger.poolTotalAssets();
        ledger.poolAvailable();
        ledger.sharesToAssets(1e12);
        ledger.assetsToShares(1e6);
        ledger.maxWithdraw(merchantA);
        _assertNoChange();
    }

    // ================================================================== properties (IT 3.2)

    /// @dev For any available credit a: maxBorrow passes the collateral check and one more wei
    ///      does not (contract-spec 5, both directions).
    function testFuzz_maxBorrow_isTheExactBoundary(uint256 a) public {
        a = bound(a, 0, type(uint128).max);
        if (a > 0) _mintCredit(alice, a);
        uint256 mb = ledger.maxBorrow(alice);
        assertLe(ledger.collateralFor(mb), a, "maxBorrow fails its own check");
        assertGt(ledger.collateralFor(mb + 1), a, "one more wei still passes");
    }

    /// @dev For any principal: collateralFor is at least 1.25x and less than one wei above it,
    ///      monotonic, and exactly the lock requestLoan takes (D-45).
    function testFuzz_collateralFor_matchesLoanLock(uint256 p, uint256 q) public {
        p = bound(p, 1, FUND - DEP);
        q = bound(q, 0, type(uint128).max);
        uint256 k = ledger.collateralFor(p);
        assertGe(k * LTV_BPS, p * BPS, "below 1.25x");
        assertLt((k - 1) * LTV_BPS, p * BPS, "a wei too much");
        if (q < p) assertLe(ledger.collateralFor(q), k, "not monotonic");
        else assertGe(ledger.collateralFor(q), k, "not monotonic");
        _mintCredit(bob, k);
        _fundPool(p);
        vm.prank(bob);
        ledger.requestLoan(p);
        assertEq(ledger.lockedCredit(bob), k, "view and loan disagree");
    }

    /// @dev For any deposit, in a pool with any loss: assetsToShares is exactly what deposit
    ///      mints, and maxWithdraw is exactly what withdrawAll then pays.
    function testFuzz_shareViews_matchDepositAndWithdrawAll(uint256 a, uint256 lent, uint256 lost)
        public
    {
        _deposit(merchantA, DEP);
        lent = bound(lent, 0, DEP);
        lost = bound(lost, 0, lent);
        _lendOut(lent, lost);
        a = bound(a, 1, FUND);
        uint256 expectedShares = ledger.assetsToShares(a);
        uint256 before = ledger.shares(merchantB);
        if (expectedShares == 0) {
            _revertsUnchanged(
                merchantB,
                abi.encodeCall(IIndicoLedger.deposit, (a)),
                abi.encodeWithSelector(IIndicoLedger.ZeroShares.selector)
            );
            return;
        }
        _deposit(merchantB, a);
        assertEq(ledger.shares(merchantB) - before, expectedShares, "assetsToShares != minted");
        assertEq(
            ledger.maxWithdraw(merchantB),
            _min(ledger.sharesToAssets(ledger.shares(merchantB)), ledger.poolAvailable())
        );

        uint256 mw = ledger.maxWithdraw(merchantA);
        uint256 usdcBefore = usdc.balanceOf(merchantA);
        if (mw == 0) {
            vm.prank(merchantA);
            (bool ok,) = address(ledger).call(abi.encodeCall(IIndicoLedger.withdrawAll, ()));
            assertFalse(ok, "withdrawAll paid while maxWithdraw is 0");
        } else {
            vm.prank(merchantA);
            ledger.withdrawAll();
            assertEq(usdc.balanceOf(merchantA) - usdcBefore, mw, "withdrawAll != maxWithdraw");
        }
    }

    function _min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }
}
