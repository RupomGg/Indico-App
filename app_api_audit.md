# Indico API audit: Flutter app vs backend

**Date:** 2026-10-27
**Backend:** `Indico-App/backend`, run locally (Postgres 16, `npm run dev` and `npm run worker`, seeded with `SEED_MOCK_DATA=true`). Chain: Base Sepolia.
**App:** `indico_asset_ledger` (Flutter). Its network layer is in `lib/data/`.

Backend file paths below are relative to `backend/src/`.

## Summary

- Every route the app calls exists in the backend, with the right method. That's 29 of them, checked against the live OpenAPI spec at `/docs/json`.
- No 5xx errors appeared during testing. Every 4xx in the server log came from a test that sends bad input on purpose.
- The backend has **7 problems**, listed below from most to least severe. Three are high: the indexer, an email-verification bypass, and the lack of any email delivery.
- Several success responses could not be checked. The seeded test account is approved in the database but not on-chain, so the backend refuses every `prepare-*` call except `terms/prepare-sign` (see section 4).

## 1. Endpoint coverage

| Route the app uses | Result |
| --- | --- |
| `POST /auth/register`, `/auth/verify-email`, `/auth/login`, `/auth/logout`, `/auth/refresh` | Live-tested OK. Refresh rotates the token and the old one stops working. Logout revokes the token. |
| `POST /auth/reset-password/request`, `/auth/reset-password/confirm` | Live-tested OK |
| `GET /profile/`, `PATCH /profile/` | GET live-tested OK. The app uses PATCH, but the live tests don't call it. |
| `GET /profile/wallet`, `POST /profile/wallet/bind` | Live-tested OK, with a real secp256k1 signature. A wrong signature is rejected. |
| `GET /terms/current`, `POST /terms/prepare-sign` | Live-tested OK |
| `GET /assets/`, `GET /assets/{id}`, `GET /assets/{id}/document` | Live-tested OK. The document comes back byte-for-byte identical, but see issue 6. Unknown id → 404. |
| `POST /assets/presigned-upload` → `POST /assets/upload/{uploadId}` → `POST /assets/submit` | Live-tested OK |
| `GET /merchants/` (with `search`) | Live-tested OK |
| `GET /history/balance` | Live-tested OK |
| `POST /assets/{id}/prepare-register` | Exists. Only the "not approved on-chain" refusal was observed. |
| `POST /credit/prepare-spend` | Exists. Only the refusal was observed. |
| `POST /loans/prepare-borrow` | Exists. Only the refusal was observed. |
| `POST /loans/prepare-repay`, `/loans/prepare-extend`, `GET /history/loans/{loanId}` | Exist. Never called, because there are no loans. |
| `GET /history/loans`, `GET /history/transactions` | Exist. They only ever returned empty lists (see issue 1). |

The app doesn't use two user routes:
- `GET /terms/status`: `GET /profile/wallet` already returns `isTermsSignedOnChain` and `isUserApprovedOnChain`.
- `GET /merchants/{id}`: the list response already includes each merchant's services.

Neither is a problem.

## 2. Issues

### 1. High: chain events are never saved, and nothing reports the failure

- **Evidence:**
  - `modules/indexer/indexer.projector.ts:418-427` saves the decoded event as `data: log.args`. viem decodes `uint256` fields (`amount`, `loanId`, `principal`, `dueDate`, and so on) as JavaScript `bigint`. Node can't put a `bigint` into JSON: `JSON.stringify({ amount: 1n })` throws `Do not know how to serialize a BigInt` (checked). So writing the `chain_events` Json column is expected to fail for every Indico event that has a numeric argument.
  - `modules/indexer/indexer.service.ts:125` wraps each log in a bare `catch {}` meant to "ignore logs that do not match the ABI". It swallows this error too, and the checkpoint still moves forward (`:131`).
- **Impact:**
  - `GET /history/transactions` reads `chain_events`, so it always returns an empty list.
  - The read-model updates (balances, loans) run *before* the failing insert, so they can still be applied. But the duplicate-event check (`indexer.projector.ts:18-29`) looks for the `chain_events` row, which never gets written. If the same block range is synced twice (a restart before the checkpoint commits, or a manual resync), balances are counted twice.
  - `replayAllEvents()` clears the read models and then has no events to replay from.
  - The same `catch {}` also hides RPC errors from `getBlock`. Any event hit by one is lost for good, because the checkpoint has already moved past it.
- **Suggested fix:**
  - Convert `bigint` values to strings before saving, for example with a `JSON.stringify` replacer or a small `toJsonSafe(args)` helper.
  - Only skip decode errors (`AbiEventSignatureNotFoundError`), and log or rethrow everything else.
- **How confident:** high from reading the code, but not reproduced end to end. Our test wallet can't send transactions yet. To reproduce: emit any `CreditMinted`/`Spent`/`LoanOpened` event, let the worker sync, then run `SELECT count(*) FROM chain_events;`.

### 2. High (security): register returns the email verification token in every environment

