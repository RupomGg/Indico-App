// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Vm} from "forge-std/Vm.sol";
import {Actors} from "../helpers/Actors.sol";
import {IIndicoLedger} from "../../src/interfaces/IIndicoLedger.sol";
import {ROLE_MERCHANT} from "../../src/lib/Constants.sol";
import {MerchantDepositBox} from "../../src/MerchantDepositBox.sol";

/// @notice Merchant onboarding with its signed agreement (D-69) and the merchant's deposit box
///         and `sweep` (D-70).
///
/// setMerchantApproved(m, approved, agreementHash)
/// | Class                                      | Expected                                     | Net writes                         |
/// |--------------------------------------------|----------------------------------------------|------------------------------------|
/// | fresh merchant, non-zero hash              | approved, agreement recorded, box assigned   | flag, role, agreement, box         |
/// | fresh merchant, zero hash                  | ZeroAgreementHash                            | none                               |
/// | approved again, same hash (D-20)           | emits again                                  | none                               |
/// | re-approved, new hash                      | agreement replaced, same box                 | flag, agreement                    |
/// | revoke, zero hash                          | revoked; agreement and box kept              | flag                               |
/// | revoke, non-zero hash                      | AgreementHashOnRevoke                        | none                               |
/// | zero address, either direction, any hash   | ZeroAddress first                            | none                               |
/// | ledger, USDC, a user's wallet, zero hash   | InvalidParticipant / ParticipantRoleConflict first | none                         |
/// Never writes termsSigned or signedTermsHash and never emits TermsSigned: the agreement is a
/// record, not a wallet signature.
///
/// sweep(merchant), any caller
/// | Class                                      | Expected                                     |
/// |--------------------------------------------|----------------------------------------------|
/// | box holds USDC                             | the whole box becomes the box merchant's shares |
/// | called by anyone, another merchant included| shares still go to the box's merchant        |
/// | two boxes funded                           | only the named box moves                     |
/// | empty box (deployed or not)                | ZeroShares (nothing delivered), nothing changed |
/// | zero address, a user, a stranger           | NotApprovedMerchant (no box)                 |
/// | revoked merchant                           | NotApprovedMerchant; the money waits; re-approval sweeps it |
/// | paused                                     | EnforcedPause; works after unpause           |
/// | 1% fee-on-transfer                         | shares on what arrived                       |
/// | 100% fee, nothing arrives                  | ZeroShares                                   |
/// | USDC sent to the ledger, not the box       | counted nowhere (D-38); sweep does not take it |
/// Order: EnforcedPause, NotApprovedMerchant, (first sweep: deploy), (release), ZeroShares.
contract MerchantOnboardingTest is Actors {
    bytes32 internal constant AG2 = keccak256("signed-agreement-v2");
    address internal fresh;

    function setUp() public override {
        super.setUp();
        fresh = makeAddr("freshMerchant");
        _addActor(fresh);
    }

    function _approve(address m, bool v, bytes32 h) internal {
        vm.prank(admin);
        ledger.setMerchantApproved(m, v, h);
    }

    function _call(address m, bool v, bytes32 h) internal pure returns (bytes memory) {
        return abi.encodeCall(IIndicoLedger.setMerchantApproved, (m, v, h));
    }

    function _box(address m) internal view returns (address) {
        return ledger.depositBoxOf(m);
    }

    function _sweep(address by, address m) internal {
        vm.prank(by);
        ledger.sweep(m);
    }

    // ================================================================== D-69 agreement

    function test_approveFresh_recordsAgreement_createsBox_exactWritesAndEvents() public {
        vm.recordLogs();
        _startDiff();
        _approve(fresh, true, AGREEMENT);
        address box = _box(fresh);
        Write[] memory w = new Write[](4);
        w[0] = _w(address(ledger), _key(fresh, SLOT_APPROVED_MERCHANT), 1);
        w[1] = _w(address(ledger), _key(fresh, SLOT_PARTICIPANT_ROLE), ROLE_MERCHANT);
        w[2] = _w(address(ledger), _key(fresh, SLOT_MERCHANT_AGREEMENT), uint256(AGREEMENT));
        w[3] = _w(address(ledger), _key(fresh, SLOT_DEPOSIT_BOX_OF), uint256(uint160(box)));
        _assertWrites(w); // no contract created: the first sweep deploys the box
        assertEq(box.code.length, 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(ledger)) continue;
            bytes32 t = logs[i].topics[0];
            if (n == 0) assertEq(t, IIndicoLedger.MerchantAgreementRecorded.selector);
            if (n == 1) assertEq(t, IIndicoLedger.DepositBoxAssigned.selector);
            if (n == 2) assertEq(t, IIndicoLedger.MerchantApprovalSet.selector);
            ++n;
        }
        assertEq(n, 3, "exactly three ledger events");
        assertTrue(box != address(0));
        assertEq(ledger.merchantAgreement(fresh), AGREEMENT);
        assertFalse(ledger.termsSigned(fresh), "an agreement is not a wallet signature");
        assertEq(ledger.signedTermsHash(fresh), bytes32(0));
    }

    function test_approveFresh_eventArguments() public {
        // CREATE2 from the ledger, salt = the merchant (D-70).
        address box = vm.computeCreate2Address(
            bytes32(uint256(uint160(fresh))),
            keccak256(bytes.concat(type(MerchantDepositBox).creationCode, abi.encode(usdc))),
            address(ledger)
        );
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.MerchantAgreementRecorded(fresh, TERMS, AGREEMENT);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.DepositBoxAssigned(fresh, box);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.MerchantApprovalSet(fresh, true);
        _approve(fresh, true, AGREEMENT);
        assertEq(_box(fresh), box);
    }

    function test_approve_zeroAgreement_reverts() public {
        _revertsUnchanged(
            admin,
            _call(fresh, true, bytes32(0)),
            abi.encodeWithSelector(IIndicoLedger.ZeroAgreementHash.selector)
        );
    }

    function test_revoke_nonZeroAgreement_reverts() public {
        _revertsUnchanged(
            admin,
            _call(merchantA, false, AGREEMENT),
            abi.encodeWithSelector(IIndicoLedger.AgreementHashOnRevoke.selector)
        );
    }

    function test_revoke_writesFlagOnly_keepsAgreementAndBox() public {
        address box = _box(merchantA);
        _startDiff();
        _approve(merchantA, false, bytes32(0));
        Write[] memory w = new Write[](1);
        w[0] = _w(address(ledger), _key(merchantA, SLOT_APPROVED_MERCHANT), 0);
        _assertWrites(w);
        assertEq(ledger.merchantAgreement(merchantA), AGREEMENT);
        assertEq(_box(merchantA), box);
    }

    function test_reapprove_newAgreement_replaces_sameBox() public {
        address box = _box(merchantA);
        _approve(merchantA, false, bytes32(0));
        vm.recordLogs();
        _startDiff();
        _approve(merchantA, true, AG2);
        Write[] memory w = new Write[](2);
        w[0] = _w(address(ledger), _key(merchantA, SLOT_APPROVED_MERCHANT), 1);
        w[1] = _w(address(ledger), _key(merchantA, SLOT_MERCHANT_AGREEMENT), uint256(AG2));
        _assertWrites(w);
        assertEq(vm.getRecordedLogs().length, 2, "no box event on a re-approval");
        assertEq(_box(merchantA), box);
    }

    function test_approveAgain_sameHash_noWrite_emitsAgain() public {
        _startDiff();
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.MerchantAgreementRecorded(merchantA, TERMS, AGREEMENT);
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.MerchantApprovalSet(merchantA, true);
        _approve(merchantA, true, AGREEMENT);
        _assertWrites(new Write[](0));
    }

    function test_agreementOnlyMerchant_canBePaidAndDeposit() public {
        _approve(fresh, true, AGREEMENT);
        _mintCredit(alice, 10e6);
        vm.prank(alice);
        ledger.spend(fresh, 10e6);
        assertEq(ledger.credit(fresh), 10e6);
        _deposit(fresh, 5e6);
        assertEq(ledger.shares(fresh), 5e6 * 1e6);
        assertFalse(ledger.termsSigned(fresh));
    }

    function test_order_zeroAddressFirst() public {
        bytes memory zero = abi.encodeWithSelector(IIndicoLedger.ZeroAddress.selector);
        _revertsUnchanged(admin, _call(address(0), true, bytes32(0)), zero);
        _revertsUnchanged(admin, _call(address(0), false, AGREEMENT), zero);
    }

    function test_order_participantChecksBeforeAgreement() public {
        _revertsUnchanged(
            admin,
            _call(address(ledger), true, bytes32(0)),
            abi.encodeWithSelector(IIndicoLedger.InvalidParticipant.selector, address(ledger))
        );
        _revertsUnchanged(
            admin,
            _call(address(usdc), true, bytes32(0)),
            abi.encodeWithSelector(IIndicoLedger.InvalidParticipant.selector, address(usdc))
        );
        _revertsUnchanged(
            admin,
            _call(alice, true, bytes32(0)),
            abi.encodeWithSelector(IIndicoLedger.ParticipantRoleConflict.selector, alice)
        );
    }

    function test_nonAdmin_reverts() public {
        address[4] memory who = [alice, merchantA, guardian, makeAddr("stranger")];
        for (uint256 i; i < who.length; ++i) {
            _revertsUnchanged(
                who[i],
                _call(fresh, true, AGREEMENT),
                abi.encodeWithSignature(
                    "AccessControlUnauthorizedAccount(address,bytes32)", who[i], ledger.ADMIN_ROLE()
                )
            );
        }
    }

    function testFuzz_approveFresh_anyHash(address m, bytes32 h) public {
        m = _remapForgeAddress(m);
        if (m == address(0) || m == address(ledger) || m == address(usdc)) m = makeAddr("remap");
        if (ledger.participantRole(m) != 0) m = makeAddr("remap-fresh");
        if (h == bytes32(0)) h = AGREEMENT;
        _approve(m, true, h);
        assertEq(ledger.merchantAgreement(m), h);
        assertTrue(_box(m) != address(0));
        assertFalse(ledger.termsSigned(m));
    }

    // ================================================================== D-70 deposit box

    /// @dev The first sweep deploys the box at its assigned address; afterwards only the ledger
    ///      can release it, and the box takes no ETH.
    function test_box_deployedOnFirstSweep_onlyLedgerReleases_takesNoEth() public {
        address box = _box(merchantA);
        assertEq(box.code.length, 0, "not deployed before the first sweep");
        usdc.mint(box, 1e6);
        _sweep(alice, merchantA);
        assertGt(box.code.length, 0, "deployed by the first sweep");
        usdc.mint(box, 9e6);
        address[3] memory who = [alice, merchantA, admin];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(MerchantDepositBox.NotLedger.selector);
            MerchantDepositBox(box).release();
        }
        assertEq(usdc.balanceOf(box), 9e6);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = box.call{value: 1}("");
        assertFalse(ok, "the box takes ETH");
        _sweep(alice, merchantA); // a second sweep reuses the deployed box
        assertEq(ledger.shares(merchantA), 10e6 * 1e6);
    }

    function test_sweep_anyCaller_creditsBoxMerchant_exactWrites() public {
        address box = _box(merchantA);
        // The first sweep deploys the box (an account creation the diff cannot list); measure the next one.
        usdc.mint(box, 1e6);
        _sweep(merchantA, merchantA);
        usdc.mint(box, 500e6);
        uint256 minted = _modelSharesFor(500e6);
        uint256 sharesBefore = ledger.shares(merchantA);
        uint256 ledgerUsdc = usdc.balanceOf(address(ledger));
        address stranger = makeAddr("stranger");
        _startDiff();
        vm.expectEmit(true, true, true, true, address(ledger));
        emit IIndicoLedger.Deposited(merchantA, 500e6, minted);
        _sweep(stranger, merchantA);
        Write[] memory w = new Write[](5);
        w[0] = _w(address(ledger), _key(merchantA, SLOT_SHARES), ledger.shares(merchantA));
        w[1] = _w(address(ledger), bytes32(SLOT_TOTAL_SHARES), ledger.totalShares());
        w[2] = _w(address(ledger), bytes32(SLOT_POOL_USDC), ledger.poolUsdc());
        w[3] = _w(address(usdc), _key(box, SLOT_USDC_BALANCES), 0);
        w[4] = _w(address(usdc), _key(address(ledger), SLOT_USDC_BALANCES), ledgerUsdc + 500e6);
        _assertWrites(w);
        assertEq(ledger.shares(merchantA), sharesBefore + minted);
        assertEq(ledger.shares(stranger), 0);
    }

    function test_sweep_byOtherMerchant_stillCreditsBoxMerchant() public {
        usdc.mint(_box(merchantA), 100e6);
        usdc.mint(_box(merchantB), 300e6);
        _sweep(merchantB, merchantA);
        assertEq(ledger.shares(merchantA), 100e6 * 1e6);
        assertEq(ledger.shares(merchantB), 0);
        assertEq(usdc.balanceOf(_box(merchantB)), 300e6, "the other box is untouched");
        assertEq(ledger.poolUsdc(), 100e6);
    }

    /// @dev An empty, deployed box delivers nothing, which is worth no share.
    function test_sweep_emptyBox_revertsZeroShares() public {
        usdc.mint(_box(merchantA), 1e6);
        _sweep(alice, merchantA); // deploys the box
        _revertsUnchanged(
            alice,
            abi.encodeCall(IIndicoLedger.sweep, (merchantA)),
            abi.encodeWithSelector(IIndicoLedger.ZeroShares.selector)
        );
    }

    /// @dev An empty box never swept: the sweep would deploy it, then revert, so nothing changes.
    function test_sweep_emptyUndeployedBox_revertsZeroShares_noDeployment() public {
        _revertsUnchanged(
            alice,
            abi.encodeCall(IIndicoLedger.sweep, (merchantA)),
            abi.encodeWithSelector(IIndicoLedger.ZeroShares.selector)
        );
        assertEq(_box(merchantA).code.length, 0);
    }

    function test_sweep_noBox_revertsNotApprovedMerchant() public {
        address[4] memory who = [address(0), alice, fresh, address(ledger)];
        for (uint256 i; i < who.length; ++i) {
            _revertsUnchanged(
                alice,
                abi.encodeCall(IIndicoLedger.sweep, (who[i])),
                abi.encodeWithSelector(IIndicoLedger.NotApprovedMerchant.selector)
            );
        }
    }

    function test_sweep_revokedMerchant_waits_thenReapprovedSweeps() public {
        usdc.mint(_box(merchantA), 200e6);
        _revokeMerchant(merchantA);
        _revertsUnchanged(
            alice,
            abi.encodeCall(IIndicoLedger.sweep, (merchantA)),
            abi.encodeWithSelector(IIndicoLedger.NotApprovedMerchant.selector)
        );
        assertEq(usdc.balanceOf(_box(merchantA)), 200e6, "the money waits in the box");
        _approve(merchantA, true, AGREEMENT);
        _sweep(alice, merchantA);
        assertEq(ledger.shares(merchantA), 200e6 * 1e6);
    }

    function test_sweep_paused_reverts_thenWorks() public {
        usdc.mint(_box(merchantA), 50e6);
        _pause();
        _revertsUnchanged(
            alice,
            abi.encodeCall(IIndicoLedger.sweep, (merchantA)),
            abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
        vm.prank(guardian);
        ledger.unpause();
        _sweep(alice, merchantA);
        assertEq(ledger.poolUsdc(), 50e6);
    }

    function test_sweep_order_pauseBeforeMerchantBeforeAmount() public {
        _pause();
        _revertsUnchanged(
            alice,
            abi.encodeCall(IIndicoLedger.sweep, (address(0))),
            abi.encodeWithSelector(Pausable.EnforcedPause.selector)
        );
    }

    function test_sweep_feeOnTransfer_creditsWhatArrived() public {
        usdc.mint(_box(merchantA), 1_000e6);
        usdc.setFeeBps(100);
        _sweep(alice, merchantA);
        assertEq(ledger.poolUsdc(), 990e6);
        assertEq(ledger.shares(merchantA), 990e6 * 1e6);
        assertEq(usdc.balanceOf(_box(merchantA)), 0);
    }

    function test_sweep_fullFee_revertsZeroShares() public {
        usdc.mint(_box(merchantA), 1_000e6);
        usdc.setFeeBps(10_000);
        _revertsUnchanged(
            alice,
            abi.encodeCall(IIndicoLedger.sweep, (merchantA)),
            abi.encodeWithSelector(IIndicoLedger.ZeroShares.selector)
        );
    }

    function test_directTransferToLedger_isNotSwept() public {
        usdc.mint(address(ledger), 700e6); // sent to the ledger, not the box: counted nowhere
        _revertsUnchanged(
            alice,
            abi.encodeCall(IIndicoLedger.sweep, (merchantA)),
            abi.encodeWithSelector(IIndicoLedger.ZeroShares.selector)
        );
        assertEq(ledger.poolUsdc(), 0);
    }

    function test_sweep_thenWithdrawAll_returnsTheMoney() public {
        uint256 before = usdc.balanceOf(merchantA);
        address box = _box(merchantA);
        vm.prank(merchantA);
        usdc.transfer(box, 400e6); // the merchant's ordinary wallet "send"
        _sweep(makeAddr("keeper"), merchantA);
        vm.prank(merchantA);
        ledger.withdrawAll();
        assertEq(usdc.balanceOf(merchantA), before);
        assertEq(ledger.poolUsdc(), 0);
    }

    function testFuzz_sweep_anyAmountAnyCaller(uint256 amount, address by) public {
        amount = bound(amount, 1, 1e30);
        by = _remapForgeAddress(by);
        if (by == _box(merchantA)) by = makeAddr("remapped-box"); // a call from the box's address would occupy it
        usdc.mint(_box(merchantA), amount);
        uint256 minted = _modelSharesFor(amount);
        _sweep(by, merchantA);
        assertEq(ledger.shares(merchantA), minted);
        assertEq(ledger.poolUsdc(), amount);
        assertEq(usdc.balanceOf(_box(merchantA)), 0);
        assertGe(usdc.balanceOf(address(ledger)), ledger.poolUsdc());
    }
}
