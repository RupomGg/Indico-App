# Indico Protocol — Complete Backend API Specification & Developer Guide

> **Target Audience:** Backend Engineers, Flutter / Mobile Developers, Frontend Integrators  
> **Base URL:** `http://localhost:3000` (Local) / Production Server  
> **Protocol Version:** `v1` (Path Prefix: `/api/v1`)  
> **Blockchain Network:** Base Sepolia Testnet (`Chain ID: 84532`)  
> **Indico Smart Contract:** [`0x422D36E2198863C5b2A6B8E2865fBf5196de96cF`](https://sepolia.basescan.org/address/0x422D36E2198863C5b2A6B8E2865fBf5196de96cF)  
> **USDC Contract:** [`0x036CbD53842c5426634e7929541eC2318f3dCF7e`](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e)

---

## Table of Contents
1. [Core Principles & Architectural Standards](#1-core-principles--architectural-standards)
2. [Authentication & Security Schemes](#2-authentication--security-schemes)
3. [Monetary Amounts & Precision Standard](#3-monetary-amounts--precision-standard)
4. [Standard Envelope & Error Responses](#4-standard-envelope--error-responses)
5. [API Modules Reference](#5-api-modules-reference)
   - [0. System & Health](#0-system--health)
   - [1. Authentication (`/api/v1/auth`)](#1-authentication-apiv1auth)
   - [2. User Profile & Wallet Binding (`/api/v1/profile`)](#2-user-profile--wallet-binding-apiv1profile)
   - [3. Terms & Legal Conditions (`/api/v1/terms`)](#3-terms--legal-conditions-apiv1terms)
   - [4. Real-World Assets & Minting (`/api/v1/assets`)](#4-real-world-assets--minting-apiv1assets)
   - [5. Credit Balance & Merchant Spending (`/api/v1/credit`)](#5-credit-balance--merchant-spending-apiv1credit)
   - [6. Borrowing & Loan Lifecycle (`/api/v1/loans`)](#6-borrowing--loan-lifecycle-apiv1loans)
   - [7. Merchant Catalog (`/api/v1/merchants`)](#7-merchant-catalog-apiv1merchants)
   - [8. Ledger History & Balances (`/api/v1/history`)](#8-ledger-history--balances-apiv1history)
   - [9. Admin Operations & Governance (`/api/v1/admin`)](#9-admin-operations--governance-apiv1admin)
6. [Blockchain Calldata Preparation Workflow](#6-blockchain-calldata-preparation-workflow)
7. [Developer Quick Reference & Environment Variables](#7-developer-quick-reference--environment-variables)

---

## 1. Core Principles & Architectural Standards

1. **Non-Custodial Architecture**:
   The backend **never** holds user private keys. For all state-modifying actions on the blockchain (terms signing, asset registration, credit spending, borrowing, repayment), the backend acts as a **transaction preparer**:
   - It validates user constraints and balances off-chain.
   - It estimates gas and calculates gas shortfalls.
   - It returns typed ABI calldata (`to`, `data`, `value`).
   - The user's wallet (e.g. MetaMask, Web3 provider, Mobile WalletConnect) broadcasts the transaction to Base Sepolia.
   - An asynchronous **Indexer Daemon** (`npm run worker`) listens to contract events and updates local PostgreSQL read models.

2. **Strict REST & JSON**:
   All request and response bodies use JSON (`Content-Type: application/json`), with two exceptions:
   - File Chunk Upload (`POST /api/v1/assets/upload/:uploadId`): accepts `multipart/form-data` or raw binary buffer.
   - Document Download (`GET /api/v1/assets/:id/document`): streams decrypted binary `application/octet-stream`.

3. **OpenAPI / Swagger**:
   Interactive documentation is available at `GET /docs` when the backend is running.

---

## 2. Authentication & Security Schemes

### User JWT Authentication
- **Header**: `Authorization: Bearer <user_jwt_token>`
- Token obtained from `POST /api/v1/auth/login`.
- Session token is cryptographically hashed (`tokenHash`) and recorded in the database to allow immediate server-side revocation on logout (`POST /api/v1/auth/logout`).

### Admin JWT Authentication
- **Header**: `Authorization: Bearer <admin_jwt_token>`
- Token obtained from `POST /api/v1/admin/auth/login`.
- Evaluated with admin role check (`authenticateAdmin`).

### User Account State Gating
Certain transaction-preparing endpoints enforce `requireApproved`:
1. `isEmailVerified === true`
2. `isApproved === true` (approved by platform admin)
3. Wallet bound with cryptographic signature.

---

## 3. Monetary Amounts & Precision Standard

All monetary amounts (USDC and Credit units) represent **6 decimal places** (`1 USDC = 1,000,000 integer units`):
- **Never use floating point numbers** for financial data.
- **Request inputs**: Pass unsigned decimal strings up to 6 decimals, e.g. `"1500.000000"`, `"25.50"`, or `"100"`.
- **Response representations**:
  - `amount`: Human-readable decimal string (e.g. `"1500.000000"`).
  - `amountUnits`: Exact integer unit string (e.g. `"1500000000"`).

---

## 4. Standard Envelope & Error Responses

### Success Envelope
Most standard user endpoints return data wrapped in `{ success: true, data: { ... } }`:
```json
{
  "success": true,
  "data": {
    "message": "Operation completed successfully"
  }
}
```

### Error Envelope
When any request fails (validation, authentication, business logic), the server returns the following structured envelope:
```json
{
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Detailed description of error",
    "details": [
      {
        "field": "email",
        "message": "Invalid email address format"
      }
    ]
  }
}
```

### Common HTTP Status Codes
| Code | Meaning | Typical Trigger |
|:---|:---|:---|
| **`200 OK`** | Request succeeded | Standard queries & operations |
| **`201 Created`** | Resource created | Registrations, asset submissions |
| **`400 Bad Request`** | Input validation failure | Invalid email, zero amounts, bad regex |
| **`401 Unauthorized`** | Missing or expired token | Invalid JWT or unauthenticated |
| **`403 Forbidden`** | Permission denied | Unapproved user, revoked account |
| **`404 Not Found`** | Resource not found | Invalid ID, missing entity |
| **`409 Conflict`** | Duplicate record | Email already registered, duplicate docHash |
| **`422 Unprocessable`** | Semantic validation error | Balance shortfall, expired deadline |
| **`500 Internal`** | Server failure | Database or RPC unexpected error |

---

## 5. API Modules Reference

---

### 0. System & Health

#### `GET /health`
- **Auth**: None (Public)
- **Description**: Basic liveness and readiness probe.
- **Response `200 OK`**:
```json
{
  "status": "ok",
  "timestamp": "2026-10-26T22:00:00.000Z"
}
```

---

### 1. Authentication (`/api/v1/auth`)

#### `POST /api/v1/auth/register`
- **Auth**: None (Public)
- **Description**: Register a new user account with email and password.
- **Request Body**:
```json
{
  "email": "user@example.com",
  "password": "StrongPassword123!"
}
```
- **Response `201 Created`**:
```json
{
  "success": true,
  "data": {
    "userId": "b47c617e-9669-4509-9150-13b7238217f2",
    "email": "user@example.com",
    "message": "Registration successful. Please verify your email.",
    "verificationToken": "e7b0a8274d..."
  }
}
```

#### `POST /api/v1/auth/verify-email`
- **Auth**: None (Public)
- **Description**: Confirm email address using token sent to user email.
- **Request Body**:
```json
{
  "token": "e7b0a8274d..."
}
```
- **Response `200 OK`**:
```json
{
  "success": true,
  "data": {
    "message": "Email verified successfully"
  }
}
```

#### `POST /api/v1/auth/login`
- **Auth**: None (Public)
- **Description**: Log in with email and password to receive a JWT session token.
- **Request Body**:
```json
{
  "email": "user@example.com",
  "password": "StrongPassword123!"
}
```
- **Response `200 OK`**:
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresAt": "2026-11-02T22:00:00.000Z",
    "user": {
      "id": "b47c617e-9669-4509-9150-13b7238217f2",
      "email": "user@example.com",
      "isEmailVerified": true,
      "isApproved": true
    }
  }
}
```

#### `POST /api/v1/auth/logout`
- **Auth**: User Bearer Token
- **Description**: Revoke the current active session token server-side.
- **Request Body**: None
- **Response `200 OK`**:
```json
{
  "success": true,
  "data": {
    "message": "Logged out successfully"
  }
}
```

#### `POST /api/v1/auth/refresh`
- **Auth**: User Bearer Token
- **Description**: Refresh an active session token before expiration.
- **Request Body**: None
- **Response `200 OK`**:
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresAt": "2026-11-02T22:00:00.000Z"
  }
}
```

#### `POST /api/v1/auth/reset-password/request`
- **Auth**: None (Public)
- **Description**: Request a password reset email token.
- **Request Body**:
```json
{
  "email": "user@example.com"
}
```
- **Response `200 OK`**:
```json
{
  "success": true,
  "data": {
    "message": "Password reset instructions sent",
    "resetToken": "optional-token-in-dev-mode"
  }
}
```

#### `POST /api/v1/auth/reset-password/confirm`
- **Auth**: None (Public)
- **Description**: Set a new password using reset token.
- **Request Body**:
```json
{
  "token": "f29b9281a...",
  "newPassword": "NewStrongPassword123!"
}
```
- **Response `200 OK`**:
```json
{
  "success": true,
  "data": {
    "message": "Password reset successfully"
  }
}
```

---

### 2. User Profile & Wallet Binding (`/api/v1/profile`)

#### `GET /api/v1/profile`
- **Auth**: User Bearer Token
- **Description**: Fetch profile details, verification status, and bound wallet.
- **Response `200 OK`**:
```json
{
  "success": true,
  "data": {
    "id": "b47c617e-9669-4509-9150-13b7238217f2",
    "email": "user@example.com",
    "isEmailVerified": true,
    "isApproved": true,
    "walletAddress": "0xd7852a4481b0f5b9d3e8e19c36209b0b4623aa65",
    "accountRef": "0x53995f51bbd813739794cb1f0ef5dfa0ad8908f95c46b5a3eb64f434a9b208fa",
    "createdAt": "2026-10-25T11:20:00.000Z"
  }
}
```

#### `PATCH /api/v1/profile`
- **Auth**: User Bearer Token
- **Description**: Change user password.
- **Request Body**:
```json
{
  "currentPassword": "OldPassword123!",
  "newPassword": "BrandNewPassword123!"
}
```
- **Response `200 OK`**:
```json
{
  "success": true,
  "data": {
    "message": "Password updated successfully"
  }
}
```

#### `GET /api/v1/profile/wallet`
- **Auth**: User Bearer Token
- **Description**: Fetch live connected wallet status, Base Sepolia ETH balance, and on-chain terms/approval state.
- **Response `200 OK`**:
```json
{
  "success": true,
  "data": {
    "isBound": true,
    "walletAddress": "0xd7852a4481b0f5b9d3e8e19c36209b0b4623aa65",
    "accountRef": "0x53995f51bbd813739794cb1f0ef5dfa0ad8908f95c46b5a3eb64f434a9b208fa",
    "boundAt": "2026-10-25T11:25:00.000Z",
    "ethBalance": "0.0452",
    "isTermsSignedOnChain": true,
    "isUserApprovedOnChain": true
  }
}
```

#### `POST /api/v1/profile/wallet/bind`
- **Auth**: User Bearer Token
- **Description**: Cryptographically link an Ethereum address to the user account by verifying an EIP-191 personal signature.
- **Request Body**:
```json
{
  "walletAddress": "0xd7852a4481b0f5b9d3e8e19c36209b0b4623aa65",
  "accountRef": "0x53995f51bbd813739794cb1f0ef5dfa0ad8908f95c46b5a3eb64f434a9b208fa",
  "signature": "0x39a1f...",
  "message": "Indico Account Binding: user@example.com at timestamp 1792825824"
}
```
- **Response `200 OK`**:
```json
{
  "success": true,
  "data": {
    "message": "Wallet bound successfully",
    "walletAddress": "0xd7852a4481b0f5b9d3e8e19c36209b0b4623aa65",
    "accountRef": "0x53995f51bbd813739794cb1f0ef5dfa0ad8908f95c46b5a3eb64f434a9b208fa",
    "boundAt": "2026-10-25T11:25:00.000Z"
  }
}
```

---

### 3. Terms & Legal Conditions (`/api/v1/terms`)

#### `GET /api/v1/terms/current`
- **Auth**: None (Public)
- **Description**: Returns the active platform terms markdown text and active contract `termsHash`.
- **Response `200 OK`**:
```json
{
  "version": "1.0.0",
  "termsHash": "0xb5090fdce618bc3a5ff6bfa15d089d1c9ef0d4cbb8f9bf6711c9f7a780b621e8",
  "title": "Indico Protocol Terms of Service",
  "content": "# Indico Terms of Service\n...",
  "effectiveDate": "2026-10-01T00:00:00.000Z",
  "isOnChainSet": true
}
```

#### `GET /api/v1/terms/status`
- **Auth**: User Bearer Token
- **Description**: Verifies if the authenticated user's bound wallet has executed `signTerms` on-chain for the active `termsHash`.
- **Response `200 OK`**:
```json
{
  "hasBoundWallet": true,
  "walletAddress": "0xd7852a4481b0f5b9d3e8e19c36209b0b4623aa65",
  "termsSigned": true,
  "termsHash": "0xb5090fdce618bc3a5ff6bfa15d089d1c9ef0d4cbb8f9bf6711c9f7a780b621e8",
  "signedTermsHash": "0xb5090fdce618bc3a5ff6bfa15d089d1c9ef0d4cbb8f9bf6711c9f7a780b621e8"
}
```

#### `POST /api/v1/terms/prepare-sign`
- **Auth**: User Bearer Token (Approved User)
- **Description**: Generates calldata and gas estimation for the user's wallet to execute `signTerms(termsHash)` on the IndicoLedger contract.
- **Request Body**: None
- **Response `200 OK`**:
```json
{
  "to": "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF",
  "data": "0x89d6e49a...",
  "value": "0",
  "estimatedGasUnits": "45000",
  "gasCostEth": "0.000045",
  "gasCostUsd": "0.14",
  "userEthBalance": "0.045200",
  "ethShortfall": "0.000000",
  "ethShortfallUnits": "0",
  "canAfford": true,
  "termsHash": "0xb5090fdce618bc3a5ff6bfa15d089d1c9ef0d4cbb8f9bf6711c9f7a780b621e8"
}
```

---

### 4. Real-World Assets & Minting (`/api/v1/assets`)

#### `POST /api/v1/assets/presigned-upload`
- **Auth**: User Bearer Token (Approved User)
- **Description**: Step 1 of asset document upload. Allocates a temporary upload session.
- **Request Body**:
```json
{
  "fileName": "arbitration-award-2026.pdf",
  "fileSizeBytes": 2450810,
  "mimeType": "application/pdf"
}
```
- **Response `200 OK`**:
```json
{
  "uploadId": "upl_89af3b64c012",
  "uploadUrl": "/api/v1/assets/upload/upl_89af3b64c012",
  "expiresAt": "2026-10-26T23:00:00.000Z",
  "maxSizeBytes": 20971520
}
```

#### `POST /api/v1/assets/upload/:uploadId`
- **Auth**: User Bearer Token (Approved User)
- **Content-Type**: `multipart/form-data` with `file` field OR raw binary `application/octet-stream`
- **Description**: Step 2 of asset document upload. Streams the binary bytes into encrypted storage and computes `docHash` (SHA-256).
- **Response `200 OK`**:
```json
{
  "success": true,
  "uploadId": "upl_89af3b64c012",
  "docHash": "0xc859bf549520e588c800806461a9ba46c48325a7eb8e305e7144e1327171e8bf",
  "fileSizeBytes": 2450810,
  "storedKey": "encrypted-docs/2026/10/upl_89af3b64c012.bin"
}
```

#### `POST /api/v1/assets/submit`
- **Auth**: User Bearer Token (Approved User)
- **Description**: Step 3 of asset registration. Validates metadata, checks for duplicate `docHash`, verifies valuation format, and saves the off-chain asset record.
- **Asset Types (0 to 5)**:
  - `0`: Arbitration Award
  - `1`: Bill of Exchange
  - `2`: Promissory Note
  - `3`: Bond
  - `4`: Commercial Invoice / Paper
  - `5`: Other Real-World Asset (Real Estate, Jewelry, etc.)
- **Request Body**:
```json
{
  "uploadId": "upl_89af3b64c012",
  "docHash": "0xc859bf549520e588c800806461a9ba46c48325a7eb8e305e7144e1327171e8bf",
  "assetType": 0,
  "declaredValueUsdc": "50000.000000",
  "referenceNumber": "ARB-2026-904",
  "issueDate": "2026-10-20",
  "issuingParty": "International Arbitration Chamber",
  "description": "Final commercial award against obligor."
}
```
- **Response `201 Created`**:
```json
{
  "id": "ast_39bb401f8290",
  "userId": "b47c617e-9669-4509-9150-13b7238217f2",
  "docHash": "0xc859bf549520e588c800806461a9ba46c48325a7eb8e305e7144e1327171e8bf",
  "assetType": 1,
  "declaredValue": "50000.000000",
  "referenceNumber": "ARB-2026-904",
  "issueDate": "2026-10-20",
  "issuingParty": "International Arbitration Chamber",
  "description": "Final commercial award against obligor.",
  "status": "SUBMITTED",
  "createdAt": "2026-10-26T22:15:00.000Z"
}
```

#### `POST /api/v1/assets/:id/prepare-register`
- **Auth**: User Bearer Token (Approved User)
- **Description**: Step 4. Generates calldata for user's wallet to execute `registerAsset(...)` on the smart contract. Once mined, 1:1 Credit tokens are automatically minted to the borrower's on-chain credit balance.
- **Response `200 OK`**:
```json
{
  "to": "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF",
  "data": "0x2e06f9d2...",
  "value": "0",
  "estimatedGasUnits": "125000",
  "gasCostEth": "0.000125",
  "gasCostUsd": "0.38",
  "userEthBalance": "0.045200",
  "ethShortfall": "0.000000",
  "ethShortfallUnits": "0",
  "canAfford": true,
  "assetId": "ast_39bb401f8290",
  "docHash": "0xc859bf549520e588c800806461a9ba46c48325a7eb8e305e7144e1327171e8bf",
  "assetType": 1,
  "declaredValueUnits": "50000000000"
}
```

#### `GET /api/v1/assets`
- **Auth**: User Bearer Token
- **Query Parameters**:
  - `page`: Integer (default: `1`)
  - `limit`: Integer (max: `100`, default: `20`)
  - `status`: String (`"SUBMITTED"`, `"REGISTERED"`, `"REJECTED"`)
- **Response `200 OK`**:
```json
{
  "items": [
    {
      "id": "ast_39bb401f8290",
      "docHash": "0xc859bf549520e588c800806461a9ba46c48325a7eb8e305e7144e1327171e8bf",
      "assetType": 1,
      "declaredValue": "50000.000000",
      "referenceNumber": "ARB-2026-904",
      "status": "REGISTERED",
      "txHash": "0xcbae...7fda",
      "createdAt": "2026-10-26T22:15:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20,
  "totalPages": 1
}
```

#### `GET /api/v1/assets/:id`
- **Auth**: User Bearer Token
- **Description**: Get full asset detail by ID.

#### `GET /api/v1/assets/:id/document`
- **Auth**: User Bearer Token
- **Description**: Downloads and decrypts the original uploaded document for the owner. Streams binary data with `Content-Disposition: attachment`.

---

### 5. Credit Balance & Merchant Spending (`/api/v1/credit`)

#### `POST /api/v1/credit/prepare-spend`
- **Auth**: User Bearer Token (Approved User)
- **Description**: Generates calldata for `spend(merchantAddress, amount)` on the smart contract. Zero fee is charged. The user's available credit balance is debited, and the merchant's wallet is credited.
- **Request Body**:
```json
{
  "merchantAddress": "0x7b4c803f2e1a90c427da9760738a086a9d168fd1",
  "amount": "2545.50"
}
```
- **Response `200 OK`**:
```json
{
  "to": "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF",
  "data": "0x6f381c10...",
  "value": "0",
  "merchantAddress": "0x7b4c803f2e1a90c427da9760738a086a9d168fd1",
  "amount": "2545.500000",
  "amountUnits": "2545500000",
  "estimatedGasUnits": "55000",
  "gasCostEth": "0.000055",
  "gasCostUsd": "0.17",
  "userEthBalance": "0.045200",
  "ethShortfall": "0.000000",
  "ethShortfallUnits": "0",
  "canAfford": true
}
```

---

### 6. Borrowing & Loan Lifecycle (`/api/v1/loans`)

#### Loan Rules Summary
- **Borrowing Ratio**: Fixed at 80% (`Principal = 0.8 * Collateral` or `Collateral = 1.25 * Principal`).
- **Interest Rate**: 0% (zero interest, zero platform borrowing fees).
- **Duration**: Fixed 90 days.
- **Extension**: 1 extension of +90 days allowed within the final 30 days before maturity.
- **Liquidity**: Drawn from the shared merchant USDC liquidity pool.

#### `POST /api/v1/loans/prepare-borrow`
- **Auth**: User Bearer Token (Approved User)
- **Description**: Prepares calldata for `borrow(principal)` on the smart contract. Automatically locks `1.25 * principal` of Credit as collateral and transfers liquid USDC from the pool to the borrower.
- **Request Body**:
```json
{
  "amount": "1500.00"
}
```
- **Response `200 OK`**:
```json
{
  "to": "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF",
  "data": "0x438690af...",
  "value": "0",
  "principal": "1500.000000",
  "principalUnits": "1500000000",
  "requiredCollateral": "1875.000000",
  "requiredCollateralUnits": "1875000000",
  "estimatedGasUnits": "98000",
  "gasCostEth": "0.000098",
  "gasCostUsd": "0.30",
  "userEthBalance": "0.045200",
  "ethShortfall": "0.000000",
  "ethShortfallUnits": "0",
  "canAfford": true
}
```

#### `POST /api/v1/loans/prepare-repay`
- **Auth**: User Bearer Token (Permitted even if borrower account is revoked)
- **Description**: Generates calldata for full loan repayment. If the borrower has not approved sufficient USDC allowance to the contract, returns an `approvalTx` step alongside the `repayTx`.
- **Request Body**:
```json
{
  "loanId": "3"
}
```
- **Response `200 OK`**:
```json
{
  "loanId": "3",
  "principal": "1500.000000",
  "principalUnits": "1500000000",
  "collateral": "1875.000000",
  "collateralUnits": "1875000000",
  "dueDate": 1799824000,
  "requiresApproval": false,
  "approvalTx": null,
  "repayTx": {
    "to": "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF",
    "data": "0x0e752702...",
    "value": "0",
    "estimatedGasUnits": "75000",
    "gasCostEth": "0.000075",
    "gasCostUsd": "0.23",
    "canAfford": true
  },
  "userEthBalance": "0.045200",
  "ethShortfall": "0.000000",
  "canAfford": true
}
```

#### `POST /api/v1/loans/prepare-extend`
- **Auth**: User Bearer Token (Approved User)
- **Description**: Prepares calldata for `extendLoan(loanId)` to extend the due date by 90 days. Fails if called outside the 30-day window before due date or if already extended.
- **Request Body**:
```json
{
  "loanId": "3"
}
```
- **Response `200 OK`**:
```json
{
  "loanId": "3",
  "dueDate": 1799824000,
  "newDueDate": 1807600000,
  "extensionCount": 1,
  "to": "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF",
  "data": "0x39ba2e11...",
  "value": "0",
  "estimatedGasUnits": "60000",
  "gasCostEth": "0.000060",
  "gasCostUsd": "0.19",
  "userEthBalance": "0.045200",
  "ethShortfall": "0.000000",
  "ethShortfallUnits": "0",
  "canAfford": true
}
```

---

### 7. Merchant Catalog (`/api/v1/merchants`)

#### `GET /api/v1/merchants`
- **Auth**: User Bearer Token
- **Query Parameters**:
  - `query`: String (search term for merchant or service name)
  - `page`: Integer (default: `1`)
  - `limit`: Integer (default: `20`)
- **Response `200 OK`**:
```json
{
  "items": [
    {
      "id": "mer_49af01b",
      "name": "Apex Legal & Arbitration Chambers",
      "walletAddress": "0x7b4c803f2e1a90c427da9760738a086a9d168fd1",
      "contactEmail": "merchant@apexchambers.example",
      "agreementStatus": "SIGNED",
      "services": [
        {
          "id": "srv_81a20",
          "name": "Enforcement Filing & Escrow",
          "price": "2545.500000",
          "priceUnits": "2545500000",
          "description": "Cross-border dispute enforcement service."
        }
      ]
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20,
  "totalPages": 1
}
```

#### `GET /api/v1/merchants/:id`
- **Auth**: User Bearer Token
- **Description**: Returns detailed merchant profile and services catalog.

---

### 8. Ledger History & Balances (`/api/v1/history`)

#### `GET /api/v1/history/balance`
- **Auth**: User Bearer Token
- **Description**: Live balance view querying the `read_credit_balances` indexer projection.
- **Response `200 OK`**:
```json
{
  "walletAddress": "0xd7852a4481b0f5b9d3e8e19c36209b0b4623aa65",
  "credit": "50000.000000",
  "creditUnits": "50000000000",
  "lockedCredit": "1875.000000",
  "lockedCreditUnits": "1875000000",
  "availableCredit": "48125.000000",
  "availableCreditUnits": "48125000000"
}
```

#### `GET /api/v1/history/loans`
- **Auth**: User Bearer Token
- **Query Parameters**:
  - `status`: String (`"ALL"`, `"ACTIVE"`, `"REPAID"`, `"DEFAULTED"`, default: `"ALL"`)
  - `page`: Integer (default: `1`)
  - `limit`: Integer (default: `20`)
- **Response `200 OK`**:
```json
{
  "items": [
    {
      "loanId": "3",
      "borrower": "0xd7852a4481b0f5b9d3e8e19c36209b0b4623aa65",
      "principal": "1500.000000",
      "principalUnits": "1500000000",
      "collateral": "1875.000000",
      "collateralUnits": "1875000000",
      "dueDate": 1799824000,
      "extensionCount": 0,
      "status": "ACTIVE",
      "openedAtBlock": "50146877",
      "repaidAtBlock": null,
      "defaultedAtBlock": null
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20,
  "totalPages": 1
}
```

#### `GET /api/v1/history/loans/:loanId`
- **Auth**: User Bearer Token
- **Description**: Get single loan details by ID.

#### `GET /api/v1/history/transactions`
- **Auth**: User Bearer Token
- **Description**: Chronological list of user on-chain events with clickable BaseScan URLs.
- **Response `200 OK`**:
```json
{
  "items": [
    {
      "id": "tx-bdf702...",
      "txHash": "0x8c95a28bf20166a01b7a2d4b7c4aa",
      "logIndex": 4,
      "eventName": "LoanOpened",
      "blockNumber": "50146877",
      "blockTimestamp": 1792825804,
      "data": {
        "loanId": "3",
        "borrower": "0xd7852a4481b0f5b9d3e8e19c36209b0b4623aa65",
        "amount": "1500000000",
        "collateral": "1875000000"
      },
      "explorerUrl": "https://sepolia.basescan.org/tx/0x8c95a28bf20166a01b7a2d4b7c4aa"
    }
  ],
  "total": 1
}
```

---

### 9. Admin Operations & Governance (`/api/v1/admin`)

#### `POST /api/v1/admin/auth/login`
- **Auth**: None (Public)
- **Description**: Admin authentication.
- **Request Body**:
```json
{
  "email": "admin@indico.example",
  "password": "admin_master_secret"
}
```
- **Response `200 OK`**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "admin": {
    "id": "adm_81729a",
    "email": "admin@indico.example",
    "role": "SUPER_ADMIN"
  }
}
```

#### `GET /api/v1/admin/auth/me`
- **Auth**: Admin Bearer Token
- **Description**: Returns authenticated administrator session profile.

#### `GET /api/v1/admin/users`
- **Auth**: Admin Bearer Token
- **Query Parameters**:
  - `status`: String (`"ALL"`, `"APPROVED"`, `"PENDING"`, default: `"ALL"`)
  - `page`: Integer (default: `1`)
  - `limit`: Integer (default: `20`)
- **Response `200 OK`**:
```json
{
  "items": [
    {
      "id": "b47c617e-9669-4509-9150-13b7238217f2",
      "email": "user@example.com",
      "isEmailVerified": true,
      "isApproved": true,
      "createdAt": "2026-10-25T11:20:00.000Z",
      "walletBinding": {
        "walletAddress": "0xd7852a4481b0f5b9d3e8e19c36209b0b4623aa65",
        "accountRef": "0x53995f51bbd813739794cb1f0ef5dfa0ad8908f95c46b5a3eb64f434a9b208fa"
      }
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20,
  "totalPages": 1
}
```

#### `GET /api/v1/admin/users/:id`
- **Auth**: Admin Bearer Token
- **Description**: Deep inspection of user balances, submitted assets, active/historical loans, and bound wallet.

#### `POST /api/v1/admin/users/:id/approve`
- **Auth**: Admin Bearer Token
- **Description**: Approves a pending user. Enables them to sign terms, register assets, and borrow.
- **Response `200 OK`**:
```json
{
  "message": "User approved successfully",
  "user": {
    "id": "b47c617e-9669-4509-9150-13b7238217f2",
    "isApproved": true
  }
}
```

#### `POST /api/v1/admin/users/:id/reject`
- **Auth**: Admin Bearer Token
- **Description**: Declines or revokes user platform access.

#### `GET /api/v1/admin/merchants`
- **Auth**: Admin Bearer Token
- **Description**: Lists all onboarded merchants, agreement status (`NOT_SENT`, `SENT`, `SIGNED`), and service catalog.

#### `POST /api/v1/admin/merchants`
- **Auth**: Admin Bearer Token
- **Description**: Onboard a new merchant.
- **Request Body**:
```json
{
  "name": "Apex Legal & Arbitration Chambers",
  "contactEmail": "merchant@apexchambers.example",
  "walletAddress": "0x7b4c803f2e1a90c427da9760738a086a9d168fd1",
  "isApproved": true,
  "agreementStatus": "SIGNED",
  "initialService": {
    "name": "Enforcement Filing",
    "price": "2545.50",
    "description": "Dispute filing service"
  }
}
```
- **Response `200 OK`**:
```json
{
  "message": "Merchant created successfully",
  "merchant": {
    "id": "mer_49af01b",
    "name": "Apex Legal & Arbitration Chambers",
    "walletAddress": "0x7b4c803f2e1a90c427da9760738a086a9d168fd1"
  }
}
```

#### `POST /api/v1/admin/merchants/:id/sync-chain`
- **Auth**: Admin Bearer Token
- **Description**: Re-checks smart contract to synchronize merchant on-chain approval and terms signature state.

#### `POST /api/v1/admin/merchants/:id/services`
- **Auth**: Admin Bearer Token
- **Description**: Add a new service offering to a merchant.
- **Request Body**:
```json
{
  "name": "Arbitration Escrow Fee",
  "price": "100.00",
  "description": "Standard escrow hold"
}
```

#### `PATCH /api/v1/admin/merchants/:id/services/:serviceId`
- **Auth**: Admin Bearer Token
- **Description**: Edit service offering parameters (name, price, description).

#### `DELETE /api/v1/admin/merchants/:id/services/:serviceId`
- **Auth**: Admin Bearer Token
- **Description**: Remove service offering from the merchant catalog.

#### `POST /api/v1/admin/merchants/:id/agreement/send`
- **Auth**: Admin Bearer Token
- **Description**: Marks the merchant arbitration agreement as dispatched/sent.

#### `POST /api/v1/admin/merchants/:id/agreement/sign`
- **Auth**: Admin Bearer Token
- **Description**: Records that the merchant executed the agreement and stores document reference key.
- **Request Body**:
```json
{
  "storageKey": "signed-agreements/arbitration-mer_49af01b.pdf"
}
```

#### `GET /api/v1/admin/pool`
- **Auth**: Admin Bearer Token
- **Description**: Live shared liquidity pool metrics.
- **Response `200 OK`**:
```json
{
  "poolCash": "7.000000",
  "availableUsdc": "7.000000",
  "totalLent": "4.000000",
  "totalLentOut": "4.000000",
  "totalAssets": "10.000000",
  "totalDeposited": "10.000000",
  "poolAddress": "0x422D36E2198863C5b2A6B8E2865fBf5196de96cF",
  "isHealthy": true
}
```

#### `GET /api/v1/admin/loans`
- **Auth**: Admin Bearer Token
- **Description**: Supervises all active and historical platform loans, due dates, and liquidation statuses.

#### `GET /api/v1/admin/safe-status`
- **Auth**: Admin Bearer Token
- **Description**: Checks admin Safe multisig gas balance on Base Sepolia.
- **Response `200 OK`**:
```json
{
  "safeAddress": "0x5B3931448b290947eD0b17C43C62074eB101c820",
  "ethBalance": "0.0452",
  "isLowGas": false,
  "minThresholdEth": "0.01"
}
```

#### `GET /api/v1/admin/audit-logs`
- **Auth**: Admin Bearer Token
- **Description**: Master audit trail merging **System Administrative Actions** (`audit_logs`) and **On-Chain Financial Transactions** (`chain_events`) chronologically.
- **Query Parameters**:
  - `category`: String (`"ALL"`, `"SYSTEM"`, `"TRANSACTION"`, default: `"ALL"`)
  - `userId`: String (Filter by user UUID, email, or `0x` wallet address)
  - `startDate` / `from`: String (`YYYY-MM-DD` or ISO string)
  - `endDate` / `to`: String (`YYYY-MM-DD` or ISO string)
  - `action`: String (e.g. `"LoanOpened"`, `"ADMIN_LOGIN"`, `"USER_APPROVED"`)
  - `page`: Integer (default: `1`)
  - `limit`: Integer (max: `500`, default: `50`)
- **Response `200 OK`**:
```json
{
  "items": [
    {
      "id": "tx-bdf702...",
      "category": "TRANSACTION",
      "action": "LoanOpened",
      "actorType": "WALLET",
      "actorId": "0xd7852a4481b0f5b9d3e8e19c36209b0b4623aa65",
      "amountDisplay": "1500.00 USDC",
      "txHash": "0x8c95a28bf20166a01b7a2d4b7c4aa",
      "blockNumber": "50146877",
      "timestamp": "2026-10-26T14:58:04.000Z",
      "payload": {
        "loanId": "3",
        "principal": "1500.00",
        "collateral": "1875000000"
      }
    },
    {
      "id": "9237cf...",
      "category": "SYSTEM",
      "action": "ADMIN_LOGIN",
      "actorType": "ADMIN",
      "actorId": "3d1a93...",
      "resource": "Session",
      "resourceId": "sess_8109",
      "ipAddress": "127.0.0.1",
      "timestamp": "2026-10-26T11:31:43.000Z",
      "payload": {
        "email": "admin@indico.example"
      }
    }
  ],
  "total": 25,
  "systemCount": 6,
  "transactionCount": 19,
  "page": 1,
  "limit": 50,
  "totalPages": 1
}
```

#### `GET /api/v1/admin/audit-logs/user/:userId`
- **Auth**: Admin Bearer Token
- **Description**: Dedicated user audit inspection endpoint. Filters all events (system approvals, wallet binding, and on-chain loans/repayments/spends) by user UUID, email, or wallet address.
- **Route Parameter**:
  - `userId`: Target user UUID, email address, or `0x` wallet address.

---

## 6. Blockchain Calldata Preparation Workflow

Below is the standard integration pattern for web/mobile client interactions with smart contracts:

```
+-----------------------------------------------------------------------------------+
| 1. Client calls Backend API:                                                      |
|    POST /api/v1/loans/prepare-borrow { "amount": "1500.00" }                      |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
| 2. Backend performs:                                                              |
|    - Verify user wallet binding & admin approval                                  |
|    - Verify terms signed on-chain                                                 |
|    - Query contract pool balance & user credit balance                            |
|    - Check 80% borrowing ratio (requires 1,875 Credit)                           |
|    - Estimate gas & calculate ETH shortfall                                       |
|    - Encode ABI calldata: `borrow(1500000000)`                                    |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
| 3. Client receives calldata:                                                      |
|    { "to": "0x422D36E2...", "data": "0x438690af...", "value": "0" }               |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
| 4. Client Wallet (MetaMask / EIP-1193 / Flutter Web3 Provider):                   |
|    Calls `eth_sendTransaction({ to, data, value })`                               |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
| 5. Base Sepolia Blockchain mines block:                                           |
|    - Emits `LoanOpened(loanId, borrower, amount, collateral)`                     |
|    - Locks 1,875 Credit tokens from user                                          |
|    - Transfers 1,500 USDC from pool to user                                       |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------------------+
| 6. Backend Event Indexer Daemon (`npm run worker`):                               |
|    - Detects event log `LoanOpened`                                               |
|    - Updates `read_loans` table (status = ACTIVE)                                 |
|    - Updates `read_credit_balances` (locked += 1,875)                             |
|    - Inserts into `chain_events` audit trail                                      |
+-----------------------------------------------------------------------------------+
```

---

## 7. Developer Quick Reference & Environment Variables

### Backend `.env` Keys
```env
DATABASE_URL="postgresql://indico_user:indico_password@localhost:5432/indico_db?schema=public"
PORT=3000
HOST="0.0.0.0"
NODE_ENV="development"
JWT_SECRET="your-secure-jwt-secret-at-least-32-chars"
JWT_EXPIRES_IN="7d"
RPC_URL="https://sepolia.base.org"
CHAIN_ID=84532
INDICO_LEDGER_ADDRESS="0x422D36E2198863C5b2A6B8E2865fBf5196de96cF"
USDC_ADDRESS="0x036CbD53842c5426634e7929541eC2318f3dCF7e"
STORAGE_DRIVER="local"
STORAGE_LOCAL_PATH="./storage"
DOCUMENT_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
```

### Server & Indexer Commands
- **Start Backend API Server**: `npm run dev` (Runs on `http://localhost:3000`)
- **Start Blockchain Event Indexer**: `npm run worker`
- **Database Migrations**: `npx prisma migrate dev`
- **Interactive API Docs**: `http://localhost:3000/docs`