- **Evidence:** `modules/auth/auth.service.ts:50` always returns `verificationToken`. The schema comment says otherwise: `modules/auth/auth.schemas.ts:17` reads "Provided in development/test environments". The password reset token is handled correctly: it's hidden when `NODE_ENV=production` (`auth.service.ts:203`).
- **Impact:** anyone can register with an email address they don't own, verify it straight away with the token from the response, and get a verified account.
- **Suggested fix:** hide it under the same `NODE_ENV !== "production"` condition as `resetToken`.

### 3. High: the backend sends no email

- **Evidence:** nothing in `src/` sends email: no nodemailer, SMTP or provider SDK.
- **Impact:** in production the reset token is hidden from the response, and with issue 2 fixed so is the verification token. Users then have no way to receive either one, so nobody can verify their email or reset their password.
- **Suggested fix:** add a mail provider and send the verification and reset links.

### 4. Medium: `/history/transactions` loads every event and filters in JavaScript

- **Evidence:** `modules/history/history.service.ts:181-197` runs `prisma.chainEvent.findMany()` with no `where`, then filters on `data.user`/`borrower`/`signer`/`merchant` in JavaScript. There is no pagination, although `total` is returned.
- **Impact:** every request reads the whole table, so the endpoint gets slower and uses more memory as the platform grows.
- **Suggested fix:** store the participant addresses in indexed columns when indexing, filter in SQL, and add `page`/`limit` to match `GET /assets/`.

### 5. Low: the explorer URL is hard-coded

- **Evidence:** `modules/history/history.service.ts:208` builds `https://sepolia.basescan.org/tx/...`.
- **Impact:** on mainnet (or any other chain) these links point to the wrong explorer.
- **Suggested fix:** build the URL from the chain config.

### 6. Low: the document download always calls the file `.pdf`, with a generic content type

- **Evidence:** `modules/assets/assets.routes.ts:196-197` always sends `Content-Type: application/octet-stream` and `filename="<docHash>.pdf"`. Upload accepts `application/pdf`, `image/png` and `image/jpeg` (`assets.schemas.ts:6-8`), and the MIME type and file name are passed to storage (`assets.service.ts:51`), but the download never uses them.
- **Impact:** an image upload downloads as a `.pdf` file that won't open. Clients can't tell what kind of file they got.
- **Suggested fix:** return the stored MIME type and original file name (or the matching extension) on download.

### 7. Low: an account not approved on-chain gets 400 from one endpoint and 403 from others

- **What happens:**
  - `POST /assets/{id}/prepare-register` returns **400**. The message comes from a contract simulation revert (`lib/viem.ts:190`, reached from `assets.service.ts:186`).
  - `POST /credit/prepare-spend` and `POST /loans/prepare-borrow` return **403**. These check up front (`credit.service.ts:102`, `loans.service.ts:87`).
- **Impact:** clients have to match on the message text to recognize "not approved on-chain".
- **Suggested fix:** give `prepare-register` the same up-front check, and return one status code with a machine-readable `code` (for example `NOT_APPROVED_ON_CHAIN`) on every `prepare-*` endpoint.

## 3. Development setup

`SEED_MOCK_DATA=true` creates `alice@indico.example` with `isApproved = true` in the database. Her wallet (`0x7099…79c8`) is **not** approved on the Base Sepolia contract, so none of the `prepare-*` flows can run locally (asset registration, spend, borrow, repay, extend).

**Request:** either of these would work:
- a seed step or script that calls `setUserApproved` for the seeded wallet;
- documented admin steps for approving a test wallet on-chain.

## 4. What we couldn't verify (needs an account approved on-chain)

The app parses these responses using `app_api_co.md` and the backend source, but has never received a real success response for them:

- Success responses from `prepare-register`, `prepare-spend`, `prepare-borrow`, `prepare-repay` and `prepare-extend`. In particular:
  - `requiredCollateral` on borrow;
  - the approval transaction plus the repay transaction returned by `prepare-repay`.
- What a loan item looks like in `GET /history/loans` and `GET /history/loans/{loanId}`.
- What an event item looks like in `GET /history/transactions` (blocked by issue 1).
- Sending signed transactions through WalletConnect.

Please confirm these shapes, or provide a test wallet that's approved on-chain and has a little Base Sepolia ETH.

## 5. How this was tested

- **Routes:** we diffed the live OpenAPI spec (`GET /docs/json`) against every path in the app's `lib/data/`.
- **API layer:** `flutter test test/live_api_test.dart --dart-define=LIVE_API=http://localhost:3000` (7 tests, all passing). It covers:
  - auth, refresh and logout;
  - register → verify → wallet bind with a real signature;
  - password reset;
  - upload → submit → download;
  - the `prepare-*` calls;
  - error mapping.
- **Whole app:** `integration_test/live_app_test.dart` passes on macOS and on the iOS simulator (iPhone 17, iOS 26.2). It signs in, then checks terms, dashboard, assets, loans, activity, merchant search and sign-out.
- **Session restore:** `integration_test/live_restore_test.dart` (iOS). The session survives an app relaunch.
