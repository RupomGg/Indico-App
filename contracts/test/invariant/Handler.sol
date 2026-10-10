// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {CREDIT_CAP, TERM, EXTENSION_WINDOW, LIQUIDATION_GRACE} from "../../src/lib/Constants.sol";
import {MockUSDC} from "../helpers/MockUSDC.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice The invariant handler (P2.1, TS 2.3). Every public non-view function is one action the
///         fuzzer may call. Inputs are seeds: each action picks its caller and target from fixed
///         actor sets, mostly the right set, sometimes a wrong one, so refusals stay exercised.
///
///         A refused call is not swallowed: the ledger's revert propagates, the EVM rolls the call
///         back, and Forge's metrics table counts it per action (calls and reverts).
///
///         Per-call properties are never asserted here, because a failing assert is just another
///         revert and would vanish under `fail_on_revert = false`. They are recorded in
///         `violations` and `firstViolation`, which the invariant functions assert on:
///         - exact credit deltas: every tracked address's credit changes by exactly what the action
///           should do to it, and nothing else changes (I8, I12; D-66);
///         - spend and debit never leave credit below locked credit (I9);
///         - a withdrawal never pays more than `poolUsdc` held before it (I10);
///         - the share price rules (I11, D-65).
contract Handler is Test {
    uint256 internal constant MAX_AMOUNT = 10_000_000e6;
    uint256 internal constant VS = 1e6; // virtual shares, D-38
    uint256 internal constant FUND = 1e18; // USDC per actor: never the limit

    IIndicoLedger public immutable ledger;
    MockUSDC public immutable usdc;
    address public immutable admin;
    address public immutable guardian;

    /// @dev Every address that can ever hold credit or shares. Credit only reaches these.
    address[] public tracked;
    /// @dev App accounts: the current wallet and the reference of each.
    address[] public accountWallet;
    bytes32[] public accountRef;
    address[] public merchants;
    address[] public outsiders;
    address[] public fresh;

    uint256 public ghostMinted;
    uint256 public ghostBurned;
    uint256 public violations;
    string public firstViolation;

    uint256 internal docNonce;
    uint256 internal termsNonce;

    // per-call bookkeeping
    uint256[] internal creditBefore;
    address[] internal deltaWho;
    int256[] internal deltaBy;
    uint256 internal aBefore;
    uint256 internal sBefore;
    /// @dev What the action may do to A = poolUsdc + totalLent and S = totalShares (I11, D-65):
    ///      KEEP leaves both exactly unchanged; PRICE may not lower A/S; DEFAULT is checked in place.
    uint8 internal poolRule;
    uint8 internal constant KEEP = 0;
    uint8 internal constant PRICE = 1;
    uint8 internal constant DEFAULT = 2;

    constructor(IIndicoLedger ledger_, MockUSDC usdc_, address admin_, address guardian_) {
        ledger = ledger_;
        usdc = usdc_;
        admin = admin_;
        guardian = guardian_;
        bytes32 terms = ledger_.termsHash();
        for (uint256 i; i < 5; i++) {
            address u = _newActor(string.concat("inv-user", vm.toString(i)));
            bytes32 ref = keccak256(abi.encode("inv-account", i));
            vm.prank(admin_);
            ledger_.setUserApproved(u, true, ref);
            vm.prank(u);
            ledger_.signTerms(terms);
            accountWallet.push(u);
            accountRef.push(ref);
        }
        for (uint256 i; i < 3; i++) {
            address m = _newActor(string.concat("inv-merchant", vm.toString(i)));
            vm.prank(admin_);
            ledger_.setMerchantApproved(m, true);
            vm.prank(m);
            ledger_.signTerms(terms);
            merchants.push(m);
        }
        for (uint256 i; i < 2; i++) {
            outsiders.push(_newActor(string.concat("inv-outsider", vm.toString(i))));
        }
        for (uint256 i; i < 10; i++) {
            fresh.push(_newActor(string.concat("inv-fresh", vm.toString(i))));
        }
    }

    // ================================================================ actions: credit

    function registerAsset(uint256 who, uint256 typeSeed, uint256 value) external {
        address u = _user(who);
        uint8 t = uint8(bound(typeSeed, 0, 7)); // 6 and 7 are refused
        if (value % 50 == 0) value = CREDIT_CAP - _min(ledger.credit(u), CREDIT_CAP); // the cap
        else value = bound(value, 1, MAX_AMOUNT);
        bytes32 doc = value % 17 == 0 && docNonce > 0
            ? keccak256(abi.encode(docNonce - 1))  // a reused hash: AssetAlreadyRegistered
            : keccak256(abi.encode(docNonce++));
        _start();
        _delta(u, int256(value));
        vm.prank(u);
        ledger.registerAsset(doc, t, value);
        ghostMinted += value;
        _end();
    }

    function adminIssue(uint256 who, uint256 amount) external {
        address u = _user(who);
        amount = bound(amount, 1, MAX_AMOUNT);
        _start();
        _delta(u, int256(amount));
        vm.prank(admin);
        ledger.adminIssueCredit(u, amount, bytes32(amount));
        ghostMinted += amount;
        _end();
    }

    function adminDebit(uint256 who, uint256 amount) external {
        address a = who % 3 == 0 ? _merchant(who) : _user(who); // D-63: merchants too
        amount = _edgeAmount(amount, ledger.available(a), ledger.credit(a));
        _start();
        _delta(a, -int256(amount));
        vm.prank(admin);
        ledger.adminDebitCredit(a, amount, bytes32(amount));
        ghostBurned += amount;
        _check(ledger.credit(a) >= ledger.lockedCredit(a), "I9 debit below locked");
        _end();
    }

    function spend(uint256 who, uint256 to, uint256 amount) external {
        address u = _user(who);
        address m = _merchant(to);
        amount = _edgeAmount(amount, ledger.available(u), ledger.credit(u));
        _start();
        _delta(u, -int256(amount));
        _delta(m, int256(amount));
        vm.prank(u);
        ledger.spend(m, amount);
        _check(ledger.credit(u) >= ledger.lockedCredit(u), "I9 spend below locked");
        _end();
    }

    // ================================================================ actions: pool

    function deposit(uint256 who, uint256 amount) external {
        address m = _merchant(who);
        amount = bound(amount, 1, MAX_AMOUNT);
        _start();
        poolRule = PRICE;
        uint256 sharesBefore = ledger.shares(m);
        uint256 cashBefore = ledger.poolUsdc();
        vm.prank(m);
        ledger.deposit(amount);
        uint256 minted = ledger.shares(m) - sharesBefore;
        uint256 received = ledger.poolUsdc() - cashBefore;
        // I11: the depositor loses at most 1 wei: minted * (A+1) >= (received - 1) * (S+1e6).
        _check(
            minted * (aBefore + 1) + (sBefore + VS) >= received * (sBefore + VS), "I11 deposit loss"
        );
        _end();
    }

    function withdraw(uint256 who, uint256 amount) external {
        address m = _merchant(who);
        amount = amount % 4 == 0 ? ledger.maxWithdraw(m) : bound(amount, 1, MAX_AMOUNT);
        _withdraw(m, amount, false);
    }

    function withdrawAll(uint256 who) external {
        _withdraw(_merchant(who), 0, true);
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, MAX_AMOUNT);
        _start();
        usdc.mint(address(ledger), amount); // a direct transfer: counted nowhere (D-38)
        _end();
    }

    // ================================================================ actions: loans

    function requestLoan(uint256 who, uint256 principal) external {
        address u = _user(who);
        if (principal % 4 == 0) principal = _min(ledger.maxBorrow(u), ledger.poolAvailable());
        else if (principal % 4 == 1) principal = ledger.maxBorrow(u);
        else principal = bound(principal, 1, MAX_AMOUNT);
        _start();
        vm.prank(u);
        ledger.requestLoan(principal);
        _end();
    }

    function repay(uint256 loanSeed, uint256 callerSeed) external {
        // Usually any id, so loans live long enough to be extended or default.
        (uint256 id, address borrower) = _loan(callerSeed % 3 == 0 ? loanSeed : loanSeed * 4);
        address caller = callerSeed % 8 == 0 ? _anyone(callerSeed) : borrower;
        _start();
        vm.prank(caller);
        ledger.repay(id);
        _end();
    }

    function extend(uint256 loanSeed, uint256 callerSeed) external {
        (uint256 id, address borrower) = _loan(loanSeed);
        address caller = callerSeed % 8 == 0 ? _anyone(callerSeed) : borrower;
        _start();
        vm.prank(caller);
        ledger.extend(id);
        _end();
    }

    function liquidate(uint256 loanSeed, uint256 callerSeed) external {
        (uint256 id, address borrower) = _loan(loanSeed);
        (,,,, uint128 principal, uint128 collateral) = ledger.loans(id);
        address caller = _anyone(callerSeed);
        _start();
        poolRule = DEFAULT;
        _delta(borrower, -int256(uint256(collateral)));
        vm.prank(caller);
        ledger.liquidate(id);
        // I11: assets fall by exactly the principal, shares unchanged.
        _check(
            ledger.poolUsdc() + ledger.totalLent() + principal == aBefore, "I11 liquidate assets"
        );
        _check(ledger.totalShares() == sBefore, "I11 liquidate shares");
        _end();
    }

    // ================================================================ actions: admin

    function setUser(uint256 who, uint256 refSeed) external {
        bool approved = refSeed % 4 != 1; // revoke 1 time in 4, so most users stay active
        uint256 i = who % accountWallet.length;
        address w = accountWallet[i];
        bytes32 ref = refSeed % 8 == 0 ? bytes32(refSeed) : accountRef[i]; // sometimes wrong
        if (who % 10 == 0) w = _anyone(who); // a merchant, outsider or fresh wallet
        _start();
        vm.prank(admin);
        ledger.setUserApproved(w, approved, ref);
        _end();
    }

    function setMerchant(uint256 who, uint256 seed) external {
        bool approved = seed % 4 != 1;
        address m = who % 10 == 0 ? _anyone(who) : _merchant(who);
        _start();
        vm.prank(admin);
        ledger.setMerchantApproved(m, approved);
        _end();
    }

    function newTermsVersion() external {
        _start();
        vm.prank(admin);
        ledger.setTermsHash(keccak256(abi.encode("inv-terms", ++termsNonce)));
        _end();
    }

    function signTerms(uint256 who) external {
        address a = _anyone(who);
        bytes32 h = ledger.termsHash();
        _start();
        vm.prank(a);
        ledger.signTerms(h);
        _end();
    }

    function moveAccount(uint256 who, uint256 refSeed) external {
        uint256 i = who % accountWallet.length;
        address oldW = accountWallet[i];
        address newW = who % 8 == 0 ? _anyone(refSeed) : fresh[refSeed % fresh.length];
        bytes32 ref = refSeed % 8 == 0 ? bytes32(refSeed) : accountRef[i];
        uint256 bal = ledger.credit(oldW);
        _start();
        _delta(oldW, -int256(bal));
        _delta(newW, int256(bal));
        vm.prank(admin);
        ledger.adminMoveAccount(oldW, newW, ref);
        accountWallet[i] = newW;
        _end();
    }

    /// @dev Unpauses when paused; otherwise pauses 1 time in 8, so most calls run unpaused.
    ///      Both directions are still refused sometimes: a wrong caller 1 time in 8.
    function togglePause(uint256 seed) external {
        address caller = seed % 8 == 7 ? _anyone(seed) : guardian;
        bool paused = Pausable(address(ledger)).paused();
        if (!paused && seed % 8 != 0) return;
        _start();
        vm.prank(caller);
        if (paused) ledger.unpause();
        else ledger.pause();
        _end();
    }

    // ================================================================ actions: time

    function warp(uint256 secs) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 120 days));
    }

    /// @dev Jumps to an edge of a loan's window, its due date or the grace end; forward only.
    function warpToEdge(uint256 loanSeed, uint256 which) external {
        (uint256 id,) = _loan(loanSeed);
        if (id == 0) return;
        (, uint64 due,,,,) = ledger.loans(id);
        uint256 graceEnd = uint256(ledger.lastUnpausedAt()) + LIQUIDATION_GRACE;
        uint256[6] memory edges = [
            uint256(due) - EXTENSION_WINDOW,
            due,
            uint256(due) + 1,
            graceEnd,
            graceEnd + 1,
            uint256(due) + TERM
        ];
        uint256 target = edges[which % 6];
        uint256 now_ = vm.getBlockTimestamp();
        vm.warp(target > now_ ? target : now_ + 1);
    }

    // ================================================================ views for the invariants

    function trackedCount() external view returns (uint256) {
        return tracked.length;
    }

    function merchantCount() external view returns (uint256) {
        return merchants.length;
    }

    function accountCount() external view returns (uint256) {
        return accountRef.length;
    }

    // ================================================================ internals

    function _withdraw(address m, uint256 amount, bool all) internal {
        _start();
        poolRule = PRICE;
        uint256 sharesBefore = ledger.shares(m);
        uint256 cashBefore = ledger.poolUsdc();
        vm.prank(m);
        if (all) ledger.withdrawAll();
        else ledger.withdraw(amount);
        uint256 burned = sharesBefore - ledger.shares(m);
        uint256 paid = cashBefore - ledger.poolUsdc();
        _check(paid <= cashBefore, "I10 paid above poolUsdc");
        // I11: the withdrawer loses at most 1 wei: burned * (A+1) <= (paid + 1) * (S+1e6).
        _check(burned * (aBefore + 1) <= (paid + 1) * (sBefore + VS), "I11 withdraw loss");
        _end();
    }

    /// @dev Records the state before an action; clears the expected credit deltas.
    function _start() internal {
        delete deltaWho;
        delete deltaBy;
        delete creditBefore;
        for (uint256 i; i < tracked.length; i++) {
            creditBefore.push(ledger.credit(tracked[i]));
        }
        aBefore = ledger.poolUsdc() + ledger.totalLent();
        sBefore = ledger.totalShares();
        poolRule = KEEP;
    }

    function _delta(address who, int256 by) internal {
        deltaWho.push(who);
        deltaBy.push(by);
    }

    /// @dev After a successful action: exact credit deltas, and the share price never falls.
    ///      Products stay far below 2^256: A and S are bounded by the amounts above (< 2^110).
    function _end() internal {
        for (uint256 i; i < tracked.length; i++) {
            int256 want;
            for (uint256 j; j < deltaWho.length; j++) {
                if (deltaWho[j] == tracked[i]) want += deltaBy[j];
            }
            int256 got = int256(ledger.credit(tracked[i])) - int256(creditBefore[i]);
            if (got != want) {
                _check(false, string.concat("I8/I12 credit delta of ", vm.toString(tracked[i])));
            }
        }
        uint256 a = ledger.poolUsdc() + ledger.totalLent();
        uint256 s = ledger.totalShares();
        if (poolRule == KEEP) {
            _check(a == aBefore && s == sBefore, "I11 A or S moved");
        } else if (poolRule == PRICE) {
            _check((a + 1) * (sBefore + VS) >= (aBefore + 1) * (s + VS), "I11 price fell");
        }
    }

    function _check(bool ok, string memory why) internal {
        if (ok) return;
        violations++;
        if (bytes(firstViolation).length == 0) firstViolation = why;
    }

    function _newActor(string memory name) internal returns (address a) {
        a = makeAddr(name);
        usdc.mint(a, FUND);
        vm.prank(a);
        usdc.approve(address(ledger), type(uint256).max);
        tracked.push(a);
    }

    /// @dev Mostly an account's current wallet; 1 in 8 anyone else.
    function _user(uint256 seed) internal view returns (address) {
        if (seed % 8 == 7) return _anyone(seed / 8);
        return accountWallet[seed % accountWallet.length];
    }

    function _merchant(uint256 seed) internal view returns (address) {
        if (seed % 8 == 7) return _anyone(seed / 8);
        return merchants[seed % merchants.length];
    }

    function _anyone(uint256 seed) internal view returns (address) {
        return tracked[seed % tracked.length];
    }

    /// @dev A loan id: 3 times in 4 the first Active loan at or after the seed's position, else
    ///      any id from 1 to `nextLoanId` (closed loans exercise the refusals). 0 if none exist.
    function _loan(uint256 seed) internal view returns (uint256 id, address borrower) {
        uint256 n = ledger.nextLoanId();
        if (n == 0) return (0, address(0));
        id = 1 + seed % n;
        if (seed % 4 != 0) {
            for (uint256 k; k < n; k++) {
                uint256 c = 1 + (seed + k) % n;
                (,,, uint8 status,,) = ledger.loans(c);
                if (status == 0) {
                    id = c;
                    break;
                }
            }
        }
        (borrower,,,,,) = ledger.loans(id);
    }

    /// @dev Boundaries first: exactly available; one wei above it (refused unless the lock is
    ///      ignored, I9); all of the credit including the lock; otherwise any amount.
    function _edgeAmount(uint256 seed, uint256 avail, uint256 cred)
        internal
        pure
        returns (uint256)
    {
        if (seed % 5 == 0) return avail;
        if (seed % 5 == 1) return avail + 1;
        if (seed % 5 == 2) return cred;
        return bound(seed, 1, MAX_AMOUNT);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
