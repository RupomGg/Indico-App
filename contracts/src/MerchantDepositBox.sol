// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MerchantDepositBox
/// @notice One merchant's deposit address (D-70). The merchant sends USDC here with an ordinary
///         wallet transfer; on `sweep` the ledger that created the box calls `release`, which
///         sends the whole balance to the ledger, and the ledger mints the shares to that merchant
///         only. Nobody else can move the box's USDC, and the box takes no ETH.
contract MerchantDepositBox {
    using SafeERC20 for IERC20;

    error NotLedger();

    IERC20 private immutable usdc;
    address private immutable ledger;

    constructor(IERC20 usdc_) {
        usdc = usdc_;
        ledger = msg.sender;
    }

    /// @notice Send everything in the box to the ledger. The ledger only.
    function release() external {
        if (msg.sender != ledger) revert NotLedger();
        usdc.safeTransfer(ledger, usdc.balanceOf(address(this)));
    }
}
