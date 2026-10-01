// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @dev USDC decimals. Credit uses the same 6, so 1 credit = 1 USDC exactly.
uint256 constant USDC_DECIMALS = 6;
/// @dev Wait before a new top admin can accept the role (D-19).
uint48 constant ADMIN_TRANSFER_DELAY = 3 days;
/// @dev `participantRole` values (D-22). An address keeps the first role it is approved for.
uint8 constant ROLE_NONE = 0;
uint8 constant ROLE_USER = 1;
uint8 constant ROLE_MERCHANT = 2;
/// @dev Basis-point denominator.
uint256 constant BPS = 10_000;
/// @dev Loan to value, 80%. A compile-time constant because the figure is in a signed document.
uint256 constant LTV_BPS = 8_000;
/// @dev Loan term and extension length.
uint64 constant TERM = 90 days;
/// @dev `extend` is allowed only in the last `EXTENSION_WINDOW` before the due date, so
///      extensions are at least `TERM - EXTENSION_WINDOW` (60 days) apart.
uint64 constant EXTENSION_WINDOW = 30 days;
