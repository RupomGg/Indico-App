// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIndicoLedger} from "./interfaces/IIndicoLedger.sol";
import {USDC_DECIMALS} from "./lib/Constants.sol";

/// @title IndicoLedger
/// @notice Credit, spending, the USDC pool and every loan, in one contract deployed once.
/// @dev docs/contract-spec.md. Built portion by portion; functions not yet implemented are
///      absent, so calls to them revert. Inherits `IIndicoLedger` once every function exists.
contract IndicoLedger is AccessControl, Pausable {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ---------------------------------------------------------------------------------------
    // State, contract-spec section 4. Declared in full so the storage layout is fixed once
    // (D-17). Each variable is written and tested by the portion that implements it. Scalars
    // nothing writes yet carry a lint suppression that their portion deletes (D-18).
    // ---------------------------------------------------------------------------------------

    struct Loan {
        address borrower;
        uint64 dueDate;
        uint16 extensionCount;
        uint8 status;
        uint128 principal;
        uint128 collateral;
    }

    IERC20 public immutable usdc;

    // forge-lint: disable-next-line(uninitialized-state)
    bytes32 public termsHash;

    mapping(address => bool) public approvedUser;
    mapping(address => bool) public approvedMerchant;
    mapping(address => bool) public termsSigned;

    mapping(address => uint256) public credit;
    mapping(address => uint256) public lockedCredit;
    // forge-lint: disable-next-line(uninitialized-state)
    uint256 public totalCredit;
    // forge-lint: disable-next-line(uninitialized-state)
    uint256 public poolCredit;

    mapping(bytes32 => bool) public assetRegistered;

    mapping(address => uint256) public shares;
    // forge-lint: disable-next-line(uninitialized-state)
    uint256 public totalShares;
    // forge-lint: disable-next-line(uninitialized-state)
    uint256 public totalLent;

    // forge-lint: disable-next-line(uninitialized-state)
    uint256 public nextLoanId;
    mapping(uint256 => Loan) public loans;

    // ---------------------------------------------------------------------------------------
    // Constructor, contract-spec 6.0
    // ---------------------------------------------------------------------------------------

    /// @dev `usdc_` must be a contract whose `decimals()` returns exactly 6 (D-16). Read with a
    ///      low-level call so every malformed answer is a named revert, never a decode panic.
    ///      `admin_ == guardian_` is allowed (D-15).
    constructor(IERC20 usdc_, address admin_, address guardian_) {
        if (address(usdc_) == address(0) || admin_ == address(0) || guardian_ == address(0)) {
            revert IIndicoLedger.ZeroAddress();
        }
        if (address(usdc_).code.length == 0) revert IIndicoLedger.UsdcNotAContract(address(usdc_));

        (bool ok, bytes memory data) =
            address(usdc_).staticcall(abi.encodeCall(IERC20Metadata.decimals, ()));
        if (!ok || data.length < 32) revert IIndicoLedger.UsdcDecimalsUnreadable(address(usdc_));
        uint256 decimals = abi.decode(data, (uint256));
        if (decimals != USDC_DECIMALS) revert IIndicoLedger.UsdcWrongDecimals(decimals);

        usdc = usdc_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
        _grantRole(GUARDIAN_ROLE, guardian_);
    }

    // ---------------------------------------------------------------------------------------
    // Administration, contract-spec 6.1
    // ---------------------------------------------------------------------------------------

    /// @notice Stop every `whenNotPaused` function. Reverts `EnforcedPause` if already paused.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /// @notice Resume normal operation. Reverts `ExpectedPause` if not paused.
    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }
}
