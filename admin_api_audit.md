# Indico Admin API — Issue Report for the Backend Team

> **Date:** 2026-10-27
> **Scope:** the 20 routes under `/api/v1/admin/*` (`backend/src/modules/admin/`), as consumed by the new admin dashboard (`Indico Admin dashboard/`).
> **Audience:** backend developers. Paths below are relative to `Indico-App/backend/`.
> **Abbreviation:** **svc** = `src/modules/admin/admin.operations.service.ts`.

### How findings were verified

| Tag | Meaning |
|---|---|
| **code** | Confirmed by reading the backend source at the cited `file:line` |
| **live** | Reproduced against a local backend at `http://localhost:3000` (dev database, read-only calls only) |
| **docs** | Mismatch between `admin_api_cl.md` / `admin_api_co.md` and the code |

Nothing here was tested against staging or production. No mutating admin endpoints were called against the live database. Findings tagged **code** are inferred from the source and were not reproduced at runtime.

---

## 1. Summary

| ID | Severity | Title | Area | Verified |
|---|---|---|---|---|
| S1 | **Critical** | Approve/reject responses leak password hash and token hashes | Security | code |
| S2 | **High** | Admin JWT can't be revoked; role is trusted from the token; `JWT_EXPIRES_IN` ignored | Security | code |
| S3 | Medium | Request validation runs before admin authentication | Security | code, docs |
| D1 | **High** | `createMerchant` always records the agreement as signed | Data integrity | code |
| D2 | Medium | Mutations and audit writes aren't atomic; no idempotency | Data integrity | code |
| D3 | Medium | Agreement send/sign have no state guards or validation | Data integrity | code |
| D4 | Low | `sync-chain` changes data without an audit entry and never revokes | Data integrity | code |
| D5 | Medium | "Rejected" and "pending" users are indistinguishable | Data model | code |
| E1 | Medium | Server errors are returned as `400 REQUEST_FAILED` | Error contract | code |
| E2 | Low | Two different validation-error shapes | Error contract | code, docs |
| E3 | Low | Body-less POST with `Content-Type: application/json` is rejected | Error contract | live |
| E4 | Low | Create endpoints return 200, not 201 | Error contract | code |
| A1 | Medium | Audit log results are silently truncated at 500 rows per source | Audit | code |
| A2 | Medium | On-chain date filter uses index time; invalid dates ignored; case-sensitive category | Audit | code |
| A3 | Medium | `userId` resolution is inconsistent (unknown IDs "resolve"; email casing) | Audit | code |
| A4 | Low | IP address / user agent never recorded for admin actions | Audit | code |
| P1 | Medium | One blockchain RPC call per row in list endpoints; RPC failures hidden | Performance | code |
| P2 | Low | `canLiquidate` ignores the liquidation grace period | Correctness | code |
| P3 | Medium | `safe-status` monitors the ledger contract, not the Safe | Correctness | code |
| P4 | Low | `totalDeposited` isn't total deposits | Naming | code |

Section 3 lists **missing endpoints** that block dashboard features. Section 4 lists **documentation corrections**.

---

## 2. Findings

### S1 — Approve/reject responses leak password hash and token hashes · Critical

- **Where:** svc:33–54 (`approveUser`), svc:69–85 (`rejectUser`). The routes in `admin.routes.ts` (`POST /users/:id/approve`, `/reject`) declare no `response` schema.
- **What happens:** both methods `return updated`, the raw result of `prisma.user.update(...)`. It is serialised as-is and includes:
  - `passwordHash` (bcrypt);
  - `emailVerifyToken` and `passwordResetToken` (hashes);
  - their expiry timestamps.
- **Impact:** every approve or revoke sends credential material to the browser, browser devtools, proxies and any client logging. A leaked password-reset token hash, together with its expiry, makes the reset flow more exposed.
- **Repro:** `POST /api/v1/admin/users/<id>/approve` with an admin token, then inspect the body.
- **Suggested fix:**
  1. Add `select: { id, email, isEmailVerified, isApproved, createdAt, updatedAt }` to both `prisma.user.update` calls.
  2. Add a Zod `response: { 200: … }` schema to both routes, so unknown fields are stripped even if the service changes later.
  3. Add a test asserting `passwordHash` is absent from the HTTP response.
  4. Check other routes returning raw rows: agreement send/sign return the raw `Merchant` row (not sensitive today, but the same pattern).
- **Dashboard workaround:** the dashboard discards these response bodies and refetches `GET /users/:id`. The data is still transmitted.

### S2 — Admin JWT can't be revoked; role trusted from token; `JWT_EXPIRES_IN` ignored · High

