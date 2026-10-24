// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IIndicoLedger} from "../src/interfaces/IIndicoLedger.sol";
import {IndicoLedger} from "../src/IndicoLedger.sol";
import {LIQUIDATION_GRACE} from "../src/lib/Constants.sol";

/// @notice Liquidation keeper script (P3.2). Finds overdue loans and calls liquidate.
///         Idempotent and safe to run concurrently.
///
///         Run via forge script:
///         forge script script/LiquidateKeeper.s.sol --rpc-url $RPC_URL --account deployer --broadcast
///
///         Environment variables (optional):
///           LEDGER_ADDRESS – overrides default contract address for the chain.
contract LiquidateKeeper is Script {
    uint256 internal constant BASE_SEPOLIA = 84532;
    address internal constant SEPOLIA_LEDGER = 0x78686caeAD6b25335895a4d920Dc1597140365Cd;

    error UnknownLedgerForChain(uint256 chainId);

    function run() external returns (uint256 liquidatedCount) {
        address ledgerAddr = _getLedgerAddress();
        IndicoLedger ledger = IndicoLedger(ledgerAddr);

        console.log("Running LiquidationKeeper on chain:", block.chainid);
        console.log("Target IndicoLedger address:      ", ledgerAddr);

        uint256[] memory overdue = findOverdueLoans(ledger);
        console.log("Found overdue loans:              ", overdue.length);

        if (overdue.length == 0) {
            console.log("No overdue loans to liquidate. Exiting cleanly.");
            return 0;
        }

        vm.startBroadcast();
        liquidatedCount = liquidateBatch(ledger, overdue);
        vm.stopBroadcast();

        console.log("Successfully liquidated loans:    ", liquidatedCount);
    }

    /// @notice Check if a loan is currently eligible for liquidation.
    function isLiquidatable(IndicoLedger ledger, uint256 loanId) public view returns (bool) {
        if (ledger.paused()) return false;
        if (loanId == 0 || loanId > ledger.nextLoanId()) return false;

        (address borrower, uint64 dueDate,, uint8 status,,) = ledger.loans(loanId);
        if (borrower == address(0)) return false;
        if (status != uint8(IIndicoLedger.LoanStatus.Active)) return false;

        if (block.timestamp <= dueDate) return false;

        uint256 graceEndsAt = uint256(ledger.lastUnpausedAt()) + LIQUIDATION_GRACE;
        if (block.timestamp <= graceEndsAt) return false;

        return true;
    }

    /// @notice Find all active overdue loans in the ledger.
    function findOverdueLoans(IndicoLedger ledger) public view returns (uint256[] memory) {
        return findOverdueLoans(ledger, 1, ledger.nextLoanId());
    }

    /// @notice Find active overdue loans in range [fromId, toId].
    function findOverdueLoans(IndicoLedger ledger, uint256 fromId, uint256 toId)
        public
        view
        returns (uint256[] memory)
    {
        uint256 total = ledger.nextLoanId();
        if (fromId == 0) fromId = 1;
        if (toId > total) toId = total;
        if (fromId > toId || total == 0) return new uint256[](0);

        uint256 count = 0;
        for (uint256 id = fromId; id <= toId; id++) {
            if (isLiquidatable(ledger, id)) {
                count++;
            }
        }

        uint256[] memory overdue = new uint256[](count);
        uint256 idx = 0;
        for (uint256 id = fromId; id <= toId; id++) {
            if (isLiquidatable(ledger, id)) {
                overdue[idx++] = id;
            }
        }

        return overdue;
    }

    /// @notice Attempt to liquidate a single loan idempotently and safely.
    ///         Returns true if liquidated, false if skipped or already liquidated.
    function liquidateSafe(IndicoLedger ledger, uint256 loanId) public returns (bool) {
        if (!isLiquidatable(ledger, loanId)) return false;

        try ledger.liquidate(loanId) {
            return true;
        } catch {
            // Handled race condition: borrower repaid or another keeper liquidated concurrently
            return false;
        }
    }

    /// @notice Liquidate a specific batch of loan IDs safely.
    function liquidateBatch(IndicoLedger ledger, uint256[] memory loanIds)
        public
        returns (uint256 liquidatedCount)
    {
        for (uint256 i = 0; i < loanIds.length; i++) {
            if (liquidateSafe(ledger, loanIds[i])) {
                liquidatedCount++;
            }
        }
    }

    /// @notice Find and liquidate all currently overdue loans.
    function liquidateAll(IndicoLedger ledger) public returns (uint256 liquidatedCount) {
        uint256[] memory overdue = findOverdueLoans(ledger);
        return liquidateBatch(ledger, overdue);
    }

    function _getLedgerAddress() internal view returns (address) {
        try vm.envAddress("LEDGER_ADDRESS") returns (address addr) {
            if (addr != address(0)) return addr;
        } catch {}

        if (block.chainid == BASE_SEPOLIA) return SEPOLIA_LEDGER;
        revert UnknownLedgerForChain(block.chainid);
    }
}
