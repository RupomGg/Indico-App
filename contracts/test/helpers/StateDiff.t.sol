// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {Actors} from "./Actors.sol";

/// @notice The state-diff helpers (D-43) and the storage slot constants they rely on.
///
/// | Helper / input                                        | Expected                         |
/// |-------------------------------------------------------|----------------------------------|
/// | slot constants vs the public getters, every variable  | `vm.load` equals the getter      |
/// | `_assertNoChange` after a reverted call               | passes                           |
/// | a write made before the revert (undone by the EVM)    | passes, through `_revertsUnchanged` |
/// | `_assertNoChange` after a call that wrote state       | fails                            |
/// | `_assertNoChange` after a call that moved ETH         | fails                            |
/// | `_assertWrites` with exactly the net writes           | passes                           |
/// | `_assertWrites` missing one write                     | fails                            |
/// | `_assertWrites` with one extra expected write         | fails                            |
/// | `_assertWrites` with a wrong value                    | fails                            |
/// | a slot written then restored in the same call         | not a net change                 |
/// | a write inside a reverted inner call                  | not a net change                 |
contract StateDiffTest is Actors {
    bytes32 internal constant DOC = keccak256("state-diff-doc");

    // ------------------------------------------------------------------ slot constants

    /// @dev Every constant checked against its getter, with non-zero values in every slot.
    function test_slotConstants_matchGetters() public {
        _mintCredit(alice, 7e6);
        vm.prank(alice);
        ledger.registerAsset(DOC, 0, 3e6);
        _deposit(merchantA, 5e6);
        vm.warp(1_800_000_000);
        vm.prank(alice);
        ledger.requestLoan(1e6); // loan 1: lockedCredit, totalLent, nextLoanId, loans
        _pause();

        address l = address(ledger);
        assertEq(uint256(vm.load(l, bytes32(SLOT_PAUSED))) & 0xff, 1, "paused");
        assertEq(vm.load(l, bytes32(SLOT_TERMS_HASH)), ledger.termsHash(), "termsHash");
        assertEq(_u(l, _key(alice, SLOT_APPROVED_USER)), 1, "approvedUser");
        assertEq(_u(l, _key(merchantA, SLOT_APPROVED_MERCHANT)), 1, "approvedMerchant");
        assertEq(_u(l, _key(alice, SLOT_TERMS_SIGNED)), 1, "termsSigned");
        assertEq(vm.load(l, _key(alice, SLOT_SIGNED_TERMS_HASH)), TERMS, "signedTermsHash");
        assertEq(_u(l, _key(alice, SLOT_PARTICIPANT_ROLE)), 1, "participantRole user");
        assertEq(_u(l, _key(merchantA, SLOT_PARTICIPANT_ROLE)), 2, "participantRole merchant");
        assertEq(_u(l, _key(alice, SLOT_CREDIT)), ledger.credit(alice), "credit");
        assertEq(_u(l, bytes32(SLOT_TOTAL_CREDIT)), ledger.totalCredit(), "totalCredit");
        assertEq(_u(l, _key(DOC, SLOT_ASSET_REGISTERED)), 1, "assetRegistered");
        assertEq(_u(l, _key(merchantA, SLOT_SHARES)), ledger.shares(merchantA), "shares");
        assertEq(_u(l, bytes32(SLOT_TOTAL_SHARES)), ledger.totalShares(), "totalShares");
        assertEq(_u(l, bytes32(SLOT_POOL_USDC)), ledger.poolUsdc(), "poolUsdc");
        assertEq(_u(address(usdc), _key(alice, SLOT_USDC_BALANCES)), usdc.balanceOf(alice), "usdc");

        assertEq(_u(l, bytes32(SLOT_TOTAL_LENT)), ledger.totalLent(), "totalLent");
        assertEq(ledger.totalLent(), 1e6, "totalLent written");
        assertEq(_u(l, _key(alice, SLOT_LOCKED_CREDIT)), ledger.lockedCredit(alice), "lockedCredit");
        assertEq(ledger.lockedCredit(alice), 1.25e6, "lockedCredit written");
        assertEq(_u(l, bytes32(SLOT_NEXT_LOAN_ID)), ledger.nextLoanId(), "nextLoanId");
        assertEq(ledger.nextLoanId(), 1);
        bytes32 loan1 = keccak256(abi.encode(uint256(1), SLOT_LOANS));
        (address b, uint64 due,,, uint128 pr, uint128 col) = ledger.loans(1);
        assertEq(_u(l, loan1), uint256(uint160(b)) | (uint256(due) << 160), "loans slot 0");
        assertEq(
            _u(l, bytes32(uint256(loan1) + 1)), uint256(pr) | (uint256(col) << 128), "loans slot 1"
        );
        assertEq(b, alice, "loans.borrower");

        // lastPausedAt in the low 64 bits, lastUnpausedAt in the next 64 (D-58).
        uint256 times = _u(l, bytes32(SLOT_PAUSE_TIMES));
        assertEq(uint64(times), ledger.lastPausedAt(), "lastPausedAt");
        assertEq(ledger.lastPausedAt(), 1_800_000_000, "lastPausedAt written");
        vm.warp(1_800_000_100);
        vm.prank(guardian);
        ledger.unpause();
        times = _u(l, bytes32(SLOT_PAUSE_TIMES));
        assertEq(uint64(times >> 64), ledger.lastUnpausedAt(), "lastUnpausedAt");
        assertEq(ledger.lastUnpausedAt(), 1_800_000_100, "lastUnpausedAt written");

        // poolCredit is written only by liquidate: checked by writing and reading back.
        vm.store(l, bytes32(SLOT_POOL_CREDIT), bytes32(uint256(11)));
        assertEq(ledger.poolCredit(), 11, "poolCredit");
    }

    function _u(address account, bytes32 slot) internal view returns (uint256) {
        return uint256(vm.load(account, slot));
    }

    // ------------------------------------------------------------------ the helpers

    function test_noChange_afterRevert_passes() public {
        _revertsUnchanged(
            makeAddr("nobody"),
            abi.encodeCall(IIndicoLedger.spend, (merchantA, 1)),
            abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
        );
    }

    /// @dev `registerAsset` marks the hash, then the mint reverts on the cap: the EVM undoes the
    ///      mark. Through a low-level call the diff sees that write as reverted, so no change.
    function test_noChange_writeBeforeRevert_passes() public {
        uint256 v = type(uint128).max + uint256(1);
        _revertsUnchanged(
            alice,
            abi.encodeCall(IIndicoLedger.registerAsset, (DOC, 0, v)),
            abi.encodeWithSelector(IIndicoLedger.CreditCapExceeded.selector, v, type(uint128).max)
        );
        assertFalse(ledger.assetRegistered(DOC));
    }

    function test_noChange_afterWrite_fails() public {
        vm.expectRevert();
        this.noChangeAfterWrite();
    }

    function noChangeAfterWrite() external {
        _startDiff();
        _mintCredit(alice, 1);
        _assertNoChange();
    }

    function test_noChange_afterEthMove_fails() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert();
        this.noChangeAfterEthMove();
    }

    function noChangeAfterEthMove() external {
        _startDiff();
        (bool ok,) = payable(makeAddr("ethSink")).call{value: 1}("");
        assertTrue(ok);
        _assertNoChange();
    }

    function test_writes_exact_passes() public {
        _startDiff();
        _mintCredit(alice, 5e6);
        Write[] memory w = new Write[](2);
        w[0] = _w(address(ledger), _key(alice, SLOT_CREDIT), 5e6);
        w[1] = _w(address(ledger), bytes32(SLOT_TOTAL_CREDIT), 5e6);
        _assertWrites(w);
    }

    function test_writes_missingOne_fails() public {
        vm.expectRevert();
        this.writesMissingOne();
    }

    function writesMissingOne() external {
        _startDiff();
        _mintCredit(alice, 5e6);
        Write[] memory w = new Write[](1);
        w[0] = _w(address(ledger), _key(alice, SLOT_CREDIT), 5e6);
        _assertWrites(w);
    }

    function test_writes_extraExpected_fails() public {
        vm.expectRevert();
        this.writesExtraExpected();
    }

    function writesExtraExpected() external {
        _startDiff();
        _mintCredit(alice, 5e6);
        Write[] memory w = new Write[](3);
        w[0] = _w(address(ledger), _key(alice, SLOT_CREDIT), 5e6);
        w[1] = _w(address(ledger), bytes32(SLOT_TOTAL_CREDIT), 5e6);
        w[2] = _w(address(ledger), bytes32(SLOT_POOL_CREDIT), 1);
        _assertWrites(w);
    }

    function test_writes_wrongValue_fails() public {
        vm.expectRevert();
        this.writesWrongValue();
    }

    function writesWrongValue() external {
        _startDiff();
        _mintCredit(alice, 5e6);
        Write[] memory w = new Write[](2);
        w[0] = _w(address(ledger), _key(alice, SLOT_CREDIT), 5e6 + 1);
        w[1] = _w(address(ledger), bytes32(SLOT_TOTAL_CREDIT), 5e6);
        _assertWrites(w);
    }

    /// @dev `deposit` sets the reentrancy guard's lock and clears it again: not a net change, so
    ///      only the pool's own slots and the two USDC balances appear.
    function test_writes_restoredSlot_notCounted() public {
        _startDiff();
        _deposit(merchantA, 5e6);
        Write[] memory w = new Write[](5);
        w[0] = _w(address(ledger), _key(merchantA, SLOT_SHARES), 5e12);
        w[1] = _w(address(ledger), bytes32(SLOT_TOTAL_SHARES), 5e12);
        w[2] = _w(address(ledger), bytes32(SLOT_POOL_USDC), 5e6);
        w[3] = _w(address(usdc), _key(merchantA, SLOT_USDC_BALANCES), FUND - 5e6);
        w[4] = _w(address(usdc), _key(address(ledger), SLOT_USDC_BALANCES), 5e6);
        _assertWrites(w);
    }

    /// @dev A write inside an inner call that reverts, caught by the outer frame, never lands.
    function test_writes_revertedInnerCall_notCounted() public {
        _startDiff();
        try this.mintThenRevert() {} catch {}
        _assertNoChange();
    }

    function mintThenRevert() external {
        _mintCredit(alice, 1);
        revert("undo");
    }
}
