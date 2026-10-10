// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {
    CREDIT_CAP,
    MAX_ASSET_TYPE,
    ROLE_NONE,
    ROLE_USER,
    ROLE_MERCHANT,
    EXTENSION_WINDOW,
    LIQUIDATION_GRACE,
    BPS,
    LTV_BPS
} from "../../src/lib/Constants.sol";
import {LedgerMath} from "../../src/lib/Math.sol";
import {MockUSDC} from "../helpers/MockUSDC.sol";
import {Handler} from "./Handler.sol";

/// @notice The strict handler (P2.2, TS 2.3). Each action works out, from the written rules (CS 6
///         and the decisions), whether the call it is about to make must succeed. If not, it returns
///         without calling (a skip). If so, it calls, and the suite runs with `fail_on_revert`, so
///         any refusal of a valid call fails the run: the permissive suite proves nothing bad
///         happens, this one proves nothing good is refused. The per-call rules of `Handler`
///         (exact credit deltas, I9 to I11) are recorded here too.
///
///         The validity checks are written from the rules, not copied from the contract, and use
///         the ledger's storage getters only for state (never its own checks or views that encode
///         a rule, except `assetsToShares`, `sharesToAssets` and `collateralFor`, whose maths I1, I5
///         and the P1.12 tests pin independently).
contract StrictHandler is Handler {
    constructor(IIndicoLedger ledger_, MockUSDC usdc_, address admin_, address guardian_)
        Handler(ledger_, usdc_, admin_, guardian_)
    {}

    // ================================================================ credit

    function s_registerAsset(uint256 who, uint256 typeSeed, uint256 value) external {
        address u = accountWallet[who % accountWallet.length];
        uint256 room = CREDIT_CAP - ledger.credit(u);
        value = value % 50 == 0 ? room : bound(value, 1, MAX_AMOUNT);
        if (_paused() || !_activeUser(u) || value == 0 || value > room) return;
        uint8 t = uint8(bound(typeSeed, 0, MAX_ASSET_TYPE));
        bytes32 doc = keccak256(abi.encode("strict-doc", docNonce++));
        _start();
        _delta(u, int256(value));
        vm.prank(u);
        ledger.registerAsset(doc, t, value);
        ghostMinted += value;
        _end();
    }

    function s_adminIssue(uint256 who, uint256 amount) external {
        address u = _anyone(who);
        if (ledger.participantRole(u) != ROLE_USER) u = accountWallet[who % accountWallet.length];
        uint256 room = CREDIT_CAP - ledger.credit(u);
        amount = bound(amount, 1, MAX_AMOUNT);
        if (_paused() || ledger.participantRole(u) != ROLE_USER || amount > room) return;
        _start();
        _delta(u, int256(amount));
        vm.prank(admin);
        ledger.adminIssueCredit(u, amount, bytes32(amount));
        ghostMinted += amount;
        _end();
    }

    function s_adminDebit(uint256 who, uint256 amount) external {
        address a = _anyone(who);
        uint8 role = ledger.participantRole(a);
        uint256 avail = ledger.credit(a) - ledger.lockedCredit(a);
        amount = amount % 3 == 0 ? avail : bound(amount, 1, MAX_AMOUNT);
        if (_paused() || (role != ROLE_USER && role != ROLE_MERCHANT)) return;
        if (amount == 0 || amount > avail) return;
        _start();
        _delta(a, -int256(amount));
        vm.prank(admin);
        ledger.adminDebitCredit(a, amount, bytes32(amount));
        ghostBurned += amount;
        _check(ledger.credit(a) >= ledger.lockedCredit(a), "I9 debit below locked");
        _end();
    }

    function s_spend(uint256 who, uint256 to, uint256 amount) external {
        address u = accountWallet[who % accountWallet.length];
        address m = merchants[to % merchants.length];
        uint256 avail = ledger.credit(u) - ledger.lockedCredit(u);
        amount = amount % 3 == 0 ? avail : bound(amount, 1, MAX_AMOUNT);
        if (_paused() || !_activeUser(u) || !_activeMerchant(m)) return;
        if (amount == 0 || amount > avail) return;
        _start();
        _delta(u, -int256(amount));
        _delta(m, int256(amount));
        vm.prank(u);
        ledger.spend(m, amount);
        _end();
    }

    // ================================================================ pool

    function s_deposit(uint256 who, uint256 amount) external {
        address m = merchants[who % merchants.length];
        amount = bound(amount, 1, MAX_AMOUNT);
        if (_paused() || !_activeMerchant(m) || ledger.assetsToShares(amount) == 0) return;
        _start();
        poolRule = PRICE;
        vm.prank(m);
        ledger.deposit(amount);
        _end();
    }

    function s_withdraw(uint256 who, uint256 amount) external {
        address m = merchants[who % merchants.length];
        uint256 cash = ledger.poolUsdc();
        amount = amount % 3 == 0 ? ledger.maxWithdraw(m) : bound(amount, 1, MAX_AMOUNT);
        if (_paused() || amount == 0 || amount > cash) return;
        uint256 needed = LedgerMath.mulDivUp(
            amount, ledger.totalShares() + VS, ledger.poolUsdc() + ledger.totalLent() + 1
        );
        if (needed > ledger.shares(m)) return;
        _withdraw(m, amount, false);
    }

    function s_withdrawAll(uint256 who) external {
        address m = merchants[who % merchants.length];
        if (_paused() || ledger.poolUsdc() == 0) return;
        if (ledger.sharesToAssets(ledger.shares(m)) == 0) return;
        _withdraw(m, 0, true);
    }

    // ================================================================ loans

    function s_requestLoan(uint256 who, uint256 principal) external {
        address u = accountWallet[who % accountWallet.length];
        uint256 avail = ledger.credit(u) - ledger.lockedCredit(u);
        uint256 cash = ledger.poolUsdc();
        // the largest principal both limits allow, or any amount
        uint256 most = _min(avail * LTV_BPS / BPS, cash);
        principal = principal % 2 == 0 ? most : bound(principal, 1, MAX_AMOUNT);
        if (_paused() || !_activeUser(u) || principal == 0 || principal > cash) return;
        if ((principal * BPS + LTV_BPS - 1) / LTV_BPS > avail) return;
        _start();
        vm.prank(u);
        ledger.requestLoan(principal);
        _end();
    }

    function s_repay(uint256 loanSeed) external {
        (uint256 id, address borrower) = _loan(loanSeed | 1); // `| 1`: prefer an Active loan
        if (_paused() || id == 0 || !_active(id)) return;
        (,,,, uint128 principal,) = ledger.loans(id);
        if (usdc.balanceOf(borrower) < principal) return;
        _start();
        vm.prank(borrower);
        ledger.repay(id);
        _end();
    }

    function s_extend(uint256 loanSeed) external {
        (uint256 id, address borrower) = _loan(loanSeed | 1);
        if (_paused() || id == 0 || !_active(id) || !ledger.approvedUser(borrower)) return;
        (, uint64 due,,,,) = ledger.loans(id);
        uint256 now_ = vm.getBlockTimestamp();
        bool inWindow = now_ + EXTENSION_WINDOW >= due && now_ <= due;
        // D-58: after the due date, only if the due date is not before the disruption began
        // and the grace after the unpause is still running.
        bool late = now_ > due && due >= ledger.lastPausedAt()
            && now_ <= uint256(ledger.lastUnpausedAt()) + LIQUIDATION_GRACE;
        if (!inWindow && !late) return;
        _start();
        vm.prank(borrower);
        ledger.extend(id);
        _end();
    }

    function s_liquidate(uint256 loanSeed, uint256 callerSeed) external {
        (uint256 id, address borrower) = _loan(loanSeed | 1);
        if (_paused() || id == 0 || !_active(id)) return;
        (, uint64 due,,, uint128 principal, uint128 collateral) = ledger.loans(id);
        uint256 now_ = vm.getBlockTimestamp();
        if (now_ <= due || now_ <= uint256(ledger.lastUnpausedAt()) + LIQUIDATION_GRACE) return;
        _start();
        poolRule = DEFAULT;
        _delta(borrower, -int256(uint256(collateral)));
        vm.prank(_anyone(callerSeed));
        ledger.liquidate(id);
        _check(
            ledger.poolUsdc() + ledger.totalLent() + principal == aBefore, "I11 liquidate assets"
        );
        _check(ledger.totalShares() == sBefore, "I11 liquidate shares");
        _end();
    }

    // ================================================================ admin and time

    function s_setUser(uint256 who, uint256 seed) external {
        uint256 i = who % accountWallet.length;
        address w = accountWallet[i];
        bytes32 ref = accountRef[i];
        bool approve = seed % 4 != 1;
        if (approve && ledger.participantRole(w) != ROLE_USER) return; // retired, or never a user
        if (!approve && ledger.accountRefOf(w) != ref) return;
        _start();
        vm.prank(admin);
        ledger.setUserApproved(w, approve, ref);
        _end();
    }

    function s_setMerchant(uint256 who, uint256 seed) external {
        address m = merchants[who % merchants.length];
        _start();
        vm.prank(admin);
        ledger.setMerchantApproved(m, seed % 4 != 1); // a merchant's role is fixed, always valid
        _end();
    }

    function s_newTermsVersion() external {
        _start();
        vm.prank(admin);
        ledger.setTermsHash(keccak256(abi.encode("strict-terms", ++termsNonce)));
        _end();
    }

    function s_signTerms(uint256 who) external {
        address a = _anyone(who);
        bytes32 h = ledger.termsHash();
        if (_paused() || ledger.signedTermsHash(a) == h) return;
        _start();
        vm.prank(a);
        ledger.signTerms(h);
        _end();
    }

    function s_moveAccount(uint256 who, uint256 freshSeed) external {
        uint256 i = who % accountWallet.length;
        address oldW = accountWallet[i];
        address newW = fresh[freshSeed % fresh.length];
        if (ledger.participantRole(oldW) != ROLE_USER || ledger.lockedCredit(oldW) != 0) return;
        if (ledger.participantRole(newW) != ROLE_NONE) return;
        uint256 bal = ledger.credit(oldW);
        _start();
        _delta(oldW, -int256(bal));
        _delta(newW, int256(bal));
        vm.prank(admin);
        ledger.adminMoveAccount(oldW, newW, accountRef[i]);
        accountWallet[i] = newW;
        _end();
    }

    function s_togglePause(uint256 seed) external {
        bool paused = _paused();
        if (!paused && seed % 8 != 0) return;
        _start();
        vm.prank(guardian);
        if (paused) ledger.unpause();
        else ledger.pause();
        _end();
    }

    // `warp` and `warpToEdge` are inherited: they never revert.

    // ================================================================ internals

    function _paused() internal view returns (bool) {
        return Pausable(address(ledger)).paused();
    }

    function _activeUser(address u) internal view returns (bool) {
        return ledger.approvedUser(u) && ledger.termsSigned(u);
    }

    function _activeMerchant(address m) internal view returns (bool) {
        return ledger.approvedMerchant(m) && ledger.termsSigned(m);
    }

    function _active(uint256 id) internal view returns (bool) {
        (,,, uint8 status,,) = ledger.loans(id);
        return status == 0;
    }
}