- **Where:**
  - `src/modules/admin/admin.auth.service.ts:34`: `expiresIn: "12h"` is hard-coded.
  - `src/config/env.ts:12`: `JWT_EXPIRES_IN` (default `7d`) is unused for admins.
  - `admin.auth.service.ts:74–78`: `verifyAdminToken` checks the token's `role`/`domain` claims and that the admin row still exists.
- **What happens:**
  - There is no logout, revocation or refresh endpoint.
  - The database role isn't rechecked, so an admin whose role changes keeps access until the token expires.
  - A stolen token stays valid for up to 12 hours.
- **Suggested fix:**
  - Recheck `admin.role === "ADMIN"` from the database row.
  - Add a token version or `jti` denylist (or short-lived access tokens plus refresh), with a `POST /admin/auth/logout`.
  - Either honour `JWT_EXPIRES_IN` (or a dedicated `ADMIN_JWT_EXPIRES_IN`) or remove it.
- **Dashboard workaround:** "Sign out" only deletes the token from the browser's `sessionStorage`. The UI states that the token stays valid until it expires.

### S3 — Validation runs before admin authentication · Medium

- **Where:** `admin.routes.ts:39`, `adminScope.addHook("preHandler", authenticateAdmin)`. In Fastify, schema validation runs before `preHandler`.
- **What happens:** an unauthenticated request with an invalid body or query gets `400` with the field-level schema message, instead of `401`. Anyone can probe parameter names, enums and limits without credentials. (Both API docs mention this.)
- **Suggested fix:** register `authenticateAdmin` as an `onRequest` hook, which runs before validation.

### D1 — `createMerchant` always records the agreement as signed · High

- **Where:** svc:343, `const isSigned = input.agreementStatus === "SIGNED" || input.agreementStatus === undefined || true;`. Also svc:353–354, and the defaults in `admin.schemas.ts` (`isApproved` default `true`, `agreementStatus` default `"SIGNED"`).
- **What happens:**
  - Because of `|| true`, every merchant creation sets `agreementSentAt`, `agreementSignedAt` and `agreementStorageKey`.
  - It also creates a `MerchantAgreement` row with `status: "SIGNED"`, even when the request says `"NOT_SENT"` or `"SENT"`.
  - The stored `agreementStatus` column keeps the requested value, so the record contradicts itself.
  - The storage key points at a file that is never created.
  - The defaults also make a new merchant immediately visible to users (`isApproved: true`) with a "signed" agreement, which bypasses the send → sign workflow.
- **Impact:** agreement and compliance records are wrong for every merchant created without `SIGNED`. This also blocks building the dashboard's Merchants module reliably.
- **Suggested fix:**
  - Use `const isSigned = (input.agreementStatus ?? "SIGNED") === "SIGNED";`.
  - Set `agreementSentAt` only for `SENT`/`SIGNED`, and the signed fields and agreement row only for `SIGNED`.
  - Reconsider the defaults: `isApproved: false` and `agreementStatus: "NOT_SENT"` are the safer choices.
  - Add tests for all three statuses.
- **Dashboard status:** the Merchants module isn't integrated yet, partly because of this bug.

### D2 — Mutations and audit writes aren't atomic; no idempotency · Medium

- **Where:** every admin mutation, e.g. svc:33 (`user.update`) followed by a separate `auditLog.create`. The same pattern appears in `createMerchant` (merchant, agreement, service and audit as separate writes) and in the agreement and service methods.
- **What happens:**
  - If the audit insert, or a later step, fails, the client receives an error response even though the state change has already been committed.
  - A retry then duplicates side effects: for example a second `MerchantAgreement` row, or a duplicate audit entry.
  - `createMerchant` also swallows agreement-insert failures (svc:371–373).
- **Suggested fix:**
  - Wrap each operation in `prisma.$transaction`.
  - Optionally accept an `Idempotency-Key` header on POST routes.

### D3 — Agreement send/sign have no state guards or validation · Medium

- **Where:** svc:625–653 (`sendMerchantAgreement`), svc:659–702 (`signMerchantAgreement`); route body `z.object({ storageKey: z.string() })` in `admin.routes.ts`.
- **What happens:**
  - `send` overwrites a `SIGNED` agreement back to `SENT`.
  - `sign` accepts an empty `storageKey`.
  - No email is sent, and no file is uploaded or checked for existence.
  - The route description still says "Send arbitration agreement email".
- **Suggested fix:**
  - Reject `send` when the agreement is already `SIGNED` (409).
  - Require a non-empty `storageKey`, and verify the object exists in storage.
  - Either implement email delivery or rename and re-document the endpoint as "mark sent".

