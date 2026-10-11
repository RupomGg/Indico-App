# Gas per function, interface 1.0.0

From `forge test --gas-report` (Forge 1.8.3, optimizer 200, via_ir). Execution gas only,
without the 21,000 base cost and calldata. Typical is the median over every call the tests
made, refused ones included, so it can sit below a successful call. Worst seen is the most
expensive call, usually a first-time storage write; it is not an upper bound. Always estimate
the real transaction with `eth_estimateGas` before the user signs (PRD U-11); use these tables
for planning and for the insufficient-ETH message only.

## On Circle's USDC (Base mainnet fork)

From the fork tests, against the real token at a pinned block. USDC is a proxy, so a call
that moves USDC costs more than with the test token below. Few calls each: a guide, not a
distribution.

| Function | Typical (median) | Worst seen (max) | Calls in tests |
|---|---|---|---|
| `adminDebitCredit(address,uint256,bytes32)` | 43,738 | 43,738 | 1 |
| `adminIssueCredit(address,uint256,bytes32)` | 76,702 | 76,702 | 1 |
| `adminMoveAccount(address,address,bytes32)` | 144,307 | 144,307 | 1 |
| `credit(address)` | 3,726 | 3,726 | 5 |
| `deposit(uint256)` | 157,960 | 157,960 | 7 |
| `extend(uint256)` | 33,964 | 33,964 | 1 |
| `liquidate(uint256)` | 78,465 | 78,465 | 1 |
| `loans(uint256)` | 6,062 | 6,062 | 3 |
| `lockedCredit(address)` | 2,956 | 2,956 | 4 |
| `maxWithdraw(address)` | 10,526 | 10,526 | 1 |
| `nextLoanId()` | 2,982 | 2,982 | 1 |
| `poolCredit()` | 3,422 | 3,422 | 1 |
| `poolUsdc()` | 2,300 | 2,300 | 7 |
| `registerAsset(bytes32,uint8,uint256)` | 100,501 | 100,501 | 3 |
| `repay(uint256)` | 90,867 | 90,867 | 3 |
| `requestLoan(uint256)` | 184,347 | 184,347 | 4 |
| `setMerchantApproved(address,bool)` | 71,161 | 71,161 | 8 |
| `setTermsHash(bytes32)` | 48,000 | 48,000 | 8 |
| `setUserApproved(address,bool,bytes32)` | 116,417 | 116,417 | 8 |
| `shares(address)` | 3,616 | 3,616 | 2 |
| `signTerms(bytes32)` | 72,636 | 72,636 | 16 |
| `spend(address,uint256)` | 67,426 | 67,426 | 1 |
| `totalLent()` | 2,828 | 2,828 | 2 |
| `totalShares()` | 2,564 | 2,564 | 3 |
| `usdc()` | 504 | 504 | 1 |
| `withdraw(uint256)` | 66,067 | 66,067 | 1 |
| `withdrawAll()` | 70,937 | 75,585 | 2 |

## Whole test suite, test token

Every unit, invariant, differential and integration test, on the 6-decimal test token.

