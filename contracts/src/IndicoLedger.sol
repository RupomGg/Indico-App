// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIndicoLedger} from "./interfaces/IIndicoLedger.sol";
import {
    ADMIN_TRANSFER_DELAY,
    USDC_DECIMALS,
    ROLE_NONE,
    ROLE_USER,
    ROLE_MERCHANT
} from "./lib/Constants.sol";

/// @title IndicoLedger
/// @notice Credit, spending, the USDC pool and every loan, in one contract deployed once.
/// @dev docs/contract-spec.md. Built portion by portion; functions not yet implemented are
///      absent, so calls to them revert. Inherits `IIndicoLedger` once every function exists.
contract IndicoLedger is AccessControlDefaultAdminRules, Pausable {
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

    bytes32 public termsHash;

    mapping(address => bool) public approvedUser;
    mapping(address => bool) public approvedMerchant;
    mapping(address => bool) public termsSigned;
    /// @dev The terms version each address signed most recently (D-25).
    mapping(address => bytes32) public signedTermsHash;
    /// @dev First role an address was approved for, never cleared (D-22).
    mapping(address => uint8) public participantRole;

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

    /// @dev `admin_` becomes the single `DEFAULT_ADMIN_ROLE` holder, transferable only in two
    ///      steps with `ADMIN_TRANSFER_DELAY` between them (D-19). It reaches the base
    ///      constructor through `_checkedAdmin`, so the ledger's own checks run first and a zero
    ///      `admin_` reverts `ZeroAddress`, never OpenZeppelin's `AccessControlInvalidDefaultAdmin`.
    constructor(IERC20 usdc_, address admin_, address guardian_)
        AccessControlDefaultAdminRules(
            ADMIN_TRANSFER_DELAY, _checkedAdmin(usdc_, admin_, guardian_)
        )
    {
        usdc = usdc_;
        _grantRole(ADMIN_ROLE, admin_);
        _grantRole(GUARDIAN_ROLE, guardian_);
    }

    /// @dev Every constructor check, returning `admin_` unchanged. `usdc_` must be a contract
    ///      whose `decimals()` returns exactly 6 (D-16), read with a low-level call so every
    ///      malformed answer is a named revert, never a decode panic. `admin_ == guardian_` is
    ///      allowed (D-15).
    function _checkedAdmin(IERC20 usdc_, address admin_, address guardian_)
        private
        view
        returns (address)
    {
        if (address(usdc_) == address(0) || admin_ == address(0) || guardian_ == address(0)) {
            revert IIndicoLedger.ZeroAddress();
        }
        if (address(usdc_).code.length == 0) revert IIndicoLedger.UsdcNotAContract(address(usdc_));

        (bool ok, bytes memory data) =
            address(usdc_).staticcall(abi.encodeCall(IERC20Metadata.decimals, ()));
        if (!ok || data.length < 32) revert IIndicoLedger.UsdcDecimalsUnreadable(address(usdc_));
        uint256 decimals = abi.decode(data, (uint256));
        if (decimals != USDC_DECIMALS) revert IIndicoLedger.UsdcWrongDecimals(decimals);

        return admin_;
    }

    // ---------------------------------------------------------------------------------------
    // Administration, contract-spec 6.1
    // ---------------------------------------------------------------------------------------

    /// @notice Set the hash of the current terms. Existing signatures are not cleared.
    /// @dev Not `whenNotPaused` (D-24). Zero is "never set" and is refused (D-21); repeating the
    ///      current hash is allowed and emits again (D-20).
    function setTermsHash(bytes32 newHash) external onlyRole(ADMIN_ROLE) {
        if (newHash == bytes32(0)) revert IIndicoLedger.ZeroTermsHash();
        termsHash = newHash;
        emit IIndicoLedger.TermsHashSet(newHash);
    }

    /// @notice Approve or revoke a user. Revocation blocks new actions only; balances and
    ///         loans are untouched.
    /// @dev Not `whenNotPaused` (D-24). Repeats are allowed and emit (D-20).
    function setUserApproved(address user, bool approved) external onlyRole(ADMIN_ROLE) {
        _admit(user, approved, ROLE_USER);
        approvedUser[user] = approved;
        emit IIndicoLedger.UserApprovalSet(user, approved);
    }

    /// @notice Approve or revoke a merchant. A revoked merchant can still withdraw.
    /// @dev Not `whenNotPaused` (D-24). Repeats are allowed and emit (D-20).
    function setMerchantApproved(address m, bool approved) external onlyRole(ADMIN_ROLE) {
        _admit(m, approved, ROLE_MERCHANT);
        approvedMerchant[m] = approved;
        emit IIndicoLedger.MerchantApprovalSet(m, approved);
    }

    /// @dev Zero is never valid. An approval also refuses the ledger and USDC addresses (D-23)
    ///      and an address first approved in the other role (D-22), and records the role the
    ///      first time. A revoke never sets the role.
    function _admit(address account, bool approved, uint8 role) private {
        if (account == address(0)) revert IIndicoLedger.ZeroAddress();
        if (!approved) return;
        if (account == address(this) || account == address(usdc)) {
            revert IIndicoLedger.InvalidParticipant(account);
        }
        uint8 current = participantRole[account];
        if (current == ROLE_NONE) participantRole[account] = role;
        else if (current != role) revert IIndicoLedger.ParticipantRoleConflict(account);
    }

    // ---------------------------------------------------------------------------------------
    // Terms, contract-spec 6.2
    // ---------------------------------------------------------------------------------------

    /// @notice Record that the caller accepted the terms identified by `acceptedHash`.
    /// @dev No approval check: an address may sign while it waits to be approved (6.2). The
    ///      caller is the signer, because the transaction is signed by its wallet (D-08).
    ///      `acceptedHash` must equal the current hash, so nobody is recorded as accepting a
    ///      version they never saw. A newer version may be signed again (D-25).
    ///      `block.timestamp` is emitted as a record only (D-26).
    function signTerms(bytes32 acceptedHash) external whenNotPaused {
        bytes32 current = termsHash;
        if (current == bytes32(0)) revert IIndicoLedger.TermsNotSet();
        if (acceptedHash != current) revert IIndicoLedger.WrongTermsHash();
        if (signedTermsHash[msg.sender] == current) revert IIndicoLedger.AlreadySigned();

        termsSigned[msg.sender] = true;
        signedTermsHash[msg.sender] = current;
        emit IIndicoLedger.TermsSigned(msg.sender, current, block.timestamp);
    }

    /// @notice Stop every `whenNotPaused` function. Reverts `EnforcedPause` if already paused.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /// @notice Resume normal operation. Reverts `ExpectedPause` if not paused.
    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }
}