### D4 — `sync-chain` changes data without an audit entry and never revokes · Low

- **Where:** svc:439 (`syncMerchantOnChainStatus`).
- **What happens:**
  - The method can set `merchants.isApproved = true` but writes no audit log.
  - It never sets `isApproved = false`, even if on-chain approval has been removed.
- **Suggested fix:** audit every state change. Decide whether chain revocation should be mirrored.

### D5 — "Rejected" and "pending" users are indistinguishable · Medium

- **Where:** svc:69 (`rejectUser` sets `isApproved = false`); `GET /users` status filter `ALL | APPROVED | PENDING`.
- **What happens:** a user who was declined or revoked looks exactly like a new registration awaiting review, so the approval queue can't exclude them. There is also no "suspended" state.
- **Suggested fix:** add an approval status enum (`PENDING | APPROVED | REJECTED | SUSPENDED`), with the reason, timestamp and acting admin. Expose it in list and detail responses and in the status filter.
- **Dashboard workaround:** only All / Approved / Pending filters are shown. The "Revoke approval" action warns that the user returns to "Pending".

### E1 — Server errors are returned as `400 REQUEST_FAILED` · Medium

- **Where:** `src/lib/errors.ts:185–199`. Any error with status ≥ 500, or an unknown error, is returned as `400` with code `REQUEST_FAILED`.
- **Impact:**
  - Clients, load balancers, retry logic and monitoring can't tell a server or database outage from a bad request.
  - Error-rate alerting on 5xx never fires.
- **Suggested fix:** return `500` (or `503` for upstream/RPC/database unavailability) with the same sanitised message.
- **Dashboard workaround:** the dashboard treats `REQUEST_FAILED` as a server error by code.

### E2 — Two different validation-error shapes · Low

- **Where:** `src/lib/errors.ts`. A direct `ZodError` gives `VALIDATION_ERROR` with `details[{field,message}]`. Route-schema failures fall through to the generic branch and give `BAD_REQUEST` with one string message such as `"body/password String must contain at least 8 character(s)"` (several fields comma-joined) and no `details`.
- **Impact:** clients must parse free-text messages to highlight form fields. The two API docs also disagree on which code is returned.
- **Suggested fix:** detect Fastify validation errors (`error.validation` / `hasZodFastifySchemaValidationErrors`) and always return `VALIDATION_ERROR` with a structured `details[]`.

### E3 — Body-less POST with `Content-Type: application/json` is rejected · Low

- **Verified live:** `POST /api/v1/admin/users/x/approve` with `Content-Type: application/json` and an empty body returns **400**.
- **Impact:** many HTTP clients add this header by default, so approve, reject, sync-chain, agreement/send and service DELETE fail with confusing errors.
- **Suggested fix:** accept an empty JSON body on these routes (e.g. a custom content-type parser that allows an empty body), or document it prominently.
- **Dashboard workaround:** the client omits `Content-Type` when there is no body.

### E4 — Create endpoints return 200, not 201 · Low

- **Where:** `POST /merchants` and `POST /merchants/:id/services` use `reply.send(...)` with the default status.
- **Suggested fix:** return `201 Created`, consistent with user-side `POST /assets/submit`.

### A1 — Audit log results are silently truncated at 500 rows per source · Medium

- **Where:** svc:830 onwards (`listAuditLogs`). SYSTEM query at svc:948 (`take: 500`). TRANSACTION query at svc:993 (`take: 500`). In-memory user filter for on-chain events at svc:997 onwards. In-memory merge, sort and paging at the end of the method (around svc:1095–1101).
- **What happens:**
  - SYSTEM rows are filtered in the database, then capped to the newest 500.
  - TRANSACTION rows are filtered by action and date in the database, capped to the newest 500 by block, and **only then** filtered by user in memory. A user's on-chain history outside the newest 500 matching events is invisible.
  - Paging happens in memory over at most 1000 merged rows. `total` and `totalPages` describe the truncated set, not the real count.
- **Impact:** the "immutable audit trail" can't retrieve older records, and the reported counts are wrong once a table passes 500 rows. Compliance exports (dashboard Audit Report) are therefore incomplete.
- **Suggested fix:**
  - Apply every filter in the database. For on-chain events, store indexed wallet columns, or use JSONB path queries on `data`.
  - Paginate with a keyset cursor (`timestamp`, `id`) across the two sources, or expose them as separate paginated endpoints.
  - Return true totals, or explicitly `hasMore` without totals.
