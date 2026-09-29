// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @dev Basis-point denominator.
uint256 constant BPS = 10_000;
/// @dev Loan to value, 80%. A compile-time constant because the figure is in a signed document.
uint256 constant LTV_BPS = 8_000;
/// @dev Loan term and extension length.
uint64 constant TERM = 90 days;
/// @dev `extend` is allowed only in the last `EXTENSION_WINDOW` before the due date, so
///      extensions are at least `TERM - EXTENSION_WINDOW` (60 days) apart.
uint64 constant EXTENSION_WINDOW = 30 days;
