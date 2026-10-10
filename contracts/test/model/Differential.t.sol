// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {FixtureBase} from "../helpers/Fixture.sol";
import {LedgerModel} from "./LedgerModel.sol";

/// @notice Differential test (P2.3, IT 4): the real ledger and the naive `LedgerModel` take the
///         same random sequence of 1 to 40 calls. After every call they must agree on the revert
///         decision, exactly (same error, same arguments), and on every observable value: each
///         tracked address's approvals, terms, role, credit, lock, shares and link; every loan;
///         every total; the pause state and times; the USDC the ledger holds.
///
///         Amounts are tilted to the edges (0, 1, exactly available, one above, the cap room and
///         one above, 2^128) and kept below 2^128 where the model's plain arithmetic would
///         otherwise overflow; the token is never the limit (every actor holds 10^30 USDC).
///
///         A sequence is one fuzz run. Default and `ci` run fewer sequences than the other fuzz
///         tests because each run is up to 40 calls with a full comparison after each. Deep runs
///         it as 8 shards with different seeds, 125,000 sequences each: 1,000,000 in all (IT 4).
contract DifferentialTest is FixtureBase {
    uint256 internal constant BIG = 1e30;

    LedgerModel internal model;
    address[] internal who; // every address that can act or hold anything
    bytes32[] internal refs; // app account references
    uint256 internal docs; // document hashes issued so far
    uint256 internal termsVersion;
    uint256 internal donated;
    uint256 internal action; // the step being taken, for the mix counts
    mapping(uint256 => uint256) internal accepted;
    mapping(uint256 => uint256) internal refused;

    function setUp() public override {
        super.setUp();
        model = new LedgerModel(
            address(ledger),
            address(usdc),
            admin,
            guardian,
            ledger.ADMIN_ROLE(),
            ledger.GUARDIAN_ROLE()
        );
        who.push(admin);
        who.push(guardian);
        for (uint256 i; i < 12; i++) {
            address a = makeAddr(string.concat("diff", vm.toString(i)));
            usdc.mint(a, BIG);
            vm.prank(a);
            usdc.approve(address(ledger), type(uint256).max);
            who.push(a);
        }
        for (uint256 i; i < 6; i++) {
            refs.push(keccak256(abi.encode("diff-account", i)));
        }
        // Onboarding through the same path as every step: terms, four users, three merchants.
        _newTerms();
        for (uint256 i; i < 4; i++) {
            _step(
                admin,
                abi.encodeCall(IIndicoLedger.setUserApproved, (who[2 + i], true, refs[i])),
                model.setUserApproved(admin, who[2 + i], true, refs[i])
            );
            _sign(who[2 + i]);
        }
        for (uint256 i; i < 3; i++) {
            _step(
                admin,
                abi.encodeCall(IIndicoLedger.setMerchantApproved, (who[6 + i], true)),
                model.setMerchantApproved(admin, who[6 + i], true)
            );
            _sign(who[6 + i]);
        }
    }

    /// forge-config: default.fuzz.runs = 200
    /// forge-config: ci.fuzz.runs = 2000
    /// forge-config: deep.fuzz.runs = 125000
    function testFuzz_realAndModelAgreeAfterEveryCall(uint256 seed) public {
        uint256 n = 1 + seed % 40;
        for (uint256 k; k < n; k++) {
            seed = uint256(keccak256(abi.encode(seed, k)));
            _randomStep(seed);
        }
    }

    /// @dev The mix: over 2,000 seeded steps, every ledger action is both accepted and refused
    ///      at least once (actions 7 and 8 are both `requestLoan`), so agreement is never only on
    ///      refusals.
    function test_mix_everyActionAcceptedAndRefused() public {
        vm.pauseGasMetering(); // a long sequence with a full comparison after every step
        uint256 seed = 7;
        for (uint256 k; k < 2000; k++) {
            seed = uint256(keccak256(abi.encode(seed, k)));
            _randomStep(seed);
        }
        for (uint256 i; i <= 16; i++) {
            if (i == 14) continue; // terms: a new version or a signature, counted together below
            assertGt(accepted[i], 0, string.concat("never accepted: action ", vm.toString(i)));
            assertGt(refused[i], 0, string.concat("never refused: action ", vm.toString(i)));
            emit log_named_string(
                string.concat("action ", vm.toString(i)),
                string.concat(
                    vm.toString(accepted[i]), " accepted, ", vm.toString(refused[i]), " refused"
                )
            );
        }
        assertGt(accepted[14], 0, "terms never accepted");
        assertGt(refused[14], 0, "terms never refused");
    }

    /// @dev The grace edges, scripted, both sides compared at each second: a loan overdue during
    ///      a pause; liquidation at the grace's last second and the next (D-54); then a pause at a
    ///      grace's last second, which merges, and one second later, which starts a new
    ///      disruption (D-58). Random sequences rarely land on these exact seconds.
    function test_graceEdges_agree() public {
        address u = who[2];
        address m = who[6];
        _step(
            admin,
            abi.encodeCall(IIndicoLedger.adminIssueCredit, (u, 1000e6, bytes32(0))),
            model.adminIssueCredit(admin, u, 1000e6)
        );
        _step(m, abi.encodeCall(IIndicoLedger.deposit, (1000e6)), model.deposit(m, 1000e6));
        _step(u, abi.encodeCall(IIndicoLedger.requestLoan, (400e6)), model.requestLoan(u, 400e6));
        (, uint256 due,,,,) = model.loans(1);
        _step(guardian, abi.encodeCall(IIndicoLedger.pause, ()), model.pause(guardian));
        vm.warp(due + 1);
        _step(guardian, abi.encodeCall(IIndicoLedger.unpause, ()), model.unpause(guardian));
        uint256 graceEnd = model.lastUnpausedAt() + 7 days;
        for (uint256 t = graceEnd - 1; t <= graceEnd + 1; t++) {
            vm.warp(t);
            _step(who[9], abi.encodeCall(IIndicoLedger.liquidate, (1)), model.liquidate(1));
        }
        assertEq(model.poolCredit(), 500e6, "liquidated exactly once, after the grace");

        // A pause at a grace's last second merges into the last disruption; a second later not.
        _step(guardian, abi.encodeCall(IIndicoLedger.pause, ()), model.pause(guardian));
        _step(guardian, abi.encodeCall(IIndicoLedger.unpause, ()), model.unpause(guardian));
        uint256 end2 = model.lastUnpausedAt() + 7 days;
        vm.warp(end2);
        _step(guardian, abi.encodeCall(IIndicoLedger.pause, ()), model.pause(guardian));
        _step(guardian, abi.encodeCall(IIndicoLedger.unpause, ()), model.unpause(guardian));
        vm.warp(model.lastUnpausedAt() + 7 days + 1);
        uint256 before = model.lastPausedAt();
        _step(guardian, abi.encodeCall(IIndicoLedger.pause, ()), model.pause(guardian));
        assertGt(model.lastPausedAt(), before, "a new disruption one second after the grace");
    }

    // ================================================================== one random step

    function _randomStep(uint256 r) internal {
        uint256 r1 = uint256(keccak256(abi.encode(r, 1)));
        uint256 r2 = uint256(keccak256(abi.encode(r, 2)));
        address c = _anyone(r1); // the caller: anyone, so access refusals are exercised
        address x = _anyone(r2 >> 8); // a second address: target, merchant, new wallet
        action = r % 20;
        // Mostly the role the action needs, so most calls can succeed; 1 in 6 anyone (_role).
        if (
            action == 0 || action == 3 || action == 7 || action == 8 || action == 14 || action == 15
        ) {
            c = _role(r1, USER);
        }
        if (action >= 4 && action <= 6) c = _role(r1, MERCHANT);
        if (action == 1) x = _role(r2 >> 8, USER);
        if (action == 2) x = _role(r2 >> 8, (r2 >> 4) % 2 == 0 ? USER : MERCHANT);
        if (action == 3) x = _role(r2 >> 8, MERCHANT);
        if (action == 15) x = _role(r2 >> 8, NONE);

        if (action == 0) {
            bytes32 doc = r2 % 9 == 0 && docs > 0
                ? keccak256(abi.encode(docs - 1))
                : keccak256(abi.encode(docs++));
            if (r2 % 23 == 0) doc = 0;
            uint8 t = uint8(r2 % 8);
            uint256 v = _amount(r1 >> 16, c);
            _step(
                c,
                abi.encodeCall(IIndicoLedger.registerAsset, (doc, t, v)),
                model.registerAsset(c, doc, t, v)
            );
        } else if (action == 1) {
            address by = _adminMostly(r1, c);
            uint256 v = _amount(r2, x);
            _step(
                by,
                abi.encodeCall(IIndicoLedger.adminIssueCredit, (x, v, bytes32(v))),
                model.adminIssueCredit(by, x, v)
            );
        } else if (action == 2) {
            address by = _adminMostly(r1, c);
            uint256 v = _amount(r2, x);
            _step(
                by,
                abi.encodeCall(IIndicoLedger.adminDebitCredit, (x, v, bytes32(v))),
                model.adminDebitCredit(by, x, v)
            );
        } else if (action == 3) {
            uint256 v = _amount(r2, c);
            if (r2 % 31 == 0) x = address(0);
            _step(c, abi.encodeCall(IIndicoLedger.spend, (x, v)), model.spend(c, x, v));
        } else if (action == 4) {
            uint256 v = _amount(r2, c) % 2 ** 64; // a deposit is real USDC: below each actor's balance
            _step(c, abi.encodeCall(IIndicoLedger.deposit, (v)), model.deposit(c, v));
        } else if (action == 5) {
            uint256 v = r2 % 3 == 0 ? ledger.maxWithdraw(c) : _amount(r2, c);
            _step(c, abi.encodeCall(IIndicoLedger.withdraw, (v)), model.withdraw(c, v));
        } else if (action == 6) {
            _step(c, abi.encodeCall(IIndicoLedger.withdrawAll, ()), model.withdrawAll(c));
        } else if (action == 7 || action == 8) {
            uint256 avail = model.credit(c) - model.locked(c);
            uint256 p = r2 % 3 == 0
                ? avail * 8000 / 10_000
                : r2 % 3 == 1 ? model.poolUsdc() : _amount(r2 >> 8, c);
            _step(c, abi.encodeCall(IIndicoLedger.requestLoan, (p)), model.requestLoan(c, p));
        } else if (action == 9) {
            (uint256 id, address b) = _loan(r2);
            address by = r1 % 4 == 0 ? c : b;
            _step(by, abi.encodeCall(IIndicoLedger.repay, (id)), model.repay(by, id));
        } else if (action == 10) {
            (uint256 id, address b) = r2 % 4 == 0 ? _loan(r2) : _extendableLoan(r2);
            address by = r1 % 4 == 0 ? c : b;
            if (r1 % 2 == 1) {
                // half the time, first move the clock to a moment inside the loan's window
                (, uint256 due,,,,) = model.loans(id);
                uint256 t = due > 30 days ? due - 30 days + (r1 >> 8) % 30 days : 0;
                if (t > vm.getBlockTimestamp()) vm.warp(t);
            }
            _step(by, abi.encodeCall(IIndicoLedger.extend, (id)), model.extend(by, id));
        } else if (action == 11) {
            (uint256 id,) = _loan(r2);
            if (r1 % 3 == 0) _warpToGraceEnd(r1 >> 8); // the grace's last second, or the next
            _step(c, abi.encodeCall(IIndicoLedger.liquidate, (id)), model.liquidate(id));
        } else if (action == 12) {
            address by = _adminMostly(r1, c);
            bool approve = r2 % 4 != 0;
            bytes32 ref = r2 % 5 == 0 ? bytes32(0) : refs[(r2 >> 8) % refs.length];
            if (!approve && r2 % 3 != 0) ref = model.accountRefOf(x); // mostly the right reference
            _step(
                by,
                abi.encodeCall(IIndicoLedger.setUserApproved, (x, approve, ref)),
                model.setUserApproved(by, x, approve, ref)
            );
        } else if (action == 13) {
            address by = _adminMostly(r1, c);
            bool approve = r2 % 4 != 0;
            _step(
                by,
                abi.encodeCall(IIndicoLedger.setMerchantApproved, (x, approve)),
                model.setMerchantApproved(by, x, approve)
            );
        } else if (action == 14) {
            if (r2 % 3 == 0) _newTerms();
            else _sign(c);
        } else if (action == 15) {
            address by = _adminMostly(r1, c);
            bytes32 ref = r2 % 4 == 0 ? refs[(r2 >> 8) % refs.length] : model.accountRefOf(c);
            _step(
                by,
                abi.encodeCall(IIndicoLedger.adminMoveAccount, (c, x, ref)),
                model.adminMoveAccount(by, c, x, ref)
            );
        } else if (action == 16) {
            address by = r1 % 8 == 0 ? c : guardian;
            bool wrong = r2 % 10 == 0; // the wrong state: EnforcedPause, ExpectedPause
            if (!model.paused() && !wrong && r2 % 6 != 1) return _compare(); // pause rarely
            if (!model.paused() && r1 % 3 == 0) _warpToGraceEnd(r1 >> 8); // D-58's merge edge
            if (model.paused() != wrong) {
                _step(by, abi.encodeCall(IIndicoLedger.unpause, ()), model.unpause(by));
            } else {
                _step(by, abi.encodeCall(IIndicoLedger.pause, ()), model.pause(by));
            }
        } else if (action == 17) {
            uint256 v = 1 + r2 % 1e12;
            usdc.mint(address(ledger), v); // straight to the ledger: counted nowhere (D-38)
            donated += v;
            _compare();
        } else if (action == 18) {
            vm.warp(vm.getBlockTimestamp() + 1 + r2 % 120 days);
            _compare();
        } else {
            _warpToEdge(r2);
            _compare();
        }
    }

    // ================================================================== the comparison

    /// @dev Both sides take the call; the revert decision must match exactly, then the state.
    function _step(address caller, bytes memory data, bytes memory modelErr) internal {
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(ledger).call(data);
        // Messages are built only on a mismatch: building them every step costs memory and gas.
        if (modelErr.length == 0) {
            accepted[action]++;
            if (!ok) {
                fail(string.concat("real refused what the model accepts: ", vm.toString(ret)));
            }
        } else {
            refused[action]++;
            if (ok) {
                fail(string.concat("real accepted what the model refuses: ", vm.toString(modelErr)));
            }
            if (keccak256(ret) != keccak256(modelErr)) {
                fail(
                    string.concat(
                        "a different refusal: ", vm.toString(ret), " vs ", vm.toString(modelErr)
                    )
                );
            }
        }
        _compare();
    }

    function _compare() internal view {
        assertEq(ledger.termsHash(), model.termsHash(), "termsHash");
        assertEq(ledger.totalCredit(), model.totalCredit(), "totalCredit");
        assertEq(ledger.poolCredit(), model.poolCredit(), "poolCredit");
        assertEq(ledger.totalShares(), model.totalShares(), "totalShares");
        assertEq(ledger.totalLent(), model.totalLent(), "totalLent");
        assertEq(ledger.poolUsdc(), model.poolUsdc(), "poolUsdc");
        assertEq(ledger.nextLoanId(), model.nextLoanId(), "nextLoanId");
        assertEq(ledger.lastPausedAt(), model.lastPausedAt(), "lastPausedAt");
        assertEq(ledger.lastUnpausedAt(), model.lastUnpausedAt(), "lastUnpausedAt");
        assertEq(usdc.balanceOf(address(ledger)), model.poolUsdc() + donated, "USDC held");
        for (uint256 i; i < who.length; i++) {
            address a = who[i];
            assertEq(ledger.approvedUser(a), model.approvedUser(a), "approvedUser");
            assertEq(ledger.approvedMerchant(a), model.approvedMerchant(a), "approvedMerchant");
            assertEq(ledger.termsSigned(a), model.termsSigned(a), "termsSigned");
            assertEq(ledger.signedTermsHash(a), model.signedTermsHash(a), "signedTermsHash");
            assertEq(ledger.participantRole(a), model.role(a), "participantRole");
            assertEq(ledger.credit(a), model.credit(a), "credit");
            assertEq(ledger.lockedCredit(a), model.locked(a), "lockedCredit");
            assertEq(ledger.shares(a), model.shares(a), "shares");
            assertEq(ledger.accountRefOf(a), model.accountRefOf(a), "accountRefOf");
        }
        for (uint256 i; i < refs.length; i++) {
            assertEq(
                ledger.walletOfAccount(refs[i]), model.walletOfAccount(refs[i]), "walletOfAccount"
            );
        }
        for (uint256 id = 1; id <= model.nextLoanId(); id++) {
            (address b, uint64 due, uint16 ext, uint8 st, uint128 p, uint128 k) = ledger.loans(id);
            (address mb, uint256 mdue, uint256 mext, uint8 mst, uint256 mp, uint256 mk) =
                model.loans(id);
            assertEq(b, mb, "loan borrower");
            assertEq(due, mdue, "loan dueDate");
            assertEq(ext, mext, "loan extensionCount");
            assertEq(st, mst, "loan status");
            assertEq(p, mp, "loan principal");
            assertEq(k, mk, "loan collateral");
        }
    }

    // ================================================================== choosers

    uint8 internal constant NONE = 0;
    uint8 internal constant USER = 1;
    uint8 internal constant MERCHANT = 2;

    /// @dev 5 times in 6 the first address from a seeded position holding `want` in the model
    ///      (approved, for a user or merchant); otherwise, or if none does, anyone.
    function _role(uint256 r, uint8 want) internal view returns (address) {
        if (r % 6 == 5) return _anyone(r >> 3);
        for (uint256 k; k < who.length; k++) {
            address a = who[(r % who.length + k) % who.length];
            if (model.role(a) != want) continue;
            if (want == USER && !model.approvedUser(a)) continue;
            if (want == MERCHANT && !model.approvedMerchant(a)) continue;
            return a;
        }
        return _anyone(r >> 3);
    }

    function _anyone(uint256 r) internal view returns (address) {
        return who[r % who.length];
    }

    function _adminMostly(uint256 r, address other) internal view returns (address) {
        return r % 8 == 0 ? other : admin;
    }

    /// @dev Edges first, by the model's state for `a`: 0, 1, exactly available, available + 1,
    ///      the whole credit, the cap room, room + 1, 2^128; otherwise 1 to 10^13.
    function _amount(uint256 r, address a) internal view returns (uint256) {
        uint256 avail = model.credit(a) - model.locked(a);
        uint256 room = 2 ** 128 - 1 - _min(model.credit(a), 2 ** 128 - 1);
        uint256 pick = r % 12;
        if (pick == 0) return 0;
        if (pick == 1) return 1;
        if (pick == 2) return avail;
        if (pick == 3) return avail + 1;
        if (pick == 4) return model.credit(a);
        if (pick == 5) return room;
        if (pick == 6) return room + 1;
        if (pick == 7) return 2 ** 128;
        return 1 + (r >> 8) % 1e13;
    }

    /// @dev A loan id: mostly an existing one, sometimes 0 or one past the end.
    function _loan(uint256 r) internal view returns (uint256 id, address borrower) {
        uint256 n = model.nextLoanId();
        id = r % 10 == 0 ? 0 : r % 10 == 1 ? n + 1 : n == 0 ? 1 : 1 + (r >> 8) % n;
        (borrower,,,,,) = model.loans(id);
        if (borrower == address(0)) borrower = who[2];
    }

    /// @dev An Active loan not yet past its due date, from a seeded position; else any loan.
    function _extendableLoan(uint256 r) internal view returns (uint256 id, address borrower) {
        uint256 n = model.nextLoanId();
        for (uint256 k; k < n; k++) {
            uint256 c = 1 + (r % n + k) % n;
            (address b, uint256 due,, uint8 st,,) = model.loans(c);
            if (st == 0 && due >= vm.getBlockTimestamp()) return (c, b);
        }
        return _loan(r);
    }

    /// @dev To the grace's last second, or one second after, if that is still ahead.
    function _warpToGraceEnd(uint256 r) internal {
        uint256 t = model.lastUnpausedAt() + 7 days + r % 2;
        if (t > vm.getBlockTimestamp()) vm.warp(t);
    }

    function _warpToEdge(uint256 r) internal {
        (uint256 id,) = _loan(r | 2);
        (, uint256 due,,,,) = model.loans(id);
        uint256 graceEnd = model.lastUnpausedAt() + 7 days;
        uint256[6] memory edges = [
            due > 30 days ? due - 30 days : 0, due, due + 1, graceEnd, graceEnd + 1, due + 90 days
        ];
        uint256 target = edges[(r >> 8) % 6];
        uint256 now_ = vm.getBlockTimestamp();
        vm.warp(target > now_ ? target : now_ + 1);
    }

    function _newTerms() internal {
        bytes32 h = keccak256(abi.encode("diff-terms", ++termsVersion));
        _step(admin, abi.encodeCall(IIndicoLedger.setTermsHash, (h)), model.setTermsHash(admin, h));
    }

    function _sign(address a) internal {
        bytes32 h = model.termsHash();
        _step(a, abi.encodeCall(IIndicoLedger.signTerms, (h)), model.signTerms(a, h));
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