- **Dashboard workaround:** the pages state "Searches the 500 most recent administrator actions and the 500 most recent on-chain events". Exports are capped at 1000 rows.

### A2 — On-chain date filter uses index time; invalid dates ignored; case-sensitive category · Medium

- **Where:** svc:985–987 (`chainWhere.createdAt` gte/lte); svc:844/848 (unparsable dates silently dropped); `admin.schemas.ts` (`category` enum is case-sensitive, although the service upper-cases it).
- **What happens:**
  - The date filter matches when an event was **indexed**, but items display the **block time**. After a re-index or a backfill, date-range results are wrong.
  - `startDate=garbage` returns unfiltered data instead of 400.
  - `category=system` returns 400.
- **Suggested fix:**
  - Filter on block time.
  - Reject invalid dates with a 400 (`z.string().datetime()` or `z.coerce.date()`).
  - Accept a case-insensitive category, or document it as upper-case only.

### A3 — `userId` resolution is inconsistent · Medium

- **Where:** svc:856–890.
- **What happens:**
  - An unknown non-email, non-wallet value is echoed back as `resolvedUser: { id: <input>, email: null, wallet: null }` instead of `null`, so clients can't tell "not found" from "found".
  - An email `userId` is lower-cased before lookup, but admin login (`admin.auth.service.ts`) is case-sensitive, and user emails' stored casing isn't normalised on write either. The lookup may miss mixed-case stored emails.
  - A wallet value with no binding falls back to filtering by the raw string.
- **Suggested fix:**
  - Return `resolvedUser: null` when no user exists.
  - Normalise email case consistently: on write, and in both user and admin login.
- **Dashboard workaround:** the dashboard treats a `resolvedUser` without an email as "not found". It uses this audit endpoint as a user lookup, because there's no user search (see section 3).

### A4 — IP address / user agent never recorded for admin actions · Low

- **Where:** all `auditLog.create` calls in svc. None of them pass `ipAddress` or `userAgent`, so SYSTEM entries always read `"system"` / `"internal"`.
- **Suggested fix:** pass `request.ip` and the `user-agent` header from the routes into the service and store them.

### P1 — One blockchain RPC call per row in list endpoints; failures hidden · Medium

- **Where:**
  - `GET /users`: svc:208, one `approvedUser` contract read per user with a wallet, up to 100 per page.
  - `GET /merchants`: svc:257–264, two reads per merchant, and the endpoint has no pagination.
  - `GET /users/:id`: svc:122/138, one read per asset.
  - All of these `catch` errors and return `false`.
- **Impact:** response time grows linearly with page size, and RPC rate limits are easy to hit. An RPC outage looks like "not approved on-chain" rather than "unknown".
- **Suggested fix:**
  - Read on-chain flags from the indexer tables, or batch them with multicall.
  - Return `null` / `"UNKNOWN"` (or a `chainStatusError` flag) when the RPC fails.
  - Paginate `GET /merchants` and `GET /merchants/:id/services`.

### P2 — `canLiquidate` ignores the liquidation grace period · Low

- **Where:** svc:771 and svc:782, `canLiquidate: isOverdue`.
- **What happens:** the contract has a `LiquidationGracePeriod` error, but the API reports `canLiquidate: true` as soon as a loan is overdue.
- **Suggested fix:** include the grace period (read from the contract or config) in `canLiquidate`.

### P3 — `safe-status` monitors the ledger contract, not the Safe · Medium

- **Where:** svc:798–822. `getBalance({ address: env.INDICO_LEDGER_ADDRESS })` is returned as `safeAddress`.
- **Impact:** the "low Safe balance" warning (AD-22) reflects the wrong account. A healthy ledger balance can hide an empty Safe, and the reverse. The local dev environment reports `isLow: true` with `0` ETH for the ledger address.
- **Suggested fix:** add a `SAFE_ADDRESS` env variable, and report that account's balance.

### P4 — `totalDeposited` isn't total deposits · Low

- **Where:** `GET /pool` (`getPoolDashboard`, svc:708). `totalDeposited` and `totalAssets` are `poolCash + totalLent`, a current value, not cumulative deposits.
- **Suggested fix:** rename it, or compute real cumulative deposits from `Deposited` events.

---

## 3. Missing endpoints (dashboard features currently disabled)

The dashboard shows these as **"Not supported by the backend yet"**. The contracts below are **suggestions only**; none of them exist today.

