// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IIndicoLedger
/// @notice External surface of the Indico Asset Ledger: credit, spending, the USDC pool and loans.
/// @dev Source of truth: docs/contract-spec.md sections 4 to 8. All amounts are 6 decimals and
///      1 credit = 1 USDC. Every caller pays their own gas, so `msg.sender` is the authority.
///      Role management (`grantRole`, `revokeRole`, `hasRole`) and `paused()` come from
///      OpenZeppelin AccessControl and Pausable and are not repeated here.
///      Constructor (spec 6.0): `constructor(IERC20 usdc_, address admin_, address guardian_)`,
///      reverts `ZeroAddress` on any zero argument, then `UsdcNotAContract`,
///      `UsdcDecimalsUnreadable` or `UsdcWrongDecimals` unless `usdc_` reports 6 decimals.
interface IIndicoLedger {
    /// @notice Loan lifecycle. Stored as `uint8` in `Loan.status`.
    enum LoanStatus {
        Active,
        Repaid,
        Defaulted
    }

    // ---------------------------------------------------------------------------------------
    // Events (spec section 7). The indexer is built entirely from these.
    // ---------------------------------------------------------------------------------------

    /// @notice The admin set the hash of the current platform terms.
    event TermsHashSet(bytes32 indexed termsHash);
    /// @notice `signer` accepted the terms identified by `termsHash` at timestamp `at`.
    event TermsSigned(address indexed signer, bytes32 indexed termsHash, uint256 at);
    /// @notice The admin approved or revoked a user.
    event UserApprovalSet(address indexed user, bool approved);
    /// @notice The admin approved or revoked a merchant.
    event MerchantApprovalSet(address indexed merchant, bool approved);

    /// @notice `user` registered a document fingerprint with a self-declared `value`.
    event AssetRegistered(
        address indexed user, bytes32 indexed docHash, uint8 assetType, uint256 value
    );
    /// @notice Credit entered circulation for `user`. `reason` is a memo or asset marker.
    event CreditMinted(address indexed user, uint256 amount, bytes32 reason);
    /// @notice Credit left circulation for `user` through an admin debit.
    event CreditBurned(address indexed user, uint256 amount, bytes32 reason);

    /// @notice `user` paid `merchant` `amount` of credit.
    event Spent(address indexed user, address indexed merchant, uint256 amount);
    /// @notice Permanent receipt for `merchant` of a payment from `payer`.
    event MerchantReceipt(
        address indexed merchant, address indexed payer, uint256 amount, uint256 at
    );

    /// @notice `merchant` deposited `assets` USDC (as received) and was minted `shares`.
    event Deposited(address indexed merchant, uint256 assets, uint256 shares);
    /// @notice `merchant` burned `shares` and received `assets` USDC.
    event Withdrawn(address indexed merchant, uint256 assets, uint256 shares);

    /// @notice Loan `loanId` opened and `principal` USDC paid to `borrower`.
    event LoanOpened(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 principal,
        uint256 collateral,
        uint64 dueDate
    );
    /// @notice The borrower pushed the due date of `loanId` out by one term.
    ///         `extensionCount` is the total number of extensions including this one.
    event LoanExtended(uint256 indexed loanId, uint64 newDueDate, uint16 extensionCount);
    /// @notice `borrower` repaid `loanId` in full.
    event LoanRepaid(uint256 indexed loanId, address indexed borrower, uint256 principal);
    /// @notice `loanId` was liquidated after its due date by `caller`. Collateral went to the pool.
    event LoanDefaulted(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 principal,
        uint256 collateral,
        address caller
    );
    /// @notice `amount` of `user`'s credit was locked against `loanId`.
    event CollateralLocked(address indexed user, uint256 amount, uint256 indexed loanId);
    /// @notice `amount` of `user`'s credit locked against `loanId` was released.
    event CollateralReleased(address indexed user, uint256 amount, uint256 indexed loanId);

