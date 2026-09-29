// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {Matrix} from "./Matrix.sol";

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
        _runAndCount(_dims(4, 3, 3, 3), "loan", 108);
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
}
