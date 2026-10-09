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
/// @dev A user wallet whose account moved to another wallet (D-64); never approved again.
uint8 constant ROLE_RETIRED = 3;
/// @dev Highest balance a mint may produce for one account (D-27): a technical bound so loan
///      fields (`uint128`) and `collateralFor` can never overflow, not a business limit.
uint256 constant CREDIT_CAP = type(uint128).max;
/// @dev Asset types 0 to 5 are valid (D-29): arbitration award, bill of exchange, promissory
///      note, bond, real estate, jewellery.
uint8 constant MAX_ASSET_TYPE = 5;
/// @dev Basis-point denominator.
uint256 constant BPS = 10_000;
/// @dev Loan to value, 80%. A compile-time constant because the figure is in a signed document.
uint256 constant LTV_BPS = 8_000;
/// @dev Loan term and extension length.
uint64 constant TERM = 90 days;
/// @dev `extend` is allowed only in the last `EXTENSION_WINDOW` before the due date, so
///      extensions are at least `TERM - EXTENSION_WINDOW` (60 days) apart.
uint64 constant EXTENSION_WINDOW = 30 days;
/// @dev After every unpause, no loan can be liquidated, and a loan that fell due during the
///      pause or this grace can still be extended, until this long has passed (D-54, D-55, D-58).
uint64 constant LIQUIDATION_GRACE = 7 days;
/// @dev Virtual shares and assets in every share conversion (D-38): no division by zero, and a
///      price raised by rounding costs the attacker about 10^6 times what a victim loses.
uint256 constant VIRTUAL_SHARES = 1e6;
uint256 constant VIRTUAL_ASSETS = 1;