    // `Paused(address)` and `Unpaused(address)` (spec section 7) are declared by OpenZeppelin
    // `Pausable`, which the ledger inherits. Redeclaring them here would not compile there.

    // ---------------------------------------------------------------------------------------
    // Errors (spec section 8)
    // ---------------------------------------------------------------------------------------

    error NotApprovedUser();
    error NotApprovedMerchant();
    error TermsNotSigned();
    error AlreadySigned();
    error TermsNotSet();
    error WrongTermsHash();
    error ZeroAmount();
    error AssetAlreadyRegistered();
    error InsufficientAvailableCredit(uint256 requested, uint256 available);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error LoanNotFound();
    error LoanNotActive();
    error NotBorrower();
    error ExtensionWindowClosed();
    error NotYetDue(uint64 dueDate);
    /// @notice `extend` called before the window opens at `dueDate - EXTENSION_WINDOW`.
    error ExtensionWindowNotOpen(uint64 opensAt);
    /// @notice A constructor argument was the zero address.
    error ZeroAddress();
    /// @notice Admin credit target `account` was never approved as a user (D-32).
    error NotAUser(address account);
    /// @notice `registerAsset` with a zero document hash (D-28).
    error ZeroDocHash();
    /// @notice `registerAsset` with an asset type above 5 (D-29).
    error InvalidAssetType(uint8 assetType);
    /// @notice A mint of `requested` would push one account above 2^128 - 1; `room` is that
    ///         account's remaining headroom (D-27).
    error CreditCapExceeded(uint256 requested, uint256 room);
    /// @notice `setTermsHash(0)`. Zero means "never set", so it cannot be set again (D-21).
    error ZeroTermsHash();
    /// @notice `account` was once approved in the other role; roles are permanent (D-22).
    error ParticipantRoleConflict(address account);
    /// @notice The ledger or the USDC address cannot be approved as a participant (D-23).
    error InvalidParticipant(address account);
    /// @notice Constructor: `token` has no code, so it cannot be USDC.
    error UsdcNotAContract(address token);
    /// @notice Constructor: `token.decimals()` reverted or returned less than one word.
    error UsdcDecimalsUnreadable(address token);
    /// @notice Constructor: `decimals()` returned `decimals`, not 6. 1 credit = 1 USDC needs 6.
    error UsdcWrongDecimals(uint256 decimals);
    /// @notice `withdraw` asked to burn more shares than the caller holds.
    error InsufficientShares(uint256 requested, uint256 held);
    /// @notice Raised by `lib/Math.sol`; same selector as `Math.DivisionByZero`.
    error DivisionByZero();
    /// @notice Raised by `lib/Math.sol`; same selector as `Math.MathOverflow`.
    error MathOverflow();

    // ---------------------------------------------------------------------------------------
    // Administration (spec 6.1)
    // ---------------------------------------------------------------------------------------

    /// @notice Set the hash of the current terms. Does not clear existing signatures.
    /// @dev ADMIN_ROLE. Works while paused (D-24). Reverts `ZeroTermsHash` for zero. Setting the
    ///      current hash again is allowed and emits again (D-20). Emits `TermsHashSet`.
    function setTermsHash(bytes32 newHash) external;

    /// @notice Approve or revoke a user. Revocation blocks new actions only; balances and
    ///         existing loans are untouched and can still be repaid and liquidated.
    /// @dev ADMIN_ROLE. Works while paused (D-24). Reverts `ZeroAddress` for zero; on approval,
    ///      `InvalidParticipant` for the ledger or USDC address and `ParticipantRoleConflict` if
    ///      the address was ever approved as a merchant. Repeats are allowed and emit (D-20).
    ///      Emits `UserApprovalSet`.
    function setUserApproved(address user, bool approved) external;

    /// @notice Approve or revoke a merchant. A revoked merchant can still withdraw.
    /// @dev ADMIN_ROLE. Works while paused (D-24). Same checks as `setUserApproved`, with the
    ///      roles swapped. Emits `MerchantApprovalSet`.
    function setMerchantApproved(address m, bool approved) external;

