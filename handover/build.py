"""Builds the backend handover from the compiled ledger, so it can never drift from the contract.

    python handover/build.py           write abi/, client/, errors.json, events.json
    python handover/build.py --check   exit 1 if any written file differs from what the contract gives
    python handover/build.py --gas     also write gas.md from `forge test --gas-report --json`

Run from the repository root after `forge build` in contracts/. Every error and every event in the
ABI must have an entry below, and every entry must be in the ABI: either way the build fails, so a
new error or event cannot reach the backend without its message or its effect.
"""

import json
import pathlib
import subprocess
import sys

VERSION = "1.0.0"
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "handover"
CONTRACTS = ROOT / "contracts"

# Plain-English message for the app, per error name. Arguments in {braces} are filled by the backend.
MESSAGES = {
    "AccessControlBadConfirmation": "The role can only be given up by the address that holds it.",
    "AccessControlEnforcedDefaultAdminDelay": "The top admin transfer is not ready yet; it can be accepted after {schedule}.",
    "AccessControlEnforcedDefaultAdminRules": "The top admin role can only move through the two-step, three-day transfer.",
    "AccessControlInvalidDefaultAdmin": "Only the address named in the pending transfer can accept the top admin role.",
    "AccessControlUnauthorizedAccount": "This wallet is not allowed to do that.",
    "AccountAlreadyLinked": "This app account is already linked to another wallet.",
    "AccountHasLockedCredit": "This account has credit locked in an open loan; it can move once every loan is repaid or closed.",
    "AccountRefMismatch": "The account reference does not match the one linked to this wallet.",
    "AlreadySigned": "You have already signed these terms.",
    "AssetAlreadyRegistered": "This document has already been registered.",
    "CreditCapExceeded": "This amount would take the account above the maximum credit it can hold.",
    "DivisionByZero": "Internal calculation error. Please contact support.",
    "EnforcedPause": "The platform is paused. Please try again later.",
    "ExpectedPause": "The platform is not paused.",
    "ExtensionWindowClosed": "This loan is past its due date and can no longer be extended.",
    "ExtensionWindowNotOpen": "This loan can be extended from {opensAt}, in the last 30 days before it is due.",
    "InsufficientAvailableCredit": "Not enough available credit: {requested} needed, {available} available.",
    "InsufficientLiquidity": "The pool does not hold enough USDC right now: {requested} requested, {available} available.",
    "InsufficientShares": "This is more than your share of the pool.",
    "InvalidAssetType": "Unknown document type.",
    "InvalidParticipant": "This address cannot take part in the platform.",
    "LiquidationGracePeriod": "This loan cannot be closed yet: borrowers have until {endsAt} after the platform was paused.",
    "LoanNotActive": "This loan is already repaid or closed.",
    "LoanNotFound": "Loan not found.",
    "MathOverflow": "This amount is too large.",
    "MerchantTermsNotSigned": "This merchant is not ready to receive payments yet.",
    "NotAUser": "This address is not a platform user.",
    "NotApprovedMerchant": "This merchant is not approved.",
    "NotApprovedUser": "Your account is not approved.",
    "NotBorrower": "Only the borrower can do this.",
    "NotYetDue": "This loan is not overdue; it is due on {dueDate}.",
    "ParticipantRoleConflict": "This wallet already has a different role on the platform.",
    "ReentrancyGuardReentrantCall": "The transaction was refused. Please try again.",
    "RepaymentShort": "The repayment arrived short: {principal} needed, {received} received.",
    "SafeCastOverflowedUintDowncast": "This amount is too large.",
    "SafeERC20FailedOperation": "The USDC transfer failed. Check your balance and approval.",
    "TermsNotSet": "The terms are not available yet.",
    "TermsNotSigned": "Please sign the terms first.",
    "UsdcDecimalsUnreadable": "Deployment error: the token does not report its decimals.",
    "UsdcNotAContract": "Deployment error: the token address is not a contract.",
    "UsdcWrongDecimals": "Deployment error: the token does not have 6 decimals.",
    "WalletAlreadyLinked": "This wallet is already linked to another app account.",
    "WalletNotFresh": "The new wallet has already been used on the platform; choose one that never has.",
    "WrongTermsHash": "These are not the current terms. Please reload and sign again.",
    "ZeroAccountRef": "An app account must be given.",
    "ZeroAddress": "An address is missing.",
    "ZeroAmount": "The amount must be more than zero.",
    "ZeroDocHash": "The document fingerprint is missing.",
    "ZeroShares": "This deposit is too small to buy any share of the pool.",
    "ZeroTermsHash": "The terms fingerprint is missing.",
}

