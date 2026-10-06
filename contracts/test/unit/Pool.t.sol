// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {LedgerMath} from "../../src/lib/Math.sol";
import {MockUSDC} from "../helpers/MockUSDC.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice The pool: `deposit`, `withdraw`, `withdrawAll`. Contract-spec 5, 6.5; PRD 3.4; D-06,
///         D-38 (internal accounting, virtual offset 1e6 shares / 1 asset), D-39 (withdraw by
///         USDC amount). S = totalShares, A = poolUsdc + totalLent. Loans do not exist until
///         P1.8, so a loan's pool side is simulated (`_simulateLend`, `_simulateRepay`,
///         `_simulateDefault`); those tests rerun on real loans in P1.8, P1.9 and P1.11 (O-033).
///
/// deposit(amount), caller an approved merchant who signed
/// | Class                                  | Expected                                        |
/// |----------------------------------------|-------------------------------------------------|
/// | zero                                   | ZeroAmount                                      |
/// | one wei, empty pool                    | 1e6 shares                                      |
/// | typical, empty pool                    | amount x 1e6 shares                             |
/// | into a pool with a loss (price < 1e-6) | more shares; claim within 1 wei, never more     |
/// | into a pool with shares but A = 0      | no division by zero (A + 1); claim within 1 wei |
/// | exactly the caller's balance           | succeeds                                        |
/// | above balance, uint256 max             | the token's ERC20InsufficientBalance, no panic  |
/// | allowance short                        | ERC20InsufficientAllowance                      |
/// | 1% fee-on-transfer token               | shares on what arrived, poolUsdc += received    |
/// | 100% fee, nothing arrives              | ZeroShares                                      |
/// | token returns false                    | SafeERC20FailedOperation                        |
/// | blacklisted merchant                   | the token's revert, full rollback               |
/// | token re-enters the pool               | ReentrancyGuardReentrantCall                    |
/// caller: user, admin, guardian, stranger, revoked merchant -> NotApprovedMerchant; approved
/// but unsigned merchant -> TermsNotSigned; paused -> EnforcedPause.
/// Order: EnforcedPause, NotApprovedMerchant, TermsNotSigned, ZeroAmount, (transfer), ZeroShares.
///
/// withdraw(assets), claim c = what the caller's shares are worth, cash = poolUsdc
/// | Class                                  | Expected                                        |
/// |----------------------------------------|-------------------------------------------------|
/// | zero                                   | ZeroAmount                                      |
/// | one wei                                | pays 1, burns 1e6 shares                        |
/// | typical                                | pays exactly, burns mulDivUp(assets, S+1e6, A+1)|
/// | after a loss (inexact)                 | burn rounds up, never down                      |
/// | exactly c                              | pays c                                          |
/// | c plus one                             | InsufficientShares(needed, held)                |
/// | no shares (user, stranger, merchant)   | InsufficientShares(needed, 0)                   |
/// | uint256 max                            | MathOverflow (named), never a panic             |
/// | above cash, within c                   | InsufficientLiquidity(assets, cash)             |
/// | exactly cash                           | pays it                                         |
/// | revoked merchant                       | pays: their money is theirs                     |
/// | blacklisted merchant, token false      | the token's revert, full rollback               |
/// Order: EnforcedPause, ZeroAmount, InsufficientShares, InsufficientLiquidity.
///
/// withdrawAll()
/// | Class                                  | Expected                                        |
/// |----------------------------------------|-------------------------------------------------|
/// | claim fits the cash                    | pays c, burns every share (no dust)             |
/// | after a loss                           | pays floor c, burns every share                 |
/// | no shares, or shares worth 0           | ZeroAmount                                      |
/// | claim > 0, cash 0                      | InsufficientLiquidity(c, 0)                     |
/// | cash short                             | pays the cash; a later withdrawAll pays the     |
/// |                                        | rest; together c minus at most 2 wei           |
/// | revoked merchant                       | pays                                            |
///
/// Direct USDC transfer to the ledger (not deposit): counted nowhere. No balance, share,
/// poolUsdc or price moves; the surplus is usdc.balanceOf(ledger) - poolUsdc, stuck for good
/// (D-38, O-032). After every test that moves USDC, usdc.balanceOf(ledger) >= poolUsdc.
/// Every revert leaves the full state snapshot unchanged.
contract PoolTest is Actors {
    uint256 internal constant DEP = 1_000e6;

    address internal stranger = makeAddr("stranger");

    // ------------------------------------------------------------------ helpers

    function _withdraw(address m, uint256 assets) internal {
        vm.prank(m);
        ledger.withdraw(assets);
    }

    function _withdrawAll(address m) internal {
        vm.prank(m);
        ledger.withdrawAll();
    }

    function _expectRevertUnchanged(address who, bytes memory call, bytes memory err) internal {
        _revertsUnchanged(who, call, err);
    }

    function _depositCall(uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IIndicoLedger.deposit, (amount));
    }

    function _withdrawCall(uint256 assets) internal pure returns (bytes memory) {
        return abi.encodeCall(IIndicoLedger.withdraw, (assets));
    }

    function _withdrawAllCall() internal pure returns (bytes memory) {
        return abi.encodeCall(IIndicoLedger.withdrawAll, ());
    }

    function _assertBooks() internal view {
        assertGe(usdc.balanceOf(address(ledger)), ledger.poolUsdc(), "books: USDC below poolUsdc");
    }

    function _ledgerLogs(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(ledger)) ++n;
        }
    }

    function _index(address a) internal view returns (uint256) {
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] == a) return i;
        }
        revert("not an actor");
    }

    /// @dev Deposit `DEP`, lend `lent`, default `lost` of it: a pool whose price is off 1:1.
    function _poolWithLoss(uint256 lent, uint256 lost) internal {
        _deposit(merchantA, DEP);
        _simulateLend(lent);
        _simulateDefault(lost);
    }

    // ================================================================== deposit, happy path

    function test_deposit_firstIntoEmptyPool_mintsAtOffset_emitsDeposited() public {
        Snapshot memory s = _snapshot();
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.Deposited(merchantA, DEP, DEP * 1e6);
        _deposit(merchantA, DEP);

        uint256 m = _index(merchantA);
        s.usdc[m] -= DEP;
        s.shares[m] += DEP * 1e6;
        s.totalShares += DEP * 1e6;
        s.poolUsdc += DEP;
        s.ledgerUsdc += DEP;
        _assertUnchanged(s);
        _assertBooks();
    }

    function test_deposit_emitsOnlyDeposited() public {
        vm.recordLogs();
        _deposit(merchantA, DEP);
        assertEq(_ledgerLogs(vm.getRecordedLogs()), 1);
    }

    function test_deposit_oneWei_intoEmptyPool() public {
        _deposit(merchantA, 1);
        assertEq(ledger.shares(merchantA), 1e6);
        assertEq(ledger.poolUsdc(), 1);
    }

    function test_deposit_secondDepositor_proportional() public {
        _deposit(merchantA, DEP);
        _deposit(merchantB, DEP / 2);
        assertEq(ledger.shares(merchantB), DEP / 2 * 1e6);
        assertEq(ledger.totalShares(), (DEP + DEP / 2) * 1e6);
        assertEq(ledger.poolUsdc(), DEP + DEP / 2);
    }

    function test_deposit_exactlyWholeBalance() public {
        _deposit(merchantA, FUND);
        assertEq(usdc.balanceOf(merchantA), 0);
        assertEq(ledger.poolUsdc(), FUND);
    }

    /// @dev After a loss each share is worth less, so the same USDC mints more shares, and the
    ///      new depositor's claim is what they put in, within 1 wei, never more.
    function test_deposit_afterLoss_mintsMoreShares_claimWithinOneWei() public {
        _poolWithLoss(400e6, 400e6); // A = 600e6, S = 1e15
        uint256 expected = LedgerMath.mulDivDown(600e6, 1e15 + 1e6, 600e6 + 1);
        _deposit(merchantB, 600e6);
        assertEq(ledger.shares(merchantB), expected);
        assertGt(expected, 600e6 * 1e6, "not more shares");
        uint256 c = _modelClaim(merchantB);
        assertLe(c, 600e6);
        assertGe(c, 600e6 - 1);
        _assertBooks();
    }

    /// @dev Every loan defaulted while shares remain: A = 0. contract-spec 5 as first written
    ///      divided by zero here; A + 1 does not (D-38).
    function test_deposit_afterTotalWipeout_noDivisionByZero() public {
        _poolWithLoss(DEP, DEP); // poolUsdc 0, totalLent 0, S = 1e15
        assertEq(ledger.poolUsdc() + ledger.totalLent(), 0);
        _deposit(merchantB, DEP);
        assertEq(ledger.shares(merchantB), DEP * (1e15 + 1e6));
        uint256 c = _modelClaim(merchantB);
        assertLe(c, DEP);
        assertGe(c, DEP - 1);
        assertLe(_modelClaim(merchantA) + c, ledger.poolUsdc(), "claims above assets");
    }

    function test_deposit_feeOnTransfer_sharesOnAmountReceived() public {
        usdc.setFeeBps(100); // 1%
        uint256 received = DEP * 99 / 100;
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.Deposited(merchantA, received, received * 1e6);
        _deposit(merchantA, DEP);
        assertEq(ledger.shares(merchantA), received * 1e6);
        assertEq(ledger.poolUsdc(), received);
        assertEq(usdc.balanceOf(address(ledger)), received);
    }

    function testFuzz_deposit_claimWithinOneWei_othersNeverLose(
        uint256 first,
        uint256 second,
        uint256 lost
    ) public {
        first = bound(first, 1, FUND);
        second = bound(second, 1, FUND);
        _deposit(merchantA, first);
        lost = bound(lost, 0, first);
        _simulateLend(lost);
        _simulateDefault(lost);

        uint256 aBefore = _modelClaim(merchantA);
        _deposit(merchantB, second);
        uint256 c = _modelClaim(merchantB);
        assertLe(c, second, "claim above deposit");
        assertGe(c, second - 1, "lost more than 1 wei");
        assertGe(_modelClaim(merchantA), aBefore, "existing holder lost");
        _assertBooks();
    }

    // ================================================================== deposit, reverts

    function test_deposit_zero_revertsZeroAmount() public {
        _expectRevertUnchanged(
            merchantA, _depositCall(0), abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
        );
    }

    function test_deposit_notAMerchant_revertsNotApprovedMerchant() public {
        _addActor(stranger);
        _revokeMerchant(merchantB);
        address[5] memory who = [alice, admin, guardian, stranger, merchantB];
        for (uint256 i; i < who.length; ++i) {
            _expectRevertUnchanged(
                who[i],
                _depositCall(DEP),
                abi.encodeWithSelector(IIndicoLedger.NotApprovedMerchant.selector)
            );
        }
    }

    function test_deposit_merchantNotSigned_revertsTermsNotSigned() public {
        address m = makeAddr("unsignedMerchant");
        _addActor(m);
        vm.prank(admin);
        ledger.setMerchantApproved(m, true);
        _expectRevertUnchanged(
            m, _depositCall(DEP), abi.encodeWithSelector(IIndicoLedger.TermsNotSigned.selector)
        );
    }

    function test_deposit_paused_revertsEnforcedPause() public {
        _pause();
        _expectRevertUnchanged(
            merchantA, _depositCall(DEP), abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    function test_deposit_aboveBalance_revertsTokenError() public {
        _expectRevertUnchanged(
            merchantA,
            _depositCall(FUND + 1),
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, merchantA, FUND, FUND + 1
            )
        );
    }

    function test_deposit_uint256Max_revertsTokenError_noPanic() public {
        _expectRevertUnchanged(
            merchantA,
            _depositCall(type(uint256).max),
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, merchantA, FUND, type(uint256).max
            )
        );
    }

    function test_deposit_allowanceShort_revertsTokenError() public {
        vm.prank(merchantA);
        usdc.approve(address(ledger), DEP - 1);
        _expectRevertUnchanged(
            merchantA,
            _depositCall(DEP),
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(ledger), DEP - 1, DEP
            )
        );
    }

    function test_deposit_fullFee_nothingArrives_revertsZeroShares() public {
        usdc.setFeeBps(10_000);
        _expectRevertUnchanged(
            merchantA, _depositCall(DEP), abi.encodeWithSelector(IIndicoLedger.ZeroShares.selector)
        );
    }

    function test_deposit_tokenReturnsFalse_revertsSafeERC20() public {
        usdc.setReturnsFalse(true);
        _expectRevertUnchanged(
            merchantA,
            _depositCall(DEP),
            abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdc))
        );
    }

    function test_deposit_blacklistedMerchant_fullRollback() public {
        usdc.blacklist(merchantA);
        _expectRevertUnchanged(
            merchantA,
            _depositCall(DEP),
            abi.encodeWithSelector(MockUSDC.Blacklisted.selector, merchantA)
        );
    }

    function test_deposit_order_pausedBeforeNotMerchant() public {
        _pause();
        _expectRevertUnchanged(
            alice, _depositCall(0), abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    function test_deposit_order_notMerchantBeforeTermsAndZero() public {
        address m = makeAddr("unsignedRevoked");
        vm.prank(admin);
        ledger.setMerchantApproved(m, true);
        _revokeMerchant(m);
        _expectRevertUnchanged(
            m, _depositCall(0), abi.encodeWithSelector(IIndicoLedger.NotApprovedMerchant.selector)
        );
    }

    function test_deposit_order_termsBeforeZero() public {
        address m = makeAddr("unsignedMerchant");
        vm.prank(admin);
        ledger.setMerchantApproved(m, true);
        _expectRevertUnchanged(
            m, _depositCall(0), abi.encodeWithSelector(IIndicoLedger.TermsNotSigned.selector)
        );
    }

    // ================================================================== reentrancy

    /// @dev The token calls back into each pool function from inside each pool function's
    ///      transfer: 3 x 3, every one stopped by the guard, nothing changed.
    function test_reentrancy_everyPoolFunctionIntoEvery_reverts() public {
        _deposit(merchantA, DEP);
        bytes[3] memory reenter = [_depositCall(1), _withdrawCall(1), _withdrawAllCall()];
        bytes[3] memory outer = [_depositCall(DEP), _withdrawCall(DEP / 2), _withdrawAllCall()];
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 3; ++j) {
                usdc.setReentrantTarget(address(ledger), reenter[j]);
                _expectRevertUnchanged(
                    merchantA,
                    outer[i],
                    abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
                );
            }
        }
    }

    // ================================================================== withdraw, happy path

    function test_withdraw_paysExactly_burnsShares_emitsWithdrawn() public {
        _deposit(merchantA, DEP);
        Snapshot memory s = _snapshot();
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.Withdrawn(merchantA, 400e6, 400e6 * 1e6);
        _withdraw(merchantA, 400e6);

        uint256 m = _index(merchantA);
        s.usdc[m] += 400e6;
        s.shares[m] -= 400e6 * 1e6;
        s.totalShares -= 400e6 * 1e6;
        s.poolUsdc -= 400e6;
        s.ledgerUsdc -= 400e6;
        _assertUnchanged(s);
        _assertBooks();
    }

    function test_withdraw_emitsOnlyWithdrawn() public {
        _deposit(merchantA, DEP);
        vm.recordLogs();
        _withdraw(merchantA, 1);
        assertEq(_ledgerLogs(vm.getRecordedLogs()), 1);
    }

    function test_withdraw_oneWei_burnsOffsetShares() public {
        _deposit(merchantA, DEP);
        _withdraw(merchantA, 1);
        assertEq(ledger.shares(merchantA), DEP * 1e6 - 1e6);
    }

    function test_withdraw_exactlyClaim_leavesNothing() public {
        _deposit(merchantA, DEP);
        _withdraw(merchantA, DEP);
        assertEq(ledger.shares(merchantA), 0);
        assertEq(ledger.poolUsdc(), 0);
        assertEq(usdc.balanceOf(merchantA), FUND);
    }

    /// @dev After a 1-wei loss, 1 USDC wei is worth 1,000,000.001 shares: the burn rounds up
    ///      to 1,000,001, never down (D-39, rounding in the pool's favour).
    function test_withdraw_afterLoss_burnRoundsUp() public {
        _poolWithLoss(1, 1); // A + 1 = 1e9, S + 1e6 = 1e15 + 1e6
        assertEq(LedgerMath.mulDivDown(1, 1e15 + 1e6, 1e9), 1_000_000);
        _withdraw(merchantA, 1);
        assertEq(ledger.shares(merchantA), 1e15 - 1_000_001);
    }

    function test_withdraw_exactlyCash_succeeds() public {
        _deposit(merchantA, DEP);
        _simulateLend(600e6);
        _withdraw(merchantA, 400e6);
        assertEq(ledger.poolUsdc(), 0);
        assertEq(ledger.totalLent(), 600e6);
        _assertBooks();
    }

    function test_withdraw_revokedMerchant_succeeds() public {
        _deposit(merchantA, DEP);
        _revokeMerchant(merchantA);
        _withdraw(merchantA, DEP);
        assertEq(usdc.balanceOf(merchantA), FUND);
    }

    /// @dev Paid exactly what was asked; at most one share's worth (under 1 wei here) extra
    ///      burned; nobody else's claim falls.
    function testFuzz_withdraw_paysExactly_burnsAtMostOneWeiExtra(
        uint256 depA,
        uint256 depB,
        uint256 lost,
        uint256 assets
    ) public {
        depA = bound(depA, 1e6, FUND);
        depB = bound(depB, 1, FUND);
        _deposit(merchantA, depA);
        _deposit(merchantB, depB);
        lost = bound(lost, 0, (depA + depB) / 2); // A keeps a claim, the pool keeps cash
        _simulateLend(lost);
        _simulateDefault(lost);

        uint256 claim = _modelClaim(merchantA);
        uint256 bBefore = _modelClaim(merchantB);
        assets = bound(assets, 1, claim < ledger.poolUsdc() ? claim : ledger.poolUsdc());
        uint256 usdcBefore = usdc.balanceOf(merchantA);
        _withdraw(merchantA, assets);

        assertEq(usdc.balanceOf(merchantA), usdcBefore + assets, "not paid exactly");
        uint256 left = _modelClaim(merchantA);
        assertLe(left, claim - assets, "kept more than the rest");
        assertGe(left + 1, claim - assets, "burned more than 1 wei extra");
        assertGe(_modelClaim(merchantB), bBefore, "other holder lost");
        _assertBooks();
    }

    // ================================================================== withdraw, reverts

    function test_withdraw_zero_revertsZeroAmount() public {
        _deposit(merchantA, DEP);
        _expectRevertUnchanged(
            merchantA, _withdrawCall(0), abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
        );
    }

    function test_withdraw_claimPlusOne_revertsInsufficientShares() public {
        _deposit(merchantA, DEP);
        _expectRevertUnchanged(
            merchantA,
            _withdrawCall(DEP + 1),
            abi.encodeWithSelector(
                IIndicoLedger.InsufficientShares.selector, (DEP + 1) * 1e6, DEP * 1e6
            )
        );
    }

    function test_withdraw_noShares_revertsInsufficientShares() public {
        _deposit(merchantA, DEP);
        address[4] memory who = [alice, merchantB, admin, stranger];
        for (uint256 i; i < who.length; ++i) {
            _expectRevertUnchanged(
                who[i],
                _withdrawCall(1),
                abi.encodeWithSelector(IIndicoLedger.InsufficientShares.selector, 1e6, 0)
            );
        }
    }

    function test_withdraw_uint256Max_revertsMathOverflow_noPanic() public {
        _deposit(merchantA, DEP);
        _expectRevertUnchanged(
            merchantA,
            _withdrawCall(type(uint256).max),
            abi.encodeWithSelector(LedgerMath.MathOverflow.selector)
        );
    }

    function test_withdraw_aboveCash_revertsInsufficientLiquidity() public {
        _deposit(merchantA, DEP);
        _simulateLend(600e6);
        _expectRevertUnchanged(
            merchantA,
            _withdrawCall(400e6 + 1),
            abi.encodeWithSelector(IIndicoLedger.InsufficientLiquidity.selector, 400e6 + 1, 400e6)
        );
    }

    function test_withdraw_paused_revertsEnforcedPause() public {
        _deposit(merchantA, DEP);
        _pause();
        _expectRevertUnchanged(
            merchantA, _withdrawCall(1), abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    function test_withdraw_blacklistedMerchant_fullRollback() public {
        _deposit(merchantA, DEP);
        usdc.blacklist(merchantA);
        _expectRevertUnchanged(
            merchantA,
            _withdrawCall(DEP),
            abi.encodeWithSelector(MockUSDC.Blacklisted.selector, merchantA)
        );
    }

    function test_withdraw_tokenReturnsFalse_fullRollback() public {
        _deposit(merchantA, DEP);
        usdc.setReturnsFalse(true);
        _expectRevertUnchanged(
            merchantA,
            _withdrawCall(DEP),
            abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdc))
        );
    }

    function test_withdraw_order_pausedBeforeZero() public {
        _pause();
        _expectRevertUnchanged(
            stranger, _withdrawCall(0), abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    function test_withdraw_order_zeroBeforeShares() public {
        _expectRevertUnchanged(
            stranger, _withdrawCall(0), abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
        );
    }

    /// @dev Above both the claim and the cash: the shares are checked first.
    function test_withdraw_order_sharesBeforeLiquidity() public {
        _deposit(merchantA, DEP);
        _simulateLend(600e6);
        _expectRevertUnchanged(
            merchantA,
            _withdrawCall(DEP + 1),
            abi.encodeWithSelector(
                IIndicoLedger.InsufficientShares.selector, (DEP + 1) * 1e6, DEP * 1e6
            )
        );
    }

    // ================================================================== withdrawAll

    function test_withdrawAll_wholeClaim_burnsEveryShare_emits() public {
        _deposit(merchantA, DEP);
        Snapshot memory s = _snapshot();
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.Withdrawn(merchantA, DEP, DEP * 1e6);
        _withdrawAll(merchantA);

        uint256 m = _index(merchantA);
        s.usdc[m] += DEP;
        s.shares[m] = 0;
        s.totalShares = 0;
        s.poolUsdc = 0;
        s.ledgerUsdc -= DEP;
        _assertUnchanged(s);
    }

    function test_withdrawAll_emitsOnlyWithdrawn() public {
        _deposit(merchantA, DEP);
        vm.recordLogs();
        _withdrawAll(merchantA);
        assertEq(_ledgerLogs(vm.getRecordedLogs()), 1);
    }

    /// @dev The claim is a floor, so a share's fraction of a wei is left behind, and every
    ///      share is still burned: no dust shares.
    function test_withdrawAll_afterLoss_paysFloorClaim_noDustShares() public {
        _deposit(merchantA, DEP);
        _deposit(merchantB, DEP);
        _simulateLend(3);
        _simulateDefault(3);
        uint256 claim = _modelClaim(merchantA);
        _withdrawAll(merchantA);
        assertEq(ledger.shares(merchantA), 0, "dust shares left");
        assertEq(usdc.balanceOf(merchantA), FUND - DEP + claim);
        assertEq(ledger.totalShares(), DEP * 1e6);
        _assertBooks();
    }

    function test_withdrawAll_revokedMerchant_succeeds() public {
        _deposit(merchantA, DEP);
        _revokeMerchant(merchantA);
        _withdrawAll(merchantA);
        assertEq(usdc.balanceOf(merchantA), FUND);
        assertEq(ledger.shares(merchantA), 0);
    }

    function test_withdrawAll_noShares_revertsZeroAmount() public {
        _deposit(merchantA, DEP);
        address[4] memory who = [alice, merchantB, admin, stranger];
        for (uint256 i; i < who.length; ++i) {
            _expectRevertUnchanged(
                who[i],
                _withdrawAllCall(),
                abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
            );
        }
    }

    /// @dev 1 wei deposited, then lost: 1e6 shares worth 1e6 * 1 / 2e6 = 0.
    function test_withdrawAll_sharesWorthNothing_revertsZeroAmount() public {
        _deposit(merchantA, 1);
        _simulateLend(1);
        _simulateDefault(1);
        assertEq(ledger.shares(merchantA), 1e6);
        _expectRevertUnchanged(
            merchantA, _withdrawAllCall(), abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
        );
    }

    function test_withdrawAll_noCash_revertsInsufficientLiquidity() public {
        _deposit(merchantA, DEP);
        _simulateLend(DEP);
        _expectRevertUnchanged(
            merchantA,
            _withdrawAllCall(),
            abi.encodeWithSelector(IIndicoLedger.InsufficientLiquidity.selector, DEP, 0)
        );
    }

    function test_withdrawAll_paused_revertsEnforcedPause() public {
        _deposit(merchantA, DEP);
        _pause();
        _expectRevertUnchanged(
            merchantA, _withdrawAllCall(), abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    function test_withdrawAll_blacklistedMerchant_fullRollback() public {
        _deposit(merchantA, DEP);
        usdc.blacklist(merchantA);
        _expectRevertUnchanged(
            merchantA,
            _withdrawAllCall(),
            abi.encodeWithSelector(MockUSDC.Blacklisted.selector, merchantA)
        );
    }

    /// @dev Cash short: the first withdrawAll pays all the cash and burns only the shares for
    ///      it; after the loan comes back, a second pays the rest. Exact here (price 1:1).
    function test_withdrawAll_shortOfCash_secondPaysRest() public {
        _deposit(merchantA, DEP);
        _simulateLend(700e6);

        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.Withdrawn(merchantA, 300e6, 300e6 * 1e6);
        _withdrawAll(merchantA);
        assertEq(ledger.shares(merchantA), 700e6 * 1e6);
        assertEq(ledger.poolUsdc(), 0);

        _simulateRepay(700e6);
        _withdrawAll(merchantA);
        assertEq(ledger.shares(merchantA), 0);
        assertEq(usdc.balanceOf(merchantA), FUND, "two payments are not the whole claim");
        _assertBooks();
    }

    /// @dev Same, with another holder and a loss making every division inexact: the two
    ///      payments add up to the full claim minus at most 2 wei, never more than it. If the
    ///      first payment's rounded-up burn leaves shares worth under 1 wei, the second
    ///      correctly reverts ZeroAmount (found by fuzzing, args [7, 6, 16395, 18]).
    function testFuzz_withdrawAll_shortOfCash_twoPaymentsWithinTwoWei(
        uint256 depA,
        uint256 depB,
        uint256 lent,
        uint256 lost
    ) public {
        depA = bound(depA, 2, FUND);
        depB = bound(depB, 1, FUND);
        _deposit(merchantA, depA);
        _deposit(merchantB, depB);
        lent = bound(lent, depB + 1, depA + depB); // cash left < depA
        lost = bound(lost, 0, lent - 1); // something comes back
        // A loss so large that A's claim no longer exceeds the cash is remapped to no loss.
        uint256 total = depA + depB;
        uint256 claimIf = LedgerMath.mulDivDown(depA * 1e6, total - lost + 1, total * 1e6 + 1e6);
        if (claimIf <= total - lent) lost = 0;
        _simulateLend(lent);
        _simulateDefault(lost);

        uint256 claim = _modelClaim(merchantA);
        uint256 cash = ledger.poolUsdc();
        assertLt(cash, claim, "cash not short");
        uint256 start = usdc.balanceOf(merchantA);

        if (cash == 0) {
            vm.expectRevert(
                abi.encodeWithSelector(IIndicoLedger.InsufficientLiquidity.selector, claim, 0)
            );
            _withdrawAll(merchantA);
        } else {
            _withdrawAll(merchantA);
            assertEq(usdc.balanceOf(merchantA), start + cash, "first did not pay the cash");
            assertGt(ledger.shares(merchantA), 0, "burned everything on a partial payment");
        }

        _simulateRepay(lent - lost);
        if (_modelClaim(merchantA) == 0) {
            // What is left is worth under 1 wei: correctly ZeroAmount, never a silent payment.
            vm.expectRevert(IIndicoLedger.ZeroAmount.selector);
            _withdrawAll(merchantA);
        } else {
            _withdrawAll(merchantA);
            assertEq(ledger.shares(merchantA), 0, "dust shares left");
        }
        uint256 paid = usdc.balanceOf(merchantA) - start;
        assertLe(paid, claim, "paid more than the claim");
        assertGe(paid + 2, claim, "lost more than 2 wei");
        _assertBooks();
    }

    // ================================================================== share price

    /// @dev At 1:1 every division is exact, so deposits and withdrawals leave the price
    ///      (A + 1) / (S + 1e6) exactly unchanged, compared by cross-multiplication.
    function test_sharePrice_unchangedByDepositAndWithdraw() public {
        _deposit(merchantA, DEP);
        (uint256 a0, uint256 s0) = (_modelAssets(), _modelShares());
        _deposit(merchantB, 333e6 + 7);
        assertEq(_modelAssets() * s0, a0 * _modelShares(), "deposit moved the price");
        _withdraw(merchantA, 123e6 + 5);
        assertEq(_modelAssets() * s0, a0 * _modelShares(), "withdraw moved the price");
        _withdrawAll(merchantB);
        assertEq(_modelAssets() * s0, a0 * _modelShares(), "withdrawAll moved the price");
    }

    /// @dev Two equal depositors, then a loss: each bears half, within 1 wei.
    function test_twoEqualDepositors_splitLossWithinOneWei() public {
        _deposit(merchantA, DEP);
        _deposit(merchantB, DEP);
        _simulateLend(301e6 + 1);
        _simulateDefault(301e6 + 1);
        uint256 a = _modelClaim(merchantA);
        uint256 b = _modelClaim(merchantB);
        assertEq(a, b);
        uint256 half = (2 * DEP - (301e6 + 1)) / 2;
        assertLe(a, half);
        assertGe(a + 1, half);
    }

    /// @dev Any two amounts, either order: neither gets back more than they put in, and
    ///      each gets back within 1 wei.
    function testFuzz_twoMerchants_anyOrder_neverOutMoreThanIn(uint256 a, uint256 b, bool aFirst)
        public
    {
        a = bound(a, 1, FUND);
        b = bound(b, 1, FUND);
        _deposit(merchantA, a);
        _deposit(merchantB, b);
        if (aFirst) {
            _withdrawAll(merchantA);
            _withdrawAll(merchantB);
        } else {
            _withdrawAll(merchantB);
            _withdrawAll(merchantA);
        }
        assertLe(usdc.balanceOf(merchantA), FUND);
        assertLe(usdc.balanceOf(merchantB), FUND);
        assertGe(usdc.balanceOf(merchantA) + 1, FUND);
        assertGe(usdc.balanceOf(merchantB) + 1, FUND);
        _assertBooks();
    }

    // ================================================================== direct transfers

    /// @dev Merchants use the block explorer, so some will `transfer` USDC to the ledger
    ///      instead of approve + deposit. Under D-38 that money is counted nowhere and is stuck
    ///      for good; the merchant guide warns about it first (O-032).
    function test_merchantDirectTransfer_isStuck_noShareNoPoolUsdcNoPriceChange() public {
        _deposit(merchantA, DEP);
        (uint256 a0, uint256 s0) = (_modelAssets(), _modelShares());
        Snapshot memory s = _snapshot();

        vm.prank(merchantB);
        usdc.transfer(address(ledger), 500e6);

        s.usdc[_index(merchantB)] -= 500e6;
        s.ledgerUsdc += 500e6;
        _assertUnchanged(s); // shares, totalShares and poolUsdc unchanged
        assertEq(_modelAssets(), a0, "price numerator moved");
        assertEq(_modelShares(), s0, "price denominator moved");
        assertEq(usdc.balanceOf(address(ledger)) - ledger.poolUsdc(), 500e6, "surplus");
        _assertBooks();

        _expectRevertUnchanged(
            merchantB, _withdrawAllCall(), abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector)
        );
        _withdrawAll(merchantA);
        assertEq(usdc.balanceOf(merchantA), FUND, "depositor got the transfer");
        assertEq(usdc.balanceOf(address(ledger)), 500e6, "surplus not stuck");
    }

    /// @dev Any amount, into an empty pool, a funded one, one with loans out, or one with a
    ///      loss: nothing but the two USDC balances moves.
    function testFuzz_directTransfer_movesNoClaimShareOrPrice(uint256 amount, uint8 state) public {
        amount = bound(amount, 1, FUND);
        state = uint8(bound(state, 0, 3));
        if (state >= 1) _deposit(merchantA, DEP);
        if (state >= 2) _simulateLend(DEP / 2);
        if (state == 3) _simulateDefault(DEP / 4);

        uint256 claim = _modelClaim(merchantA);
        uint256 held = usdc.balanceOf(address(ledger));
        _startDiff();
        vm.prank(alice);
        usdc.transfer(address(ledger), amount);
        Write[] memory w = new Write[](2); // the two USDC balances, nothing in the ledger
        w[0] = _w(address(usdc), _key(alice, SLOT_USDC_BALANCES), FUND - amount);
        w[1] = _w(address(usdc), _key(address(ledger), SLOT_USDC_BALANCES), held + amount);
        _assertWrites(w);
        assertEq(_modelClaim(merchantA), claim);
        _assertBooks();
    }

    // ================================================================== inflation attack

    /// @dev The classic attack: 1 wei deposit, a 1,000,000 USDC direct transfer, then a victim
    ///      deposits 1,000 USDC. Under contract-spec 5 as first written (balanceOf, no offset)
    ///      the victim would get floor(1e9 * 1 / (1e12 + 1)) = 0 shares and lose everything.
    function test_inflation_directTransfer_victimLosesNothing() public {
        address attacker = merchantB;
        address victim = merchantA;
        _deposit(attacker, 1);
        assertEq(ledger.shares(attacker), 1e6);
        vm.prank(attacker);
        usdc.transfer(address(ledger), 900_000e6);
        assertEq(ledger.poolUsdc(), 1, "transfer counted");
        (uint256 a0, uint256 s0) = (_modelAssets(), _modelShares());

        _deposit(victim, DEP);
        assertEq(ledger.shares(victim), 1e15);
        assertEq(_modelClaim(victim), DEP, "victim lost"); // 1e15 * (1e9 + 2) / (1e15 + 2e6)
        assertEq(_modelAssets() * s0, a0 * _modelShares(), "price moved");
        _assertBooks();

        _withdrawAll(victim);
        assertEq(usdc.balanceOf(victim), FUND, "victim not whole");
        _withdrawAll(attacker);
        assertEq(usdc.balanceOf(attacker), FUND - 900_000e6, "attacker recovered the transfer");
    }

    /// @dev Without any transfer: the attacker is the only depositor when a loss moves the
    ///      price off 1:1, then runs up to 40 deposit and withdraw steps chosen by `seed` to
    ///      raise it, then the victim deposits. The attacker never ends richer, and the victim
    ///      loses at most 1 wei plus a millionth of what the attacker spent (D-38).
    function testFuzz_inflation_roundingPumpAfterLoss_unprofitable(
        uint256 seed,
        uint256 first,
        uint256 victimAmount
    ) public {
        address attacker = merchantB;
        address victim = merchantA;
        first = bound(first, 1, 1_000e6);
        _deposit(attacker, first);
        uint256 lost = bound(seed, 0, first);
        _simulateLend(lost);
        _simulateDefault(lost);

        uint256 before = usdc.balanceOf(attacker) + _modelClaim(attacker);
        uint256 steps = bound(seed >> 8, 0, 40);
        for (uint256 i; i < steps; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            if (r % 2 == 0) {
                uint256 x = bound(r >> 1, 1, 2 * (ledger.poolUsdc() + 1));
                if (x > usdc.balanceOf(attacker)) x = usdc.balanceOf(attacker);
                vm.prank(attacker);
                try ledger.deposit(x) {} catch {}
            } else {
                // Up to the cash; above the claim it reverts and the step does nothing.
                uint256 x = bound(r >> 1, 1, ledger.poolUsdc() + 1);
                vm.prank(attacker);
                try ledger.withdraw(x) {} catch {}
            }
        }
        uint256 afterPump = usdc.balanceOf(attacker) + _modelClaim(attacker);
        assertLe(afterPump, before, "pump profited");

        victimAmount = bound(victimAmount, 1, FUND);
        vm.prank(victim);
        try ledger.deposit(victimAmount) {}
        catch {
            return; // ZeroShares: the victim kept their USDC, nothing lost
        }
        uint256 victimLoss = victimAmount - _modelClaim(victim);
        uint256 attackerAfter = usdc.balanceOf(attacker) + _modelClaim(attacker);
        assertLe(attackerAfter, before + victimLoss, "attacker gained beyond the victim's loss");
        assertLe(victimLoss, 1 + (before - afterPump) / 1e6, "victim lost more than the bound");
        _assertBooks();
    }

    // ================================================================== on real loans (O-033, P1.8)

    /// @dev A real loan lowers poolUsdc by the principal and leaves the share price alone.
    function test_realLoan_lowersPoolUsdc_priceUnchanged() public {
        _deposit(merchantA, DEP);
        (uint256 a0, uint256 s0) = (_modelAssets(), _modelShares());
        _mintCredit(alice, 750e6);
        vm.prank(alice);
        ledger.requestLoan(600e6);
        assertEq(ledger.poolUsdc(), DEP - 600e6);
        assertEq(ledger.totalLent(), 600e6);
        assertEq(_modelAssets() * s0, a0 * _modelShares(), "a loan moved the price");
        _assertBooks();
    }

    function test_realLoan_withdrawAboveCash_revertsInsufficientLiquidity() public {
        _deposit(merchantA, DEP);
        _mintCredit(alice, 750e6);
        vm.prank(alice);
        ledger.requestLoan(600e6);
        _expectRevertUnchanged(
            merchantA,
            _withdrawCall(400e6 + 1),
            abi.encodeWithSelector(IIndicoLedger.InsufficientLiquidity.selector, 400e6 + 1, 400e6)
        );
    }

    function test_realLoan_everythingLent_withdrawAllRevertsNoCash() public {
        _deposit(merchantA, DEP);
        _mintCredit(alice, 1_250e6);
        vm.prank(alice);
        ledger.requestLoan(DEP);
        _expectRevertUnchanged(
            merchantA,
            _withdrawAllCall(),
            abi.encodeWithSelector(IIndicoLedger.InsufficientLiquidity.selector, DEP, 0)
        );
    }

    /// @dev O-033 (P1.9 part): a real repayment raises `poolUsdc` by exactly the principal and
    ///      leaves the share price alone.
    function test_realLoan_repayRaisesPoolUsdcByPrincipal_priceUnchanged() public {
        _deposit(merchantA, DEP);
        _mintCredit(alice, 750e6);
        vm.prank(alice);
        ledger.requestLoan(600e6);
        (uint256 a0, uint256 s0) = (_modelAssets(), _modelShares());
        uint256 cash = ledger.poolUsdc();
        vm.prank(alice);
        ledger.repay(1);
        assertEq(ledger.poolUsdc(), cash + 600e6);
        assertEq(ledger.totalLent(), 0);
        assertEq(_modelAssets() * s0, a0 * _modelShares(), "a repayment moved the price");
        _assertBooks();
    }

    /// @dev O-033 (P1.9 part): `withdrawAll` short of cash pays the cash; after the real loan
    ///      is repaid, a second pays the rest. Exact here (price 1:1).
    function test_realLoan_withdrawAllShortOfCash_repay_secondPaysRest() public {
        _deposit(merchantA, DEP);
        _mintCredit(alice, 875e6);
        vm.prank(alice);
        ledger.requestLoan(700e6);

        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.Withdrawn(merchantA, DEP - 700e6, (DEP - 700e6) * 1e6);
        _withdrawAll(merchantA);
        assertEq(ledger.poolUsdc(), 0);

        vm.prank(alice);
        ledger.repay(1);
        _withdrawAll(merchantA);
        assertEq(ledger.shares(merchantA), 0);
        assertEq(usdc.balanceOf(merchantA), FUND, "two payments are not the whole claim");
        _assertBooks();
    }
}
