// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice A deliberately naive second ledger (P2.3, IT 4), written from the written rules (CS 6
///         and the decisions), not from the contract: plain mappings, plain arithmetic, one rule
///         per line, no packing and no cleverness. Test code; it never ships.
///
///         Products of pool amounts and share counts can exceed 2^256 after repeated total
///         defaults (D-38), so share maths uses OpenZeppelin's full-width `mulDiv` (not the
///         ledger's own `LedgerMath`) and reports `MathOverflow` when a result does not fit.
///
///         Each action takes the caller explicitly and returns the exact revert data the real
///         ledger must produce (empty on success). State changes only on success. The
///         differential test drives both with the same calls and compares after every one.
///
///         Never change this model to agree with the contract. When they disagree, work out
///         which one is wrong against the rules.
contract LedgerModel {
    // ------------------------------------------------------------------ rules as constants
    uint256 constant CAP = 2 ** 128 - 1; // D-27
    uint256 constant TERM = 90 days;
    uint256 constant WINDOW = 30 days; // D-13
    uint256 constant GRACE = 7 days; // D-55
    uint8 constant NONE = 0;
    uint8 constant USER = 1;
    uint8 constant MERCHANT = 2;
    uint8 constant RETIRED = 3;
    uint8 constant ACTIVE = 0;
    uint8 constant REPAID = 1;
    uint8 constant DEFAULTED = 2;

    // ------------------------------------------------------------------ who is who
    address public immutable ledgerAddr;
    address public immutable usdcAddr;
    address public immutable admin;
    address public immutable guardian;
    bytes32 public immutable adminRole;
    bytes32 public immutable guardianRole;

    // ------------------------------------------------------------------ state
    bytes32 public termsHash;
    mapping(address => bool) public approvedUser;
    mapping(address => bool) public approvedMerchant;
    mapping(address => bool) public termsSigned;
    mapping(address => bytes32) public signedTermsHash;
    mapping(address => uint8) public role;
    mapping(address => uint256) public credit;
    mapping(address => uint256) public locked;
    uint256 public totalCredit;
    uint256 public poolCredit;
    mapping(bytes32 => bool) public assetRegistered;
    mapping(address => uint256) public shares;
    uint256 public totalShares;
    uint256 public totalLent;
    uint256 public poolUsdc;
    uint256 public nextLoanId;
    bool public paused;
    uint256 public lastPausedAt;
    uint256 public lastUnpausedAt;
    mapping(address => bytes32) public accountRefOf;
    mapping(bytes32 => address) public walletOfAccount;

    struct Loan {
        address borrower;
        uint256 dueDate;
        uint256 extensionCount;
        uint8 status;
        uint256 principal;
        uint256 collateral;
    }

    mapping(uint256 => Loan) public loans;

    constructor(
        address ledger_,
        address usdc_,
        address admin_,
        address guardian_,
        bytes32 a,
        bytes32 g
    ) {
        ledgerAddr = ledger_;
        usdcAddr = usdc_;
        admin = admin_;
        guardian = guardian_;
        adminRole = a;
        guardianRole = g;
    }

    // ================================================================== administration

    function setTermsHash(address caller, bytes32 h) external returns (bytes memory) {
        if (caller != admin) return _unauthorized(caller, adminRole);
        if (h == 0) return abi.encodeWithSelector(IIndicoLedger.ZeroTermsHash.selector);
        termsHash = h;
        return "";
    }

    function setUserApproved(address caller, address user, bool approved, bytes32 ref)
        external
        returns (bytes memory)
    {
        if (caller != admin) return _unauthorized(caller, adminRole);
        if (user == address(0)) return abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector);
        if (!approved) {
            // a revoke names the wallet's own link, 0 if it never had one (D-60)
            if (ref != accountRefOf[user]) {
                return abi.encodeWithSelector(
                    IIndicoLedger.AccountRefMismatch.selector, user, accountRefOf[user]
                );
            }
            approvedUser[user] = false;
            return "";
        }
        if (user == ledgerAddr || user == usdcAddr) {
            return abi.encodeWithSelector(IIndicoLedger.InvalidParticipant.selector, user);
        }
        if (role[user] != NONE && role[user] != USER) {
            return abi.encodeWithSelector(IIndicoLedger.ParticipantRoleConflict.selector, user);
        }
        if (ref == 0) return abi.encodeWithSelector(IIndicoLedger.ZeroAccountRef.selector);
        if (accountRefOf[user] != 0 && accountRefOf[user] != ref) {
            return abi.encodeWithSelector(
                IIndicoLedger.WalletAlreadyLinked.selector, user, accountRefOf[user]
            );
        }
        if (walletOfAccount[ref] != address(0) && walletOfAccount[ref] != user) {
            return abi.encodeWithSelector(
                IIndicoLedger.AccountAlreadyLinked.selector, ref, walletOfAccount[ref]
            );
        }
        role[user] = USER;
        approvedUser[user] = true;
        accountRefOf[user] = ref;
        walletOfAccount[ref] = user;
        return "";
    }

    function setMerchantApproved(address caller, address m, bool approved)
        external
        returns (bytes memory)
    {
        if (caller != admin) return _unauthorized(caller, adminRole);
        if (m == address(0)) return abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector);
        if (approved) {
            if (m == ledgerAddr || m == usdcAddr) {
                return abi.encodeWithSelector(IIndicoLedger.InvalidParticipant.selector, m);
            }
            if (role[m] != NONE && role[m] != MERCHANT) {
                return abi.encodeWithSelector(IIndicoLedger.ParticipantRoleConflict.selector, m);
            }
            role[m] = MERCHANT;
        }
        approvedMerchant[m] = approved;
        return "";
    }

    function pause(address caller) external returns (bytes memory) {
        if (caller != guardian) return _unauthorized(caller, guardianRole);
        if (paused) return abi.encodeWithSelector(Pausable.EnforcedPause.selector);
        paused = true;
        // a pause inside the previous grace is the same disruption (D-58)
        if (block.timestamp > lastUnpausedAt + GRACE) lastPausedAt = block.timestamp;
        return "";
    }

    function unpause(address caller) external returns (bytes memory) {
        if (caller != guardian) return _unauthorized(caller, guardianRole);
        if (!paused) return abi.encodeWithSelector(Pausable.ExpectedPause.selector);
        paused = false;
        lastUnpausedAt = block.timestamp;
        return "";
    }

    // ================================================================== terms and credit

    function signTerms(address caller, bytes32 h) external returns (bytes memory) {
        if (paused) return _paused();
        if (termsHash == 0) return abi.encodeWithSelector(IIndicoLedger.TermsNotSet.selector);
        if (h != termsHash) return abi.encodeWithSelector(IIndicoLedger.WrongTermsHash.selector);
        if (signedTermsHash[caller] == termsHash) {
            return abi.encodeWithSelector(IIndicoLedger.AlreadySigned.selector);
        }
        termsSigned[caller] = true;
        signedTermsHash[caller] = termsHash;
        return "";
    }

    function registerAsset(address caller, bytes32 doc, uint8 assetType, uint256 value)
        external
        returns (bytes memory)
    {
        if (paused) return _paused();
        if (!approvedUser[caller]) {
            return abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector);
        }
        if (!termsSigned[caller]) {
            return abi.encodeWithSelector(IIndicoLedger.TermsNotSigned.selector);
        }
        if (value == 0) return abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector);
        if (doc == 0) return abi.encodeWithSelector(IIndicoLedger.ZeroDocHash.selector);
        if (assetType > 5) {
            return abi.encodeWithSelector(IIndicoLedger.InvalidAssetType.selector, assetType);
        }
        if (assetRegistered[doc]) {
            return abi.encodeWithSelector(IIndicoLedger.AssetAlreadyRegistered.selector);
        }
        uint256 room = CAP - credit[caller];
        if (value > room) {
            return abi.encodeWithSelector(IIndicoLedger.CreditCapExceeded.selector, value, room);
        }
        assetRegistered[doc] = true;
        credit[caller] += value;
        totalCredit += value;
        return "";
    }

    function adminIssueCredit(address caller, address user, uint256 amount)
        external
        returns (bytes memory)
    {
        if (caller != admin) return _unauthorized(caller, adminRole);
        if (paused) return _paused();
        if (user == address(0)) return abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector);
        if (role[user] != USER) {
            return abi.encodeWithSelector(IIndicoLedger.NotAUser.selector, user);
        }
        if (amount == 0) return abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector);
        uint256 room = CAP - credit[user];
        if (amount > room) {
            return abi.encodeWithSelector(IIndicoLedger.CreditCapExceeded.selector, amount, room);
        }
        credit[user] += amount;
        totalCredit += amount;
        return "";
    }

    function adminDebitCredit(address caller, address a, uint256 amount)
        external
        returns (bytes memory)
    {
        if (caller != admin) return _unauthorized(caller, adminRole);
        if (paused) return _paused();
        if (a == address(0)) return abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector);
        if (role[a] != USER && role[a] != MERCHANT) {
            return abi.encodeWithSelector(IIndicoLedger.NotAUser.selector, a);
        }
        if (amount == 0) return abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector);
        uint256 avail = credit[a] - locked[a];
        if (amount > avail) {
            return abi.encodeWithSelector(
                IIndicoLedger.InsufficientAvailableCredit.selector, amount, avail
            );
        }
        credit[a] -= amount;
        totalCredit -= amount;
        return "";
    }

    function adminMoveAccount(address caller, address oldW, address newW, bytes32 ref)
        external
        returns (bytes memory)
    {
        if (caller != admin) return _unauthorized(caller, adminRole);
        if (oldW == address(0) || newW == address(0)) {
            return abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector);
        }
        if (role[oldW] != USER) {
            return abi.encodeWithSelector(IIndicoLedger.NotAUser.selector, oldW);
        }
        if (ref != accountRefOf[oldW]) {
            return abi.encodeWithSelector(
                IIndicoLedger.AccountRefMismatch.selector, oldW, accountRefOf[oldW]
            );
        }
        if (locked[oldW] != 0) {
            return abi.encodeWithSelector(
                IIndicoLedger.AccountHasLockedCredit.selector, oldW, locked[oldW]
            );
        }
        if (newW == ledgerAddr || newW == usdcAddr) {
            return abi.encodeWithSelector(IIndicoLedger.InvalidParticipant.selector, newW);
        }
        if (role[newW] != NONE) {
            return abi.encodeWithSelector(IIndicoLedger.WalletNotFresh.selector, newW);
        }
        credit[newW] = credit[oldW];
        credit[oldW] = 0;
        approvedUser[oldW] = false;
        approvedUser[newW] = true;
        role[oldW] = RETIRED;
        role[newW] = USER;
        accountRefOf[oldW] = 0;
        accountRefOf[newW] = ref;
        walletOfAccount[ref] = newW;
        return "";
    }

    function spend(address caller, address m, uint256 amount) external returns (bytes memory) {
        if (paused) return _paused();
        if (!approvedUser[caller]) {
            return abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector);
        }
        if (!termsSigned[caller]) {
            return abi.encodeWithSelector(IIndicoLedger.TermsNotSigned.selector);
        }
        if (m == address(0)) return abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector);
        if (!approvedMerchant[m]) {
            return abi.encodeWithSelector(IIndicoLedger.NotApprovedMerchant.selector);
        }
        if (!termsSigned[m]) {
            return abi.encodeWithSelector(IIndicoLedger.MerchantTermsNotSigned.selector, m);
        }
        if (amount == 0) return abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector);
        uint256 avail = credit[caller] - locked[caller];
        if (amount > avail) {
            return abi.encodeWithSelector(
                IIndicoLedger.InsufficientAvailableCredit.selector, amount, avail
            );
        }
        credit[caller] -= amount;
        credit[m] += amount;
        return "";
    }

    // ================================================================== pool (D-38, D-39)

    function deposit(address caller, uint256 amount) external returns (bytes memory) {
        if (paused) return _paused();
        if (!approvedMerchant[caller]) {
            return abi.encodeWithSelector(IIndicoLedger.NotApprovedMerchant.selector);
        }
        if (!termsSigned[caller]) {
            return abi.encodeWithSelector(IIndicoLedger.TermsNotSigned.selector);
        }
        if (amount == 0) return abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector);
        (bool over, uint256 minted) =
            _mulDiv(amount, totalShares + 1e6, poolUsdc + totalLent + 1, false);
        if (over) return _overflow();
        if (minted == 0) return abi.encodeWithSelector(IIndicoLedger.ZeroShares.selector);
        shares[caller] += minted;
        totalShares += minted;
        poolUsdc += amount;
        return "";
    }

    function withdraw(address caller, uint256 assets) external returns (bytes memory) {
        if (paused) return _paused();
        if (assets == 0) return abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector);
        (bool over, uint256 needed) =
            _mulDiv(assets, totalShares + 1e6, poolUsdc + totalLent + 1, true);
        if (over) return _overflow();
        if (needed > shares[caller]) {
            return abi.encodeWithSelector(
                IIndicoLedger.InsufficientShares.selector, needed, shares[caller]
            );
        }
        if (assets > poolUsdc) {
            return
                abi.encodeWithSelector(
                    IIndicoLedger.InsufficientLiquidity.selector, assets, poolUsdc
                );
        }
        _payOut(caller, assets, needed);
        return "";
    }

    function withdrawAll(address caller) external returns (bytes memory) {
        if (paused) return _paused();
        (bool over, uint256 owed) =
            _mulDiv(shares[caller], poolUsdc + totalLent + 1, totalShares + 1e6, false);
        if (over) return _overflow();
        if (owed == 0) return abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector);
        if (poolUsdc == 0) {
            return abi.encodeWithSelector(IIndicoLedger.InsufficientLiquidity.selector, owed, 0);
        }
        if (owed <= poolUsdc) {
            _payOut(caller, owed, shares[caller]); // the whole claim burns every share
        } else {
            uint256 cash = poolUsdc;
            (bool over2, uint256 burn) =
                _mulDiv(cash, totalShares + 1e6, poolUsdc + totalLent + 1, true);
            if (over2) return _overflow();
            _payOut(caller, cash, burn);
        }
        return "";
    }

    // ================================================================== loans

    function requestLoan(address caller, uint256 principal) external returns (bytes memory) {
        if (paused) return _paused();
        if (!approvedUser[caller]) {
            return abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector);
        }
        if (!termsSigned[caller]) {
            return abi.encodeWithSelector(IIndicoLedger.TermsNotSigned.selector);
        }
        if (principal == 0) return abi.encodeWithSelector(IIndicoLedger.ZeroAmount.selector);
        uint256 collateral = _ceil(principal * 10_000, 8_000); // 1.25x, rounded up (D-05)
        uint256 avail = credit[caller] - locked[caller];
        if (collateral > avail) {
            return abi.encodeWithSelector(
                IIndicoLedger.InsufficientAvailableCredit.selector, collateral, avail
            );
        }
        if (principal > poolUsdc) {
            return abi.encodeWithSelector(
                IIndicoLedger.InsufficientLiquidity.selector, principal, poolUsdc
            );
        }
        nextLoanId += 1;
        loans[nextLoanId] = Loan(caller, block.timestamp + TERM, 0, ACTIVE, principal, collateral);
        locked[caller] += collateral;
        totalLent += principal;
        poolUsdc -= principal;
        return "";
    }

    function repay(address caller, uint256 id) external returns (bytes memory) {
        if (paused) return _paused();
        Loan storage l = loans[id];
        if (l.borrower == address(0)) {
            return abi.encodeWithSelector(IIndicoLedger.LoanNotFound.selector);
        }
        if (l.status != ACTIVE) {
            return abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector);
        }
        if (l.borrower != caller) {
            return abi.encodeWithSelector(IIndicoLedger.NotBorrower.selector);
        }
        l.status = REPAID;
        locked[caller] -= l.collateral;
        totalLent -= l.principal;
        poolUsdc += l.principal;
        return "";
    }

    function extend(address caller, uint256 id) external returns (bytes memory) {
        if (paused) return _paused();
        Loan storage l = loans[id];
        if (l.borrower == address(0)) {
            return abi.encodeWithSelector(IIndicoLedger.LoanNotFound.selector);
        }
        if (l.status != ACTIVE) {
            return abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector);
        }
        if (l.borrower != caller) {
            return abi.encodeWithSelector(IIndicoLedger.NotBorrower.selector);
        }
        if (!approvedUser[caller]) {
            return abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector);
        }
        if (block.timestamp < l.dueDate - WINDOW) {
            return abi.encodeWithSelector(
                IIndicoLedger.ExtensionWindowNotOpen.selector, uint64(l.dueDate - WINDOW)
            );
        }
        bool late = l.dueDate >= lastPausedAt && block.timestamp <= lastUnpausedAt + GRACE; // D-58
        if (block.timestamp > l.dueDate && !late) {
            return abi.encodeWithSelector(IIndicoLedger.ExtensionWindowClosed.selector);
        }
        l.dueDate += TERM; // from the due date, never from now
        l.extensionCount += 1;
        return "";
    }

    function liquidate(uint256 id) external returns (bytes memory) {
        if (paused) return _paused();
        Loan storage l = loans[id];
        if (l.borrower == address(0)) {
            return abi.encodeWithSelector(IIndicoLedger.LoanNotFound.selector);
        }
        if (l.status != ACTIVE) {
            return abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector);
        }
        if (block.timestamp <= l.dueDate) {
            return abi.encodeWithSelector(IIndicoLedger.NotYetDue.selector, uint64(l.dueDate));
        }
        if (block.timestamp <= lastUnpausedAt + GRACE) {
            return abi.encodeWithSelector(
                IIndicoLedger.LiquidationGracePeriod.selector, lastUnpausedAt + GRACE
            );
        }
        l.status = DEFAULTED;
        locked[l.borrower] -= l.collateral;
        credit[l.borrower] -= l.collateral;
        totalCredit -= l.collateral;
        poolCredit += l.collateral;
        totalLent -= l.principal;
        return "";
    }

    // ================================================================== helpers

    function _payOut(address m, uint256 assets, uint256 burned) internal {
        shares[m] -= burned;
        totalShares -= burned;
        poolUsdc -= assets;
    }

    /// @dev x * y / d, rounded down or up; `over` when the exact result does not fit in 256 bits.
    function _mulDiv(uint256 x, uint256 y, uint256 d, bool up)
        internal
        pure
        returns (bool over, uint256 r)
    {
        (uint256 high,) = Math.mul512(x, y);
        if (high >= d) return (true, 0);
        r = Math.mulDiv(x, y, d);
        if (up && mulmod(x, y, d) != 0) {
            if (r == type(uint256).max) return (true, 0);
            r += 1;
        }
    }

    function _overflow() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IIndicoLedger.MathOverflow.selector);
    }

    function _ceil(uint256 a, uint256 b) internal pure returns (uint256) {
        return a / b + (a % b == 0 ? 0 : 1);
    }

    function _paused() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Pausable.EnforcedPause.selector);
    }

    function _unauthorized(address caller, bytes32 r) internal pure returns (bytes memory) {
        return
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, caller, r
            );
    }
}