# Reverts that are not in the ABI but can reach the backend: the USDC token reverts with strings.
EXTRA_ERRORS = [
    {"selector": "0x08c379a0", "name": "Error", "signature": "Error(string)",
     "args": [{"name": "message", "type": "string"}],
     "message": "The USDC transfer failed: {message}. Check your balance and approval."},
    {"selector": "0x4e487b71", "name": "Panic", "signature": "Panic(uint256)",
     "args": [{"name": "code", "type": "uint256"}],
     "message": "Internal error. Please contact support. The ledger never panics by design; report this."},
]

# What each event changes in the read model. All amounts 6 decimals (1 credit = 1 USDC).
EFFECTS = {
    "TermsHashSet": "Current terms version. Existing signatures are not cleared.",
    "TermsSigned": "Signer accepted this terms version at `at`. One address may sign several versions (D-25): keep every one, never overwrite.",
    "UserApprovalSet": "Set approval. On the first approval store the wallet-account link both ways; it never changes except by AccountMoved. Revocation blocks new actions only; balances and loans are untouched.",
    "MerchantApprovalSet": "Set approval. A revoked merchant can still withdraw.",
    "AccountMoved": "credit[newWallet] = creditMoved, credit[oldWallet] = 0 (totalCredit unchanged); newWallet approved user, linked to accountRef both ways; oldWallet unapproved, unlinked, retired for good. No UserApprovalSet is emitted for either wallet. newWallet has not signed the terms unless it signed on its own.",
    "AssetRegistered": "New asset row. Always followed by CreditMinted in the same transaction.",
    "CreditMinted": "credit[user] += amount, totalCredit += amount. reason is the docHash for an asset, the admin's opaque memo otherwise.",
    "CreditBurned": "credit[user] -= amount, totalCredit -= amount. Never touches locked credit. user may be a user or a merchant (D-63).",
    "Spent": "credit[user] -= amount, credit[merchant] += amount. No fee.",
    "MerchantReceipt": "The merchant's receipt for the Spent in the same transaction; do not apply the balance change twice.",
    "Deposited": "shares[merchant] += shares, totalShares += shares, poolUsdc += assets (the amount actually received).",
    "Withdrawn": "shares[merchant] -= shares, totalShares -= shares, poolUsdc -= assets. Emitted by withdraw and withdrawAll.",
    "LoanOpened": "New Active loan. lockedCredit[borrower] += collateral, totalLent += principal, poolUsdc -= principal.",
    "CollateralLocked": "Same transaction as LoanOpened; apply the lock from one of them only. Lets reconciliation check lockedCredit from events alone.",
    "LoanExtended": "Set the due date and the rollover count (the count includes this extension).",
    "LoanRepaid": "Status Repaid. totalLent -= principal, poolUsdc += principal.",
    "CollateralReleased": "lockedCredit[user] -= amount (same transaction as LoanRepaid).",
    "LoanDefaulted": "Status Defaulted. lockedCredit[borrower] and credit[borrower] -= collateral, totalCredit -= collateral, poolCredit += collateral, totalLent -= principal. No USDC moves.",
    "Paused": "Every user and pool function stops; admin setters and adminMoveAccount still work.",
    "Unpaused": "Functions work again. Followed by PauseTimesSet.",
    "PauseTimesSet": "Store both. No liquidation until lastUnpausedAt + 7 days; a loan due on or after lastPausedAt may still be extended until then. lastPausedAt is the start of the merged disruption: never derive it from Paused events.",
    "DefaultAdminTransferScheduled": "newAdmin may accept the top role after acceptSchedule (3 days). One the Safe signers did not start means act at once. newAdmin 0 is a scheduled renounce.",
    "DefaultAdminTransferCanceled": "The pending top admin transfer is gone.",
    "DefaultAdminDelayChangeScheduled": "The 3-day transfer delay becomes newDelay at effectSchedule.",
    "DefaultAdminDelayChangeCanceled": "The pending delay change is gone.",
    "RoleGranted": "Role given (admin action log). An accepted top admin transfer is RoleRevoked(0x00, old) then RoleGranted(0x00, new).",
    "RoleRevoked": "Role removed (admin action log).",
    "RoleAdminChanged": "Not emitted after deployment in practice; log it if seen.",
}


