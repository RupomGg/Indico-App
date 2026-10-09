# Gas per function, interface 1.0.0

From `forge test --gas-report` over the whole test suite (Forge 1.8.3, optimizer 200, via_ir).
Execution gas only, without the 21,000 base cost and calldata. Typical is the median over
every call the tests made, refused ones included, so it can sit below a successful call.
Worst seen is the most expensive call, usually a first-time storage write; it is not an
upper bound. Always estimate the real transaction with `eth_estimateGas` before the user signs
(PRD U-11); use this table for planning and for the insufficient-ETH message only.

| Function | Typical (median) | Worst seen (max) | Calls in tests |
|---|---|---|---|
| `ADMIN_ROLE()` | 769 | 21,833 | 111 |
| `DEFAULT_ADMIN_ROLE()` | 22,206 | 22,206 | 3 |
| `GUARDIAN_ROLE()` | 329 | 21,393 | 337 |
| `acceptDefaultAdminTransfer()` | 24,614 | 65,380 | 26 |
| `accountRefOf(address)` | 3,792 | 25,224 | 21,862 |
| `adminDebitCredit(address,uint256,bytes32)` | 33,907 | 43,618 | 4,248 |
| `adminIssueCredit(address,uint256,bytes32)` | 76,378 | 76,582 | 7,742 |
| `adminMoveAccount(address,address,bytes32)` | 144,307 | 144,307 | 333 |
| `approvedMerchant(address)` | 3,892 | 25,324 | 6,687 |
| `approvedUser(address)` | 3,364 | 24,796 | 8,108 |
| `assetRegistered(bytes32)` | 3,455 | 24,659 | 270 |
| `assetsToShares(uint256)` | 8,332 | 29,560 | 263 |
| `available(address)` | 4,780 | 26,212 | 10 |
| `beginDefaultAdminTransfer(address)` | 24,362 | 33,314 | 29 |
| `cancelDefaultAdminTransfer()` | 24,778 | 30,571 | 14 |
| `changeDefaultAdminDelay(uint48)` | 24,111 | 33,198 | 15 |
| `collateralFor(uint256)` | 759 | 21,921 | 1,039 |
| `credit(address)` | 3,726 | 25,158 | 15,472 |
| `defaultAdmin()` | 2,962 | 24,026 | 12 |
| `defaultAdminDelay()` | 14,013 | 26,709 | 6 |
| `defaultAdminDelayIncreaseWait()` | 21,239 | 21,239 | 3 |
| `deposit(uint256)` | 98,473 | 159,962 | 6,623 |
| `extend(uint256)` | 33,964 | 36,256 | 2,585 |
| `getRoleAdmin(bytes32)` | 21,452 | 23,687 | 7 |
| `grantRole(bytes32,address)` | 26,911 | 51,425 | 27 |
| `hasRole(bytes32,address)` | 3,320 | 24,880 | 62 |
| `lastPausedAt()` | 3,022 | 24,086 | 1,089 |
| `lastUnpausedAt()` | 3,688 | 24,752 | 1,087 |
| `liquidate(uint256)` | 78,465 | 78,465 | 2,183 |
| `loans(uint256)` | 6,062 | 27,266 | 2,733 |
| `lockedCredit(address)` | 2,956 | 24,388 | 12,360 |
| `maxBorrow(address)` | 5,803 | 27,235 | 268 |
| `maxWithdraw(address)` | 10,510 | 31,958 | 526 |
| `nextLoanId()` | 2,982 | 24,046 | 1,133 |
| `owner()` | 23,049 | 24,136 | 4 |
| `participantRole(address)` | 3,270 | 24,702 | 7,688 |
| `pause()` | 71,184 | 71,184 | 802 |
| `paused()` | 2,730 | 23,794 | 1,084 |
| `pendingDefaultAdmin()` | 3,589 | 24,653 | 15 |
| `pendingDefaultAdminDelay()` | 22,138 | 24,403 | 5 |
| `poolAvailable()` | 2,322 | 23,386 | 267 |
| `poolCredit()` | 3,422 | 24,486 | 1,610 |
| `poolTotalAssets()` | 4,552 | 25,616 | 10 |
| `poolUsdc()` | 2,300 | 23,364 | 11,499 |
| `registerAsset(bytes32,uint8,uint256)` | 56,799 | 100,669 | 1,098 |
| `renounceRole(bytes32,address)` | 26,784 | 40,194 | 25 |
| `repay(uint256)` | 82,680 | 161,281 | 1,234 |
| `requestLoan(uint256)` | 181,101 | 211,732 | 4,076 |
| `revokeRole(bytes32,address)` | 27,967 | 35,386 | 15 |
| `rollbackDefaultAdminDelay()` | 23,524 | 29,465 | 14 |
| `setMerchantApproved(address,bool)` | 71,161 | 71,161 | 1,316 |
| `setTermsHash(bytes32)` | 48,000 | 48,000 | 1,263 |
| `setUserApproved(address,bool,bytes32)` | 116,405 | 116,417 | 6,285 |
| `shares(address)` | 3,616 | 25,048 | 11,829 |
| `sharesToAssets(uint256)` | 7,540 | 28,780 | 263 |
| `signTerms(bytes32)` | 72,636 | 72,636 | 4,019 |
| `signedTermsHash(address)` | 3,418 | 24,850 | 6,927 |
| `spend(address,uint256)` | 67,414 | 67,582 | 1,105 |
| `supportsInterface(bytes4)` | 21,567 | 21,567 | 3 |
| `termsHash()` | 3,356 | 24,420 | 1,345 |
| `termsSigned(address)` | 3,012 | 24,444 | 6,690 |
| `totalCredit()` | 3,290 | 24,354 | 3,153 |
| `totalLent()` | 2,828 | 23,892 | 5,546 |
| `totalShares()` | 2,564 | 23,628 | 4,972 |
| `transfer(address,uint256)` | 23,154 | 23,154 | 1 |
| `unpause()` | 36,353 | 36,353 | 483 |
| `usdc()` | 11,002 | 21,568 | 6 |
| `walletOfAccount(bytes32)` | 3,832 | 25,408 | 14,752 |
| `withdraw(uint256)` | 72,171 | 150,718 | 2,356 |
| `withdrawAll()` | 72,339 | 151,792 | 1,347 |
