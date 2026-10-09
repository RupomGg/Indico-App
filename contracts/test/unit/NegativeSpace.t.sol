// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {TERM} from "../../src/lib/Constants.sol";
import {MockUSDC} from "../helpers/MockUSDC.sol";
import {Actors} from "../helpers/Actors.sol";

/// @notice Negative space (IT 5): inputs nobody intended, against every function in the ABI.
///
/// | Input                                         | Expected                                        |
/// |-----------------------------------------------|-------------------------------------------------|
/// | a selector the ledger does not have           | reverts, empty data (no fallback), no change    |
/// | empty calldata, with or without ETH           | reverts (no receive), no change                 |
/// | every function, calldata one byte short       | reverts, empty data, no change                  |
/// | every function, 100 bytes appended, the last  | identical success, return data and net writes:  |
/// | 20 the admin's address                        | trailing bytes never change who acts            |
/// | every function sent 1 wei of ETH              | reverts (nothing is payable), no change         |
/// | a stray ERC-20 sent to the ledger             | no ledger slot written; no function moves it    |
/// | the token re-enters, 5 USDC functions x 19    | the guard, or the target's own refusal as the   |
/// | targets                                       | token address; the outer call rolls back whole  |
///
/// The list of calls is checked against the compiled ABI (`methodIdentifiers`), so a function
/// added later fails `test_everyAbiFunctionIsListed` until it is listed here.
contract NegativeSpaceTest is Actors {
    struct Call {
        address who;
        bytes data;
    }

    address internal stranger = makeAddr("stranger");
    uint64 internal due1;

    function setUp() public override {
        super.setUp();
        _mintCredit(alice, 2_000e6);
        _fundPool(1_000e6);
        vm.prank(alice);
        ledger.requestLoan(400e6); // loan 1
        (, due1,,,,) = ledger.loans(1);
    }

    // ================================================================== the call list

    function _calls() internal view returns (Call[] memory c) {
        c = new Call[](69);
        uint256 i;
        // views, by a stranger
        c[i++] = Call(stranger, abi.encodeWithSignature("ADMIN_ROLE()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("DEFAULT_ADMIN_ROLE()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("GUARDIAN_ROLE()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("accountRefOf(address)", alice));
        c[i++] = Call(stranger, abi.encodeWithSignature("approvedMerchant(address)", merchantA));
        c[i++] = Call(stranger, abi.encodeWithSignature("approvedUser(address)", alice));
        c[i++] = Call(stranger, abi.encodeWithSignature("assetRegistered(bytes32)", bytes32("d")));
        c[i++] = Call(stranger, abi.encodeWithSignature("assetsToShares(uint256)", 1e6));
        c[i++] = Call(stranger, abi.encodeWithSignature("available(address)", alice));
        c[i++] = Call(stranger, abi.encodeWithSignature("collateralFor(uint256)", 8e6));
        c[i++] = Call(stranger, abi.encodeWithSignature("credit(address)", alice));
        c[i++] = Call(stranger, abi.encodeWithSignature("defaultAdmin()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("defaultAdminDelay()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("defaultAdminDelayIncreaseWait()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("getRoleAdmin(bytes32)", bytes32(0)));
        c[i++] =
            Call(stranger, abi.encodeWithSignature("hasRole(bytes32,address)", bytes32(0), admin));
        c[i++] = Call(stranger, abi.encodeWithSignature("lastPausedAt()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("lastUnpausedAt()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("loans(uint256)", 1));
        c[i++] = Call(stranger, abi.encodeWithSignature("lockedCredit(address)", alice));
        c[i++] = Call(stranger, abi.encodeWithSignature("maxBorrow(address)", alice));
        c[i++] = Call(stranger, abi.encodeWithSignature("maxWithdraw(address)", merchantA));
        c[i++] = Call(stranger, abi.encodeWithSignature("nextLoanId()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("owner()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("participantRole(address)", alice));
        c[i++] = Call(stranger, abi.encodeWithSignature("paused()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("pendingDefaultAdmin()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("pendingDefaultAdminDelay()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("poolAvailable()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("poolCredit()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("poolTotalAssets()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("poolUsdc()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("shares(address)", merchantA));
        c[i++] = Call(stranger, abi.encodeWithSignature("sharesToAssets(uint256)", 1e12));
        c[i++] = Call(stranger, abi.encodeWithSignature("signedTermsHash(address)", alice));
        c[i++] = Call(
            stranger, abi.encodeWithSignature("supportsInterface(bytes4)", bytes4(0x01ffc9a7))
        );
        c[i++] = Call(stranger, abi.encodeWithSignature("termsHash()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("termsSigned(address)", alice));
        c[i++] = Call(stranger, abi.encodeWithSignature("totalCredit()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("totalLent()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("totalShares()"));
        c[i++] = Call(stranger, abi.encodeWithSignature("usdc()"));
        c[i++] =
            Call(stranger, abi.encodeWithSignature("walletOfAccount(bytes32)", _accountRef(alice)));
        // state-changing, each by the caller that would normally send it
        bytes32 adminRole = keccak256("ADMIN_ROLE");
        bytes32 guardianRole = keccak256("GUARDIAN_ROLE");
        c[i++] = Call(admin, abi.encodeCall(IIndicoLedger.setTermsHash, (keccak256("t2"))));
        c[i++] = Call(
            admin, abi.encodeCall(IIndicoLedger.setUserApproved, (stranger, true, bytes32("s")))
        );
        c[i++] = Call(admin, abi.encodeCall(IIndicoLedger.setMerchantApproved, (stranger, true)));
        c[i++] = Call(stranger, abi.encodeCall(IIndicoLedger.signTerms, (TERMS)));
        c[i++] = Call(alice, abi.encodeCall(IIndicoLedger.registerAsset, (bytes32("d"), 0, 1e6)));
        c[i++] = Call(admin, abi.encodeCall(IIndicoLedger.adminIssueCredit, (alice, 1e6, "m")));
        c[i++] = Call(admin, abi.encodeCall(IIndicoLedger.adminDebitCredit, (alice, 1e6, "m")));
        c[i++] = Call(
            admin, abi.encodeCall(IIndicoLedger.adminMoveAccount, (bob, stranger, _accountRef(bob)))
        );
        c[i++] = Call(alice, abi.encodeCall(IIndicoLedger.spend, (merchantA, 1e6)));
        c[i++] = Call(merchantA, abi.encodeCall(IIndicoLedger.deposit, (1e6)));
        c[i++] = Call(merchantA, abi.encodeCall(IIndicoLedger.withdraw, (1e6)));
        c[i++] = Call(merchantA, abi.encodeCall(IIndicoLedger.withdrawAll, ()));
        c[i++] = Call(alice, abi.encodeCall(IIndicoLedger.requestLoan, (1e6)));
        c[i++] = Call(alice, abi.encodeCall(IIndicoLedger.repay, (1)));
        c[i++] = Call(alice, abi.encodeCall(IIndicoLedger.extend, (1)));
        c[i++] = Call(stranger, abi.encodeCall(IIndicoLedger.liquidate, (1)));
        c[i++] = Call(guardian, abi.encodeCall(IIndicoLedger.pause, ()));
        c[i++] = Call(guardian, abi.encodeCall(IIndicoLedger.unpause, ()));
        c[i++] = Call(admin, abi.encodeWithSignature("grantRole(bytes32,address)", adminRole, bob));
        c[i++] = Call(
            admin, abi.encodeWithSignature("revokeRole(bytes32,address)", guardianRole, guardian)
        );
        c[i++] = Call(
            guardian,
            abi.encodeWithSignature("renounceRole(bytes32,address)", guardianRole, guardian)
        );
        c[i++] = Call(admin, abi.encodeWithSignature("beginDefaultAdminTransfer(address)", bob));
        c[i++] = Call(admin, abi.encodeWithSignature("cancelDefaultAdminTransfer()"));
        c[i++] = Call(bob, abi.encodeWithSignature("acceptDefaultAdminTransfer()"));
        c[i++] =
            Call(admin, abi.encodeWithSignature("changeDefaultAdminDelay(uint48)", uint48(1 days)));
        c[i++] = Call(admin, abi.encodeWithSignature("rollbackDefaultAdminDelay()"));
        assertEq(i, c.length, "list size");
    }

    // ================================================================== coverage of the ABI

    function test_everyAbiFunctionIsListed() public view {
        string memory json = vm.readFile("out/IndicoLedger.sol/IndicoLedger.json");
        string[] memory sigs = vm.parseJsonKeys(json, ".methodIdentifiers");
        Call[] memory c = _calls();
        assertEq(sigs.length, c.length, "ABI has a function this list does not, or the reverse");
        for (uint256 s; s < sigs.length; ++s) {
            bytes4 sel = bytes4(keccak256(bytes(sigs[s])));
            uint256 hits;
            for (uint256 k; k < c.length; ++k) {
                if (bytes4(c[k].data) == sel) ++hits;
            }
            assertEq(hits, 1, sigs[s]);
        }
    }

    // ================================================================== malformed calldata

    function test_unknownSelectors_revertEmpty_nothingChanged() public {
        bytes[6] memory data = [
            abi.encodePacked(bytes4(0)),
            abi.encodePacked(bytes4(0xffffffff)),
            abi.encodePacked(bytes4(0xdeadbeef), uint256(1)),
            abi.encodeWithSignature("transfer(address,uint256)", stranger, 1), // an ERC-20 selector
            abi.encodeWithSignature("rescueTokens(address)", address(usdc)), // no rescue (CS 10)
            hex"aabbcc" // shorter than a selector
        ];
        for (uint256 k; k < data.length; ++k) {
            _revertsUnchanged(admin, data[k], "");
        }
    }

    function test_rawEth_reverts_nothingChanged() public {
        vm.deal(stranger, 1 ether);
        _startDiff();
        vm.prank(stranger);
        (bool ok, bytes memory ret) = address(ledger).call{value: 1 ether}("");
        assertFalse(ok, "accepted ETH");
        assertEq(ret, "");
        _assertNoChange();
        assertEq(address(ledger).balance, 0);
    }

    function test_everyFunction_oneByteShort_revertsEmpty() public {
        Call[] memory c = _calls();
        for (uint256 k; k < c.length; ++k) {
            bytes memory d = c[k].data;
            bytes memory short = new bytes(d.length - 1);
            for (uint256 b; b < short.length; ++b) {
                short[b] = d[b];
            }
            _revertsUnchanged(c[k].who, short, "");
        }
    }

    /// @dev 80 bytes of garbage then the admin's address: an ERC-2771-style suffix must never
    ///      make a call act as the admin.
    function test_everyFunction_100BytesAppended_behavesIdentically() public {
        bytes memory tail = abi.encodePacked(bytes32(type(uint256).max), bytes32(uint256(0xab)));
        tail = abi.encodePacked(tail, bytes16(0), admin);
        assertEq(tail.length, 100);
        Call[] memory c = _calls();
        for (uint256 k; k < c.length; ++k) {
            (bool ok1, bytes memory r1, Write[] memory w1) = _run(c[k].who, c[k].data);
            (bool ok2, bytes memory r2, Write[] memory w2) =
                _run(c[k].who, abi.encodePacked(c[k].data, tail));
            assertEq(ok1, ok2, "success differs");
            assertEq(r1, r2, "return data differs");
            assertEq(w1.length, w2.length, "write count differs");
            for (uint256 j; j < w1.length; ++j) {
                assertEq(w1[j].account, w2[j].account, "write account");
                assertEq(w1[j].slot, w2[j].slot, "write slot");
                assertEq(w1[j].value, w2[j].value, "write value");
            }
        }
    }

    function test_everyFunction_withEth_reverts() public {
        Call[] memory c = _calls();
        for (uint256 k; k < c.length; ++k) {
            vm.deal(c[k].who, 1);
            _startDiff();
            vm.prank(c[k].who);
            (bool ok, bytes memory ret) = address(ledger).call{value: 1}(c[k].data);
            assertFalse(ok, "a function is payable");
            assertEq(ret, "");
            _assertNoChange();
        }
    }

    /// @dev Runs one call, returns its outcome and net writes, then puts the state back.
    function _run(address who, bytes memory data)
        internal
        returns (bool ok, bytes memory ret, Write[] memory w)
    {
        uint256 id = vm.snapshotState();
        _startDiff();
        vm.prank(who);
        (ok, ret) = address(ledger).call(data);
        (w,) = _stopDiff();
        vm.revertToState(id);
    }

    // ================================================================== stray ERC-20

    function test_strayErc20_writesNoLedgerSlot_andNoFunctionMovesIt() public {
        MockUSDC stray = new MockUSDC();
        stray.mint(stranger, 5e6);
        _startDiff();
        vm.prank(stranger);
        stray.transfer(address(ledger), 5e6);
        (Write[] memory w,) = _stopDiff();
        for (uint256 j; j < w.length; ++j) {
            assertEq(w[j].account, address(stray), "a ledger or USDC slot was written");
        }
        Call[] memory c = _calls();
        for (uint256 k; k < c.length; ++k) {
            vm.prank(c[k].who);
            (bool ok,) = address(ledger).call(c[k].data);
            ok; // outcome irrelevant here; only the stray balance matters
        }
        assertEq(stray.balanceOf(address(ledger)), 5e6, "a ledger function moved the stray token");
    }

    // ================================================================== re-entry cross product

    /// @dev The token calls back into the ledger, as itself, from inside each USDC transfer.
    ///      Every cell either hits the guard or is refused as the token address would be, and the
    ///      outer call rolls back whole. Three cells prove effects come before the transfer:
    ///      inside `repay`, loan 1 is already Repaid (`extend` and `liquidate` say LoanNotActive);
    ///      inside `requestLoan`, loan 2 already exists (`liquidate` says NotYetDue).
    function test_reentry_everyUsdcFunction_intoEveryTarget() public {
        Call[5] memory outer = [
            Call(merchantA, abi.encodeCall(IIndicoLedger.deposit, (1e6))),
            Call(merchantA, abi.encodeCall(IIndicoLedger.withdraw, (1e6))),
            Call(merchantA, abi.encodeCall(IIndicoLedger.withdrawAll, ())),
            Call(alice, abi.encodeCall(IIndicoLedger.requestLoan, (1e6))),
            Call(alice, abi.encodeCall(IIndicoLedger.repay, (1)))
        ];
        for (uint256 o; o < outer.length; ++o) {
            (bytes[] memory target, bytes[] memory err) = _targets(o);
            for (uint256 t; t < target.length; ++t) {
                uint256 id = vm.snapshotState();
                usdc.setReentrantTarget(address(ledger), target[t]);
                if (err[t].length == 0) {
                    // signTerms: allowed for any address, so the token simply signs.
                    vm.prank(outer[o].who);
                    (bool ok,) = address(ledger).call(outer[o].data);
                    assertTrue(ok, "outer call failed");
                    assertTrue(ledger.termsSigned(address(usdc)), "re-entered signTerms lost");
                } else {
                    _revertsUnchanged(outer[o].who, outer[o].data, err[t]);
                }
                vm.revertToState(id);
            }
        }
    }

    function _targets(uint256 o) internal view returns (bytes[] memory t, bytes[] memory e) {
        address tok = address(usdc);
        bytes memory guard =
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        bytes memory notAdmin = _unauthorized(tok, keccak256("ADMIN_ROLE"));
        bytes memory notGuardian = _unauthorized(tok, keccak256("GUARDIAN_ROLE"));
        bytes memory notActive = abi.encodeWithSelector(IIndicoLedger.LoanNotActive.selector);
        t = new bytes[](19);
        e = new bytes[](19);
        uint256 i;
        (t[i], e[i++]) = (abi.encodeCall(IIndicoLedger.deposit, (1)), guard);
        (t[i], e[i++]) = (abi.encodeCall(IIndicoLedger.withdraw, (1)), guard);
        (t[i], e[i++]) = (abi.encodeCall(IIndicoLedger.withdrawAll, ()), guard);
        (t[i], e[i++]) = (abi.encodeCall(IIndicoLedger.requestLoan, (1)), guard);
        (t[i], e[i++]) = (abi.encodeCall(IIndicoLedger.repay, (1)), guard);
        (t[i], e[i++]) = (abi.encodeCall(IIndicoLedger.setTermsHash, (keccak256("t2"))), notAdmin);
        (t[i], e[i++]) =
        (abi.encodeCall(IIndicoLedger.setUserApproved, (tok, true, bytes32("r"))), notAdmin);
        (t[i], e[i++]) = (abi.encodeCall(IIndicoLedger.setMerchantApproved, (tok, true)), notAdmin);
        (t[i], e[i++]) = (abi.encodeCall(IIndicoLedger.adminIssueCredit, (alice, 1, "m")), notAdmin);
        (t[i], e[i++]) = (abi.encodeCall(IIndicoLedger.adminDebitCredit, (alice, 1, "m")), notAdmin);
        (t[i], e[i++]) =
        (abi.encodeCall(IIndicoLedger.adminMoveAccount, (alice, tok, _accountRef(alice))), notAdmin);
        (t[i], e[i++]) =
        (
            abi.encodeWithSignature("grantRole(bytes32,address)", keccak256("ADMIN_ROLE"), tok),
            _unauthorized(tok, bytes32(0))
        );
        (t[i], e[i++]) = (abi.encodeCall(IIndicoLedger.pause, ()), notGuardian);
        (t[i], e[i++]) = (abi.encodeCall(IIndicoLedger.unpause, ()), notGuardian);
        (t[i], e[i++]) =
        (
            abi.encodeCall(IIndicoLedger.registerAsset, (bytes32("d"), 0, 1)),
            abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
        );
        (t[i], e[i++]) =
        (
            abi.encodeCall(IIndicoLedger.spend, (merchantA, 1)),
            abi.encodeWithSelector(IIndicoLedger.NotApprovedUser.selector)
        );
        bool repaying = o == 4;
        bool borrowing = o == 3;
        (t[i], e[i++]) =
        (
            abi.encodeCall(IIndicoLedger.extend, (1)),
            repaying ? notActive : abi.encodeWithSelector(IIndicoLedger.NotBorrower.selector)
        );
        uint256 loanId = borrowing ? 2 : 1;
        uint64 due = borrowing ? uint64(vm.getBlockTimestamp() + TERM) : due1;
        (t[i], e[i++]) =
        (
            abi.encodeCall(IIndicoLedger.liquidate, (loanId)),
            repaying ? notActive : abi.encodeWithSelector(IIndicoLedger.NotYetDue.selector, due)
        );
        (t[i], e[i++]) = (abi.encodeCall(IIndicoLedger.signTerms, (TERMS)), "");
        assertEq(i, t.length, "target count");
    }

    function _unauthorized(address who, bytes32 role) internal pure returns (bytes memory) {
        return
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, who, role
            );
    }
}