def forge(what):
    out = subprocess.run(["forge", "inspect", "IndicoLedger", what, "--json"], cwd=CONTRACTS,
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def build():
    abi = forge("abi")
    selectors = forge("errors")
    topics = forge("events")

    names = {e["name"] for e in abi if e["type"] == "error"}
    missing = sorted(names - MESSAGES.keys())
    stale = sorted(MESSAGES.keys() - names)
    errors, seen = [], set()
    for e in abi:
        if e["type"] != "error":
            continue
        sig = e["name"] + "(" + ",".join(i["type"] for i in e["inputs"]) + ")"
        if sig in seen:  # LedgerMath and the interface declare the same error: one selector
            continue
        seen.add(sig)
        errors.append({"selector": "0x" + selectors[sig], "name": e["name"], "signature": sig,
                       "args": [{"name": i["name"], "type": i["type"]} for i in e["inputs"]],
                       "message": MESSAGES.get(e["name"], "")})
    errors.sort(key=lambda x: x["name"])
    errors += EXTRA_ERRORS

    evnames = {e["name"] for e in abi if e["type"] == "event"}
    missing += sorted(evnames - EFFECTS.keys())
    stale += sorted(EFFECTS.keys() - evnames)
    events = []
    for e in sorted((e for e in abi if e["type"] == "event"), key=lambda e: e["name"]):
        sig = e["name"] + "(" + ",".join(i["type"] for i in e["inputs"]) + ")"
        events.append({"topic0": topics[sig], "name": e["name"], "signature": sig,
                       "indexed": [i["name"] for i in e["inputs"] if i["indexed"]],
                       "data": [i["name"] for i in e["inputs"] if not i["indexed"]],
                       "effect": EFFECTS.get(e["name"], "")})
    if missing or stale:
        sys.exit(f"handover out of step with the ABI: no entry for {missing}; entry but not in ABI {stale}")

    js = lambda o: json.dumps(o, indent=2) + "\n"
    errmap = {x["selector"]: {"name": x["name"], "message": x["message"]} for x in errors}
    ts = (
        f"// Generated by handover/build.py from the compiled IndicoLedger, interface {VERSION}. Do not edit.\n"
        "// Use with viem: encodeFunctionData, decodeEventLog and decodeErrorResult infer every type from\n"
        "// `indicoLedgerAbi`. Amounts are bigint with 6 decimals (1 credit = 1 USDC).\n\n"
        f'export const INTERFACE_VERSION = "{VERSION}" as const;\n\n'
        f"export const indicoLedgerAbi = {json.dumps(abi, indent=2)} as const;\n\n"
        "/** Revert selector to error name and a plain-English message for the app. */\n"
        f"export const indicoLedgerErrors: Record<string, {{ name: string; message: string }}> = {json.dumps(errmap, indent=2)};\n"
    )
    return {
        "abi/IndicoLedger.json": js(abi),
        "client/indicoLedger.ts": ts,
        "errors.json": js(errors),
        "events.json": js(events),
    }


def gas_table():
    out = subprocess.run(["forge", "test", "--gas-report", "--json"], cwd=CONTRACTS,
                         capture_output=True, text=True, check=True).stdout
    report = next(json.loads(l) for l in out.splitlines() if l.startswith("[") or l.startswith("{"))
    ledger = next(c for c in report if c["contract"].endswith(":IndicoLedger"))
    rows = ["| Function | Typical (median) | Worst seen (max) | Calls in tests |", "|---|---|---|---|"]
    for sig, g in sorted(ledger["functions"].items()):
        rows.append(f"| `{sig}` | {g['median']:,} | {g['max']:,} | {g['calls']:,} |")
    return (
        f"# Gas per function, interface {VERSION}\n\n"
        "From `forge test --gas-report` over the whole test suite (Forge 1.8.3, optimizer 200, via_ir).\n"
        "Execution gas only, without the 21,000 base cost and calldata. Typical is the median over\n"
        "every call the tests made, refused ones included, so it can sit below a successful call.\n"
        "Worst seen is the most expensive call, usually a first-time storage write; it is not an\n"
        "upper bound. Always estimate the real transaction with `eth_estimateGas` before the user signs\n"
        "(PRD U-11); use this table for planning and for the insufficient-ETH message only.\n\n"
        + "\n".join(rows) + "\n"
    )


def main():
    files = build()
    if "--gas" in sys.argv:
        files["gas.md"] = gas_table()
    if "--check" in sys.argv:
        stale = [p for p, c in files.items()
                 if not (OUT / p).exists() or (OUT / p).read_text(encoding="utf-8") != c]
        if stale:
            sys.exit(f"handover is stale, run python handover/build.py: {stale}")
        print(f"handover current: {sorted(files)}")
        return
    for p, c in files.items():
        (OUT / p).parent.mkdir(parents=True, exist_ok=True)
        (OUT / p).write_text(c, encoding="utf-8", newline="\n")
    print(f"wrote {sorted(files)}")


if __name__ == "__main__":
    main()