    /// @notice Stop every `whenNotPaused` function. GUARDIAN_ROLE. Callable while paused.
    function pause() external;

    /// @notice Resume normal operation. GUARDIAN_ROLE. Callable while paused.
    function unpause() external;

    // ---------------------------------------------------------------------------------------
    // Terms (spec 6.2)
    // ---------------------------------------------------------------------------------------

    /// @notice Record that the caller accepted the terms identified by `acceptedHash`.
    /// @dev `whenNotPaused`. No approval needed (contract-spec 6.2). Reverts, in order,
    ///      `TermsNotSet`, `WrongTermsHash` if `acceptedHash != termsHash`, and `AlreadySigned`
    ///      if the caller already signed this exact version. Signing a newer current version
    ///      is allowed and emits again (D-25). Emits `TermsSigned`.
    function signTerms(bytes32 acceptedHash) external;

    // ---------------------------------------------------------------------------------------
    // Assets and credit (spec 6.3)
    // ---------------------------------------------------------------------------------------

    /// @notice Register a document fingerprint and mint `value` credit to the caller.
    /// @dev `whenNotPaused`. Reverts, in order, `NotApprovedUser`, `TermsNotSigned`,
    ///      `ZeroAmount`, `ZeroDocHash` (D-28), `InvalidAssetType` for a type above 5 (D-29),
    ///      `AssetAlreadyRegistered`, and `CreditCapExceeded` if the caller's credit would pass
    ///      2^128 - 1 (D-27). Emits `AssetRegistered` and `CreditMinted` with `reason = docHash`.
    function registerAsset(bytes32 docHash, uint8 assetType, uint256 value) external;

    /// @notice Issue credit to `user` for a payment received off platform.
    /// @dev ADMIN_ROLE, `whenNotPaused`. Reverts, in order, `ZeroAddress`, `NotAUser` unless
    ///      `user` was approved as a user (revoked included, D-32), `ZeroAmount`, then
    ///      `CreditCapExceeded` (D-27). Emits `CreditMinted(user, amount, memo)`.
    function adminIssueCredit(address user, uint256 amount, bytes32 memo) external;

    /// @notice Debit `user`'s credit for a private cash settlement.
    /// @dev ADMIN_ROLE, `whenNotPaused`. Reverts, in order, `ZeroAddress`, `NotAUser`,
    ///      `ZeroAmount`, then `InsufficientAvailableCredit` if `amount > available(user)`; never
    ///      reaches locked collateral. Emits `CreditBurned(user, amount, memo)`.
    function adminDebitCredit(address user, uint256 amount, bytes32 memo) external;

    // ---------------------------------------------------------------------------------------
    // Spending (spec 6.4)
    // ---------------------------------------------------------------------------------------

    /// @notice Pay `amount` of the caller's available credit to an approved merchant.
    /// @dev Approved user, terms signed, approved merchant, `0 < amount <= available(caller)`.
    ///      Emits `Spent` and `MerchantReceipt`.
    function spend(address merchant, uint256 amount) external;

    // ---------------------------------------------------------------------------------------
    // Pool (spec 6.5)
    // ---------------------------------------------------------------------------------------

    /// @notice Deposit USDC into the pool. Shares are minted on the amount actually received.
    /// @dev Approved merchant, terms signed, `amount > 0`. Emits `Deposited`.
    function deposit(uint256 amount) external;

    /// @notice Burn `sharesToBurn` and receive their proportional slice of pool USDC.
    /// @dev Reverts `InsufficientLiquidity` if the slice exceeds `poolAvailable()`.
    ///      Allowed for a revoked merchant. Emits `Withdrawn`.
    function withdraw(uint256 sharesToBurn) external;

    // ---------------------------------------------------------------------------------------
    // Loans (spec 6.6)
    // ---------------------------------------------------------------------------------------

