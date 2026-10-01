// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {Matrix} from "./Matrix.sol";
import {EXTENSION_WINDOW} from "../../src/lib/Constants.sol";

/// @dev Callback target for the reentrancy flag.
contract Recorder {
    uint256 public calls;

    function hit() external {
        ++calls;
    }

    function boom() external pure {
        revert("boom");
    }
}

/// @notice Self-checks for the helpers the whole suite relies on. None need the ledger.
contract HelpersTest is Matrix {
    MockUSDC internal usdc;
    address internal a = makeAddr("a");
    address internal b = makeAddr("b");

    uint256 internal dirty;

    function setUp() public {
        usdc = new MockUSDC();
        usdc.mint(a, 1_000e6);
    }

    // ------------------------------------------------------------------ MockUSDC

    function test_mock_plainByDefault() public {
        assertEq(usdc.decimals(), 6);
        vm.prank(a);
        assertTrue(usdc.transfer(b, 100e6));
        assertEq(usdc.balanceOf(b), 100e6);
    }

    function test_mock_blacklistBlocksSendAndReceive() public {
        usdc.blacklist(b);
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blacklisted.selector, b));
        usdc.transfer(b, 1);

        usdc.mint(address(this), 1);
        usdc.blacklist(address(this));
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blacklisted.selector, address(this)));
        usdc.transfer(a, 1);
    }

    function test_mock_feeOnTransferDeliversLess() public {
        usdc.setFeeBps(100);
        uint256 supply = usdc.totalSupply();
        vm.prank(a);
        usdc.transfer(b, 100e6);
        assertEq(usdc.balanceOf(b), 99e6);
        assertEq(usdc.balanceOf(a), 900e6);
        assertEq(usdc.totalSupply(), supply - 1e6);
    }

    function test_mock_feeAbove100PercentRejected() public {
        vm.expectRevert(bytes("fee > 100%"));
        usdc.setFeeBps(10_001);
    }

    function test_mock_returnsFalseMovesNothing() public {
        usdc.setReturnsFalse(true);
        vm.prank(a);
        assertFalse(usdc.transfer(b, 1));
        vm.prank(a);
        usdc.approve(address(this), 1);
        assertFalse(usdc.transferFrom(a, b, 1));
        assertEq(usdc.balanceOf(b), 0);
    }

    function test_mock_reentrantCallbackFiresOncePerTransfer() public {
        Recorder r = new Recorder();
        usdc.setReentrantTarget(address(r), abi.encodeCall(Recorder.hit, ()));
        vm.prank(a);
        usdc.transfer(b, 1);
        assertEq(r.calls(), 1);
        usdc.mint(a, 1); // mints do not trigger it
        assertEq(r.calls(), 1);
    }

    function test_mock_reentrantCallbackRevertBubbles() public {
        Recorder r = new Recorder();
        usdc.setReentrantTarget(address(r), abi.encodeCall(Recorder.boom, ()));
        vm.prank(a);
        vm.expectRevert(bytes("boom"));
        usdc.transfer(b, 1);
    }

    // ------------------------------------------------------------------ Matrix
    // Chain state is reverted after every cell, so the checks keep their bookkeeping in
    // environment variables, which survive `revertToState`.

    function test_crossProduct_everyCellOnceFromCleanState() public {
        _runAndCount(_loanDims(), "loan", 180);
        _runAndCount(_dims(9, 13), "participant", 117);
        _runAndCount(_dims(6, 4), "pool", 24);
    }

    function _runAndCount(uint256[] memory dims, string memory tag, uint256 expected) internal {
        vm.setEnv("MATRIX_TAG", tag);
        vm.setEnv("MATRIX_VISITS", "0");
        _crossProduct(dims, _recordCell);
        assertEq(vm.envUint("MATRIX_VISITS"), expected, tag);
        assertEq(dirty, 0, "cell state leaked out of the matrix");
    }

    function _recordCell(uint256[] memory c) internal {
        assertEq(dirty, 0, "previous cell leaked state");
        dirty = 1;
        string memory key = string.concat(
            "CELL_", vm.envString("MATRIX_TAG"), "_", vm.toString(keccak256(abi.encode(c)))
        );
        assertFalse(vm.envOr(key, false), "cell visited twice");
        vm.setEnv(key, "true");
        vm.setEnv("MATRIX_VISITS", vm.toString(vm.envUint("MATRIX_VISITS") + 1));
    }

    // ------------------------------------------------------------------ Loan time axis
    // Partition table for _loanTimeAt(uint256 t, uint64 dueDate), docs/input-testing.md 2.1, D-13.
    //
    // | Param   | Class                          | Value                     | Expected                          |
    // |---------|--------------------------------|---------------------------|-----------------------------------|
    // | t       | each valid point               | 0, 1, 2, 3, 4             | exact timestamp, see below        |
    // | t       | one past the end               | 5                         | LoanTimeOutOfRange(5)             |
    // | t       | uint256 max                    | type(uint256).max         | LoanTimeOutOfRange(max)           |
    // | dueDate | zero                           | 0                         | DueDateBeforeWindow(0)            |
    // | dueDate | exactly the window             | EXTENSION_WINDOW          | DueDateBeforeWindow(window)       |
    // | dueDate | smallest that fits             | EXTENSION_WINDOW + 1      | beforeWindow is 0                 |
    // | dueDate | typical                        | 1_700_000_000 + 90 days   | five exact points                 |
    // | dueDate | uint64 max                     | type(uint64).max          | afterDue is 2**64, no overflow    |
    // | both    | t and dueDate invalid together | 5, 0                      | LoanTimeOutOfRange(5), t first    |
    //
    // Points: 0 dueDate - W - 1, 1 dueDate - W, 2 dueDate - W / 2, 3 dueDate, 4 dueDate + 1,
    // where W is EXTENSION_WINDOW. The return type is uint256, so dueDate + 1 cannot overflow:
    // the largest result is 2**64.

    function loanTimeAt(uint256 t, uint64 dueDate) external pure returns (uint256) {
        return _loanTimeAt(t, dueDate);
    }

    function test_loanDims_is4x3x3x5() public pure {
        uint256[] memory d = _loanDims();
        assertEq(d.length, 4);
        assertEq(d[0], 4, "states");
        assertEq(d[1], 3, "actions");
        assertEq(d[2], 3, "callers");
        assertEq(d[3], 5, "times");
        assertEq(LOAN_TIMES, 5);
    }

    function test_loanTime_typicalDueDate_fiveExactPoints() public pure {
        uint64 due = 1_700_000_000 + 90 days;
        assertEq(_loanTimeAt(0, due), uint256(due) - 30 days - 1, "beforeWindow");
        assertEq(_loanTimeAt(1, due), uint256(due) - 30 days, "windowOpens");
        assertEq(_loanTimeAt(2, due), uint256(due) - 15 days, "insideWindow");
        assertEq(_loanTimeAt(3, due), uint256(due), "exactlyDue");
        assertEq(_loanTimeAt(4, due), uint256(due) + 1, "afterDue");
    }

    function test_loanTime_smallestDueDate_beforeWindowIsZero() public pure {
        uint64 due = EXTENSION_WINDOW + 1;
        assertEq(_loanTimeAt(0, due), 0);
        assertEq(_loanTimeAt(1, due), 1);
        assertEq(_loanTimeAt(4, due), uint256(EXTENSION_WINDOW) + 2);
    }

    function test_loanTime_uint64MaxDueDate_afterDueIs2Pow64() public pure {
        uint64 due = type(uint64).max;
        assertEq(_loanTimeAt(3, due), uint256(type(uint64).max));
        assertEq(_loanTimeAt(4, due), uint256(1) << 64);
    }

    function test_loanTime_indexPastEnd_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(LoanTimeOutOfRange.selector, 5));
        this.loanTimeAt(5, 1_700_000_000);
    }

    function test_loanTime_indexUint256Max_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(LoanTimeOutOfRange.selector, type(uint256).max));
        this.loanTimeAt(type(uint256).max, 1_700_000_000);
    }

    function test_loanTime_dueDateZero_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(DueDateBeforeWindow.selector, 0));
        this.loanTimeAt(0, 0);
    }

    function test_loanTime_dueDateExactlyWindow_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(DueDateBeforeWindow.selector, EXTENSION_WINDOW));
        this.loanTimeAt(4, EXTENSION_WINDOW);
    }

    function test_loanTime_bothInvalid_indexCheckedFirst() public {
        vm.expectRevert(abi.encodeWithSelector(LoanTimeOutOfRange.selector, 5));
        this.loanTimeAt(5, 0);
    }

    function testFuzz_loanTime_strictlyIncreasingAndExact(uint64 due) public pure {
        due = uint64(bound(due, uint256(EXTENSION_WINDOW) + 1, type(uint64).max));
        uint256 w = EXTENSION_WINDOW;
        assertEq(_loanTimeAt(0, due), due - w - 1);
        assertEq(_loanTimeAt(1, due), due - w);
        assertEq(_loanTimeAt(2, due), due - w / 2);
        assertEq(_loanTimeAt(3, due), due);
        assertEq(_loanTimeAt(4, due), uint256(due) + 1);
        for (uint256 t = 1; t < LOAN_TIMES; ++t) {
            assertGt(_loanTimeAt(t, due), _loanTimeAt(t - 1, due));
        }
    }

    function testFuzz_loanTime_dueDateInsideWindow_alwaysNamedRevert(uint64 due, uint256 t) public {
        due = uint64(bound(due, 0, EXTENSION_WINDOW));
        t = bound(t, 0, LOAN_TIMES - 1);
        vm.expectRevert(abi.encodeWithSelector(DueDateBeforeWindow.selector, due));
        this.loanTimeAt(t, due);
    }

    function testFuzz_loanTime_indexOutOfRange_alwaysNamedRevert(uint256 t, uint64 due) public {
        t = bound(t, LOAN_TIMES, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(LoanTimeOutOfRange.selector, t));
        this.loanTimeAt(t, due);
    }
}
