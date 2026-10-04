// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIndicoLedger} from "./interfaces/IIndicoLedger.sol";
import {LedgerMath} from "./lib/Math.sol";
import {
    ADMIN_TRANSFER_DELAY,
    USDC_DECIMALS,
    ROLE_NONE,
    ROLE_USER,
    ROLE_MERCHANT,
    CREDIT_CAP,
    MAX_ASSET_TYPE,
    VIRTUAL_SHARES,
    VIRTUAL_ASSETS
} from "./lib/Constants.sol";

/// @title IndicoLedger
/// @notice Credit, spending, the USDC pool and every loan, in one contract deployed once.
/// @dev docs/contract-spec.md. Built portion by portion; functions not yet implemented are
///      absent, so calls to them revert. Inherits `IIndicoLedger` once every function exists.
contract IndicoLedger is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

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
    // Read before P1.8 first writes it (requestLoan), correctly 0 until then (D-34).
    // slither-disable-next-line uninitialized-state
    mapping(address => uint256) public lockedCredit;
    uint256 public totalCredit;
    // forge-lint: disable-next-line(uninitialized-state)
    uint256 public poolCredit;

    mapping(bytes32 => bool) public assetRegistered;

    mapping(address => uint256) public shares;
    uint256 public totalShares;
    // Read by the pool from P1.7, first written by requestLoan in P1.8, 0 until then (D-40).
    // slither-disable-start uninitialized-state
    // forge-lint: disable-next-line(uninitialized-state)
    uint256 public totalLent;
    // slither-disable-end uninitialized-state
    /// @dev The pool's own count of the USDC it holds, never `usdc.balanceOf` (D-38).
    uint256 public poolUsdc;

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
        // Linter cannot match an event to a mapping write; UserApprovalSet follows (D-30).
        // forge-lint: disable-next-line(missing-events-access-control)
        approvedUser[user] = approved;
        emit IIndicoLedger.UserApprovalSet(user, approved);
    }

    /// @notice Approve or revoke a merchant. A revoked merchant can still withdraw.
    /// @dev Not `whenNotPaused` (D-24). Repeats are allowed and emit (D-20).
    function setMerchantApproved(address m, bool approved) external onlyRole(ADMIN_ROLE) {
        _admit(m, approved, ROLE_MERCHANT);
        // Linter cannot match an event to a mapping write; MerchantApprovalSet follows (D-30).
        // forge-lint: disable-next-line(missing-events-access-control)
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

    // ---------------------------------------------------------------------------------------
    // Assets and credit, contract-spec 6.3
    // ---------------------------------------------------------------------------------------

    /// @notice Register a document fingerprint and mint `value` credit to the caller.
    /// @dev Only the hash, type and value go on chain; nothing reads the document (A-10). The
    ///      credit joins one fungible balance with no link to this asset afterwards (D-12).
    function registerAsset(bytes32 docHash, uint8 assetType, uint256 value) external whenNotPaused {
        if (!approvedUser[msg.sender]) revert IIndicoLedger.NotApprovedUser();
        if (!termsSigned[msg.sender]) revert IIndicoLedger.TermsNotSigned();
        if (value == 0) revert IIndicoLedger.ZeroAmount();
        if (docHash == bytes32(0)) revert IIndicoLedger.ZeroDocHash();
        if (assetType > MAX_ASSET_TYPE) revert IIndicoLedger.InvalidAssetType(assetType);
        if (assetRegistered[docHash]) revert IIndicoLedger.AssetAlreadyRegistered();

        assetRegistered[docHash] = true;
        emit IIndicoLedger.AssetRegistered(msg.sender, docHash, assetType, value);
        _mint(msg.sender, value, docHash);
    }

    /// @notice Issue credit to `user` for a payment received off platform (AD-10, AD-11).
    /// @dev Users only, revoked included (D-32); the mint is capped per account (D-27).
    function adminIssueCredit(address user, uint256 amount, bytes32 memo)
        external
        onlyRole(ADMIN_ROLE)
        whenNotPaused
    {
        _checkCreditTarget(user, amount);
        _mint(user, amount, memo);
    }

    /// @notice Debit `user`'s credit for a private cash settlement (AD-12).
    /// @dev Users only (D-32). Limited to available credit, so it never reaches collateral
    ///      locked against a loan.
    function adminDebitCredit(address user, uint256 amount, bytes32 memo)
        external
        onlyRole(ADMIN_ROLE)
        whenNotPaused
    {
        _checkCreditTarget(user, amount);
        uint256 avail = credit[user] - lockedCredit[user];
        if (amount > avail) revert IIndicoLedger.InsufficientAvailableCredit(amount, avail);
        credit[user] -= amount;
        totalCredit -= amount;
        emit IIndicoLedger.CreditBurned(user, amount, memo);
    }

    /// @dev Same order as `_admit`: zero address first, then the role, then the amount.
    function _checkCreditTarget(address user, uint256 amount) private view {
        if (user == address(0)) revert IIndicoLedger.ZeroAddress();
        if (participantRole[user] != ROLE_USER) revert IIndicoLedger.NotAUser(user);
        if (amount == 0) revert IIndicoLedger.ZeroAmount();
    }

    // ---------------------------------------------------------------------------------------
    // Spending, contract-spec 6.4
    // ---------------------------------------------------------------------------------------

    /// @notice Pay `amount` of the caller's available credit to an approved merchant.
    /// @dev No fee: the merchant receives exactly `amount` (S-05). Paying yourself is impossible,
    ///      since a user is never an approved merchant (D-22). The merchant must have signed the
    ///      terms (D-37). `block.timestamp` in the receipt is a record only (D-26).
    function spend(address merchant, uint256 amount) external whenNotPaused {
        if (!approvedUser[msg.sender]) revert IIndicoLedger.NotApprovedUser();
        if (!termsSigned[msg.sender]) revert IIndicoLedger.TermsNotSigned();
        if (merchant == address(0)) revert IIndicoLedger.ZeroAddress();
        if (!approvedMerchant[merchant]) revert IIndicoLedger.NotApprovedMerchant();
        if (!termsSigned[merchant]) revert IIndicoLedger.MerchantTermsNotSigned(merchant);
        if (amount == 0) revert IIndicoLedger.ZeroAmount();
        uint256 avail = credit[msg.sender] - lockedCredit[msg.sender];
        if (amount > avail) revert IIndicoLedger.InsufficientAvailableCredit(amount, avail);

        credit[msg.sender] -= amount;
        credit[merchant] += amount;
        emit IIndicoLedger.Spent(msg.sender, merchant, amount);
        emit IIndicoLedger.MerchantReceipt(merchant, msg.sender, amount, block.timestamp);
    }

    // ---------------------------------------------------------------------------------------
    // Pool, contract-spec 6.5. The pool counts its own USDC in `poolUsdc`, never
    // `usdc.balanceOf`, and prices shares with a virtual offset (D-38).
    // ---------------------------------------------------------------------------------------

    /// @notice Deposit `amount` USDC; shares are minted on what actually arrived.
    /// @dev The caller must `approve` the ledger on the USDC contract first. The received amount
    ///      is the change in balance, so a fee-on-transfer token is credited what it delivered;
    ///      `nonReentrant` keeps anything else from landing in between.
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (!approvedMerchant[msg.sender]) revert IIndicoLedger.NotApprovedMerchant();
        if (!termsSigned[msg.sender]) revert IIndicoLedger.TermsNotSigned();
        if (amount == 0) revert IIndicoLedger.ZeroAmount();

        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = usdc.balanceOf(address(this)) - balanceBefore;
        uint256 minted = _toShares(received, false);
        // Zero is exactly the case refused; nothing is gained by hitting it (D-40).
        // slither-disable-next-line incorrect-equality
        if (minted == 0) revert IIndicoLedger.ZeroShares();

        shares[msg.sender] += minted;
        totalShares += minted;
        poolUsdc += received;
        // After the transfer by necessity: it reports what arrived. nonReentrant (D-40).
        // forge-lint: disable-next-line(reentrancy-events)
        emit IIndicoLedger.Deposited(msg.sender, received, minted);
    }

    /// @notice Withdraw exactly `assets` USDC, burning the shares they are worth, rounded up
    ///         (D-39). No approval check: a revoked merchant's money is still theirs.
    function withdraw(uint256 assets) external nonReentrant whenNotPaused {
        if (assets == 0) revert IIndicoLedger.ZeroAmount();
        uint256 needed = _toShares(assets, true);
        uint256 held = shares[msg.sender];
        if (needed > held) revert IIndicoLedger.InsufficientShares(needed, held);
        uint256 cash = poolUsdc;
        if (assets > cash) revert IIndicoLedger.InsufficientLiquidity(assets, cash);
        _payOut(assets, needed);
    }

    /// @notice Withdraw everything the caller's shares are worth, or all the pool's cash if
    ///         that is less (D-39). A whole claim burns every share, so no dust is left.
    function withdrawAll() external nonReentrant whenNotPaused {
        uint256 held = shares[msg.sender];
        uint256 owed = _toAssets(held);
        // Zero is exactly the case refused; nothing is gained by hitting it (D-40).
        // slither-disable-next-line incorrect-equality
        if (owed == 0) revert IIndicoLedger.ZeroAmount();
        uint256 cash = poolUsdc;
        if (cash == 0) revert IIndicoLedger.InsufficientLiquidity(owed, 0);
        if (owed <= cash) _payOut(owed, held);
        else _payOut(cash, _toShares(cash, true));
    }

    /// @dev Effects, then the transfer last.
    function _payOut(uint256 assets, uint256 burned) private {
        shares[msg.sender] -= burned;
        totalShares -= burned;
        poolUsdc -= assets;
        // Emitted before the transfer; the lint flags it in any order (D-40).
        // forge-lint: disable-next-line(reentrancy-events)
        emit IIndicoLedger.Withdrawn(msg.sender, assets, burned);
        usdc.safeTransfer(msg.sender, assets);
    }

    /// @dev `assets` in shares at the current price, rounded down to mint, up to burn (D-38).
    function _toShares(uint256 assets, bool roundUp) private view returns (uint256) {
        uint256 s = totalShares + VIRTUAL_SHARES;
        uint256 a = poolUsdc + totalLent + VIRTUAL_ASSETS;
        return roundUp ? LedgerMath.mulDivUp(assets, s, a) : LedgerMath.mulDivDown(assets, s, a);
    }

    /// @dev `shareAmount` in USDC at the current price, rounded down (D-38).
    function _toAssets(uint256 shareAmount) private view returns (uint256) {
        return LedgerMath.mulDivDown(
            shareAmount, poolUsdc + totalLent + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES
        );
    }

    /// @dev The only way credit enters circulation. Refuses a mint that would push one account
    ///      above `CREDIT_CAP`, so no balance a loan can lock against exceeds `uint128` (D-27).
    ///      Written as `amount > room` so it cannot overflow for any `amount`.
    function _mint(address account, uint256 amount, bytes32 reason) private {
        uint256 room = CREDIT_CAP - credit[account];
        if (amount > room) revert IIndicoLedger.CreditCapExceeded(amount, room);
        credit[account] += amount;
        totalCredit += amount;
        emit IIndicoLedger.CreditMinted(account, amount, reason);
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