| Function | Typical (median) | Worst seen (max) | Calls in tests |
|---|---|---|---|
| `ADMIN_ROLE()` | 769 | 21,833 | 114 |
| `DEFAULT_ADMIN_ROLE()` | 22,206 | 22,206 | 3 |
| `GUARDIAN_ROLE()` | 329 | 21,393 | 340 |
| `acceptDefaultAdminTransfer()` | 24,614 | 65,380 | 26 |
| `accountRefOf(address)` | 3,792 | 25,224 | 103,866 |
| `adminDebitCredit(address,uint256,bytes32)` | 33,907 | 43,738 | 4,942 |
| `adminIssueCredit(address,uint256,bytes32)` | 59,326 | 76,702 | 10,451 |
| `adminMoveAccount(address,address,bytes32)` | 121,607 | 144,307 | 2,590 |
| `approvedMerchant(address)` | 3,892 | 25,324 | 90,828 |
| `approvedUser(address)` | 3,364 | 24,796 | 94,492 |
| `assetRegistered(bytes32)` | 3,455 | 24,659 | 270 |
| `assetsToShares(uint256)` | 8,332 | 29,560 | 1,592 |
| `available(address)` | 4,780 | 26,212 | 411 |
| `beginDefaultAdminTransfer(address)` | 24,362 | 33,314 | 29 |
| `cancelDefaultAdminTransfer()` | 24,778 | 30,571 | 14 |
| `changeDefaultAdminDelay(uint48)` | 24,111 | 33,198 | 15 |
| `collateralFor(uint256)` | 759 | 21,921 | 1,039 |
| `credit(address)` | 3,726 | 25,158 | 1,180,680 |
| `defaultAdmin()` | 2,962 | 24,026 | 12 |
| `defaultAdminDelay()` | 14,013 | 26,709 | 6 |
| `defaultAdminDelayIncreaseWait()` | 21,239 | 21,239 | 3 |
| `deposit(uint256)` | 98,473 | 159,962 | 9,069 |
| `extend(uint256)` | 33,964 | 36,256 | 2,810 |
| `getRoleAdmin(bytes32)` | 21,452 | 23,687 | 7 |
| `grantRole(bytes32,address)` | 26,911 | 51,425 | 27 |
| `hasRole(bytes32,address)` | 3,320 | 24,880 | 62 |
| `lastPausedAt()` | 3,022 | 24,086 | 6,949 |
| `lastUnpausedAt()` | 3,688 | 24,752 | 7,837 |
| `liquidate(uint256)` | 78,465 | 78,465 | 2,515 |
| `loans(uint256)` | 6,062 | 27,266 | 57,530 |
| `lockedCredit(address)` | 2,956 | 24,388 | 102,426 |
| `maxBorrow(address)` | 5,803 | 27,235 | 369 |
| `maxWithdraw(address)` | 10,510 | 31,958 | 1,507 |
| `nextLoanId()` | 2,982 | 24,046 | 16,231 |
| `owner()` | 23,049 | 24,136 | 4 |
| `participantRole(address)` | 3,270 | 24,702 | 100,145 |
| `pause()` | 71,184 | 71,184 | 1,685 |
| `paused()` | 2,730 | 23,794 | 27,974 |
| `pendingDefaultAdmin()` | 3,589 | 24,653 | 15 |
| `pendingDefaultAdminDelay()` | 22,138 | 24,403 | 5 |
| `poolAvailable()` | 2,322 | 23,386 | 348 |
| `poolCredit()` | 3,422 | 24,486 | 7,444 |
| `poolTotalAssets()` | 4,552 | 25,616 | 10 |
| `poolUsdc()` | 2,300 | 23,364 | 81,595 |
| `registerAsset(bytes32,uint8,uint256)` | 66,469 | 100,669 | 2,676 |
| `renounceRole(bytes32,address)` | 26,784 | 40,194 | 25 |
| `repay(uint256)` | 31,467 | 161,281 | 1,734 |
| `requestLoan(uint256)` | 181,089 | 211,732 | 5,051 |
| `revokeRole(bytes32,address)` | 27,967 | 35,386 | 15 |
| `rollbackDefaultAdminDelay()` | 23,524 | 29,465 | 14 |
| `setMerchantApproved(address,bool)` | 31,099 | 71,161 | 4,663 |
| `setTermsHash(bytes32)` | 30,900 | 48,000 | 4,852 |
| `setUserApproved(address,bool,bytes32)` | 34,363 | 116,417 | 9,267 |
| `shares(address)` | 3,616 | 25,048 | 99,732 |
| `sharesToAssets(uint256)` | 7,540 | 28,780 | 1,221 |
| `signTerms(bytes32)` | 72,636 | 72,636 | 6,469 |
| `signedTermsHash(address)` | 3,418 | 24,850 | 90,041 |
| `spend(address,uint256)` | 67,414 | 67,582 | 1,824 |
| `supportsInterface(bytes4)` | 21,567 | 21,567 | 3 |
| `termsHash()` | 3,356 | 24,420 | 10,129 |
| `termsSigned(address)` | 3,012 | 24,444 | 94,691 |
| `totalCredit()` | 3,290 | 24,354 | 8,987 |
| `totalLent()` | 2,828 | 23,892 | 65,478 |
| `totalShares()` | 2,564 | 23,628 | 64,903 |
| `transfer(address,uint256)` | 23,154 | 23,154 | 1 |
| `unpause()` | 36,353 | 36,353 | 1,246 |
| `usdc()` | 11,002 | 21,568 | 6 |
| `walletOfAccount(bytes32)` | 3,832 | 25,408 | 49,775 |
| `withdraw(uint256)` | 72,159 | 150,718 | 3,152 |
| `withdrawAll()` | 72,339 | 151,792 | 2,385 |
