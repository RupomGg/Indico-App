// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice USDC stand-in, 6 decimals, with the four misbehaviours the test plan needs.
///         Every flag is off by default, so a fresh instance behaves like plain USDC.
contract MockUSDC is ERC20 {
    error Blacklisted(address account);

    mapping(address => bool) public isBlacklisted;
    /// @dev Fee-on-transfer in basis points, burned from the amount sent.
    uint16 public feeBps;
    /// @dev When set, `transfer` and `transferFrom` return false and move nothing.
    bool public returnsFalse;
    /// @dev When set, every transfer between two accounts calls `reentrantTarget` with
    ///      `reentrantData` after moving the tokens, and bubbles any revert.
    address public reentrantTarget;
    bytes public reentrantData;
    bool private _inCallback;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // ------------------------------------------------------------------ feature flags

    /// @notice Like real USDC: a blacklisted account can neither send nor receive.
    function blacklist(address account) external {
        isBlacklisted[account] = true;
    }

    function setFeeBps(uint16 bps) external {
        require(bps <= 10_000, "fee > 100%");
        feeBps = bps;
    }

    function setReturnsFalse(bool value) external {
        returnsFalse = value;
    }

    /// @notice `target = address(0)` disarms the callback.
    function setReentrantTarget(address target, bytes calldata data) external {
        reentrantTarget = target;
        reentrantData = data;
    }

    // ------------------------------------------------------------------ behaviour

    function transfer(address to, uint256 value) public override returns (bool) {
        if (returnsFalse) return false;
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (returnsFalse) return false;
        return super.transferFrom(from, to, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (isBlacklisted[from]) revert Blacklisted(from);
        if (isBlacklisted[to]) revert Blacklisted(to);

        if (from == address(0) || to == address(0)) return super._update(from, to, value);

        uint256 fee = value * feeBps / 10_000;
        super._update(from, to, value - fee);
        if (fee > 0) super._update(from, address(0), fee);

        // One level deep: the callback's own transfers do not re-trigger it.
        if (reentrantTarget != address(0) && !_inCallback) {
            _inCallback = true;
            (bool ok, bytes memory ret) = reentrantTarget.call(reentrantData);
            _inCallback = false;
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}