| Dashboard screen | Needed capability | Suggested contract (proposal) |
|---|---|---|
| Assets | List all assets across users with status filter and paging; review actions | `GET /admin/assets?status&page&limit`; `POST /admin/assets/:id/approve {value}`, `/request-revision {reason}`, `/reject {reason}` |
| Credits | Issue credit (or create a Safe proposal) and read credit totals | `POST /admin/credits/issue {userId, assetId, amount}` returning the proposal or tx reference; `GET /admin/credits/summary` (`issued`, `outstanding`) |
| Users | Search, sort, display name, invite, suspend, distinct rejected state (see D5) | `GET /admin/users?search&sort&status`; `POST /admin/users/invite {email}`; `POST /admin/users/:id/suspend` |
| Loans | Status filter, search, per-status counts, loan detail, state actions | `GET /admin/loans?status&search`; `GET /admin/loans/summary`; `GET /admin/loans/:id`; liquidation/default proposal endpoints |
| Dashboard / Transactions charts | Time-series aggregates | `GET /admin/stats/timeseries?metric=credit_issued\|loan_volume\|tx_volume&interval=day\|month&from&to` |
| Dashboard KPIs | One call for headline counts (currently 4–5 requests) | `GET /admin/stats/overview` |
| Settings | Read/write platform configuration; admin user management | `GET/PATCH /admin/settings`; `POST /admin/admins`, password reset, roles |
| Session | Logout / revoke / refresh (see S2) | `POST /admin/auth/logout`; `POST /admin/auth/refresh` |
| Merchants (not yet integrated) | Edit, delete or deactivate a merchant, revoke approval, upload/download the agreement file | `PATCH /admin/merchants/:id`; `POST /admin/merchants/:id/revoke`; `POST/GET /admin/merchants/:id/agreement/file` |

---

## 4. Documentation corrections (`admin_api_cl.md`, `admin_api_co.md`, route descriptions)

1. **`GET /users/:id`**: the route description in `admin.routes.ts` says "View user's balance, assets, loans, history and wallet address". The response has no loans or history.
2. **`POST /merchants/:id/agreement/send`**: the description says it sends an email. No email is sent (D3).
3. **Validation error code**: `admin_api_cl.md` documents `BAD_REQUEST`, while `admin_api_co.md` also lists `VALIDATION_ERROR` with `details`. Route-schema failures actually return `BAD_REQUEST` without `details` (E2).
4. **Audit capping**: `admin_api_cl.md` §3.6.1 says each source is "first capped to its 500 newest rows, then filtered". In the code, SYSTEM filters run **before** the cap (in the database). For TRANSACTION, action and date run before the cap but the user filter runs **after** it (A1).
5. **`GET /safe-status`**: it is described as the Safe balance, but it reads `INDICO_LEDGER_ADDRESS` (P3).
6. **`totalDeposited`**: it is described as deposits, but it is current cash + lent (P4).

---

## 5. Appendix — endpoint usage by the admin dashboard

| Endpoint | Used | Where in the dashboard |
|---|---|---|
| `POST /auth/login` | ✅ | Sign-in screen |
| `GET /auth/me` | ✅ | Session restore, sidebar, Settings |
| `GET /users` | ✅ | Users table, dashboard KPIs, pending-approvals widget, sidebar badge, exports, User report |
| `GET /users/:id` | ✅ | User record panel |
| `POST /users/:id/approve` | ✅ | User record panel (response body discarded, see S1) |
| `POST /users/:id/reject` | ✅ | User record panel ("Revoke approval") |
| `GET /pool` | ✅ | Dashboard KPIs and pool chart, Loans cards, Financial report |
| `GET /loans` | ✅ | Loans table, dashboard KPI, Loan report |
| `GET /safe-status` | ✅ | Treasury card, alerts and notifications, Financial report |
| `GET /audit-logs` | ✅ | Audit Logs, Transactions, Blockchain Proofs, recent activity, Credit and Audit reports, user lookup (A3) |
| `GET /audit-logs/user/:userId` | ✅ | Recent activity in the user record panel |
| `GET /merchants` | ❌ | Merchants module not integrated (D1 and missing endpoints) |
| `GET /merchants/:id/services` | ❌ | — |
| `POST /merchants` | ❌ | — |
| `POST /merchants/:id/sync-chain` | ❌ | — |
| `POST /merchants/:id/services` | ❌ | — |
| `PATCH /merchants/:id/services/:serviceId` | ❌ | — |
| `DELETE /merchants/:id/services/:serviceId` | ❌ | — |
| `POST /merchants/:id/agreement/send` | ❌ | — |
| `POST /merchants/:id/agreement/sign` | ❌ | — |

**Priority order:** S1, then D1, then S2, then E1, then A1. S1 and D1 are small, low-risk code changes.
