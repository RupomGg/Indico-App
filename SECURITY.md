# Security Policy & Responsible Disclosure Program

Indico Protocol places the highest priority on user asset safety, deterministic transaction execution, and the security of its decentralized lending infrastructure.

---

## 1. Scope

This security policy covers all production smart contracts and core protocol services deployed on the **Base** network:

* **Smart Contracts**:
  * `contracts/src/IndicoLedger.sol`
  * `contracts/src/interfaces/IIndicoLedger.sol`
  * `contracts/src/lib/Constants.sol`
  * `contracts/src/lib/Math.sol`
* **API & Backend**:
  * Core authentication (EIP-4361 SIWE)
  * Prepared calldata generation endpoints (`/api/v1/loans`, `/api/v1/credit`, `/api/v1/ai`)
  * Role-based access control (RBAC) boundaries

---

## 2. Responsible Disclosure & Bug Bounty Program

We encourage white-hat security researchers to review our code and responsibly report any discovered vulnerabilities.

### Reporting a Vulnerability

**DO NOT submit public GitHub issues for security vulnerabilities.**

If you discover a potential vulnerability, please email our security team immediately:
* **Email**: `security@indico.finance` (or contact project maintainers via encrypted communication)
* **Response SLA**: We commit to acknowledging receipt within **24 hours** and providing an assessment within **72 hours**.

### Rewards & Recognition

We offer discretionary rewards for eligible vulnerability disclosures based on impact (measured using the Immunefi vulnerability severity classification):

| Severity | Description | Reward |
| :--- | :--- | :--- |
| **Critical** | Direct theft of user funds, permanent freezing of pool liquidity, or insolvency | Discretionary / Protocol Grant + Public Hall of Fame |
| **High** | Temporary freeze of funds, unauthorized state alteration without fund loss | Discretionary / Protocol Grant + Public Hall of Fame |
| **Medium** | Griefing attacks, gas exhaustion, logic edge-cases requiring specific preconditions | Public Recognition / Hall of Fame |
| **Low** | Informational findings, NatSpec errors, or minor style discrepancies | Public Recognition |

---

## 3. Ground Rules & Safe Harbor

To qualify for safe harbor and rewards:
1. **No Real Funds At Risk**: Test exploits against local forks or public testnets (Base Sepolia). Do not attempt to exploit production pools holding live user funds.
2. **Confidentiality**: Give our team adequate time to remediate the issue before any public disclosure.
3. **No Phishing or Social Engineering**: Attacks targeting team members, social engineering, or physical security are strictly out of scope.
4. **Good Faith**: Acting in good faith grants researchers full safe harbor from legal action.

---

## 4. Security Architecture & Guardrails

* **Rule D-11 Compliance**: Indico protocol APIs and AI systems generate structured previews for wallet signatures, never direct autonomous transactions.
* **Emergency Pause**: The contract implements OpenZeppelin `Pausable` governed by a dedicated `GUARDIAN_ROLE`.
* **Two-Step Admin Timelock**: Admin role transfers are enforced via `AccessControlDefaultAdminRules` with a mandatory transfer delay.

