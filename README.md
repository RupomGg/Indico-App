# Indico Asset Ledger
Invite-only credit platform: users borrow USDC from a merchant-funded pool against self-declared asset credit.
Tests: `cd contracts && forge test` (release gate: `forge test --profile deep`, 5M fuzz runs).
Coverage: `cd contracts && forge coverage --no-match-coverage '(test|script)/'`, 100% lines and branches on `src/`.
Spec: `docs/contract-spec.md`, requirements `docs/PRD.md`, tests `docs/testing-strategy.md` and `docs/input-testing.md`.
Interface for backend: `contracts/src/interfaces/IIndicoLedger.sol`, events in `docs/event-catalogue.md`.