    /// @notice Lock `collateralFor(principal)` credit and receive `principal` USDC at once.
    /// @dev Approved user, terms signed, `principal > 0`,
    ///      `collateralFor(principal) <= available(caller)`, `principal <= poolAvailable()`.
    ///      Due date is `block.timestamp + TERM`. Emits `LoanOpened`.
    /// @return loanId The id of the new loan.
    function requestLoan(uint256 principal) external returns (uint256 loanId);

    /// @notice Repay the exact principal of an Active loan and release its collateral.
    /// @dev Borrower only. Allowed after the due date until liquidated.
    ///      Emits `LoanRepaid` and `CollateralReleased`.
    function repay(uint256 loanId) external;

    /// @notice Push the due date out by `TERM`, from the existing due date. Unlimited, free.
    /// @dev Borrower only, Active, `dueDate - EXTENSION_WINDOW <= block.timestamp <= dueDate`.
    ///      Reverts `ExtensionWindowNotOpen(opensAt)` before the window and
    ///      `ExtensionWindowClosed` after the due date. Emits `LoanExtended`.
    function extend(uint256 loanId) external;

    /// @notice Default an Active loan past its due date. Permissionless. No USDC moves.
    /// @dev Burns the collateral from the borrower into `poolCredit`. Emits `LoanDefaulted`.
    function liquidate(uint256 loanId) external;

    // ---------------------------------------------------------------------------------------
    // Views (spec sections 3, 4 and 5)
    // ---------------------------------------------------------------------------------------

    function ADMIN_ROLE() external view returns (bytes32);
    function GUARDIAN_ROLE() external view returns (bytes32);

    function usdc() external view returns (IERC20);
    function termsHash() external view returns (bytes32);

    function approvedUser(address user) external view returns (bool);
    /// @notice The role `account` was first approved for: 0 none, 1 user, 2 merchant. Set by
    ///         the first approval and never cleared, so an address never switches role (D-22).
    function participantRole(address account) external view returns (uint8);
    function approvedMerchant(address m) external view returns (bool);
    function termsSigned(address account) external view returns (bool);
    /// @notice The terms version `account` signed most recently, zero if never (D-25).
    function signedTermsHash(address account) external view returns (bytes32);

    function credit(address account) external view returns (uint256);
    function lockedCredit(address account) external view returns (uint256);
    function totalCredit() external view returns (uint256);
    /// @notice Defaulted collateral recorded to the pool. Inert until the client decides.
    function poolCredit() external view returns (uint256);

    function assetRegistered(bytes32 docHash) external view returns (bool);

    function shares(address merchant) external view returns (uint256);
    function totalShares() external view returns (uint256);
    /// @notice USDC currently out on Active loans.
    function totalLent() external view returns (uint256);

    function nextLoanId() external view returns (uint256);
    function loans(uint256 loanId)
        external
        view
        returns (
            address borrower,
            uint64 dueDate,
            uint16 extensionCount,
            uint8 status,
            uint128 principal,
            uint128 collateral
        );

    /// @notice `credit - lockedCredit`.
    function available(address user) external view returns (uint256);
    /// @notice UI helper only, rounds down. `requestLoan` validates on `collateralFor`.
    function maxBorrow(address user) external view returns (uint256);
    /// @notice `ceilDiv(principal * BPS, LTV_BPS)`, rounds up in the pool's favour.
    function collateralFor(uint256 principal) external view returns (uint256);
    /// @notice USDC held plus USDC lent out.
    function poolTotalAssets() external view returns (uint256);
    /// @notice USDC held by the contract, available to lend or withdraw.
    function poolAvailable() external view returns (uint256);
    function sharesToAssets(uint256 shareAmount) external view returns (uint256);
    function assetsToShares(uint256 assets) external view returns (uint256);
    /// @notice `min(sharesToAssets(shares[m]), poolAvailable())`.
    function maxWithdraw(address merchant) external view returns (uint256);
}
