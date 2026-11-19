# Security Policy

`dsh-os-suite` is a community project. It is **not** affiliated with, sponsored by, or endorsed by DeepSeek.

## Supported versions

Security fixes are issued for the latest published `0.2.x` release only. The six packages are released in lockstep, so they share one version.

| Version | Supported |
| --- | --- |
| `0.2.5` (current) | Yes |
| `0.2.4` and earlier | No |

Unsupported versions should be upgraded before reporting. There are no backport branches.

## Reporting a vulnerability

**Please report privately. Do not open a public issue, discussion, or pull request for a vulnerability.**

Use GitHub Security Advisories:

1. Open <https://github.com/PerryLink/dsh-os-suite/security/advisories/new>.
2. Or go to the repository's **Security** tab, then **Advisories**, then **Report a vulnerability**.

Please include:

- the affected package(s) and version;
- your operating system, Node.js version, and DSH version;
- a concise description of the issue and its impact;
- reproduction steps or a minimal proof of concept;
- any relevant logs, with tokens, keys, customer data, and other secrets removed.

There is **no security email address**. GitHub Security Advisories is the only supported private channel. If the advisory form is unavailable, contact [@PerryLink](https://github.com/PerryLink) on GitHub and ask for a private channel; do not include vulnerability details in that first message.

## Response expectations

This is a small volunteer project. Reports are handled on a **best-effort** basis.

- **No SLA.** We do not guarantee acknowledgment, a response time, a fix, or a release date.
- We aim to acknowledge a complete report within 7 calendar days, but this is not a commitment.
- We may ask for more information or a smaller reproduction, and we will tell you if we cannot reproduce the issue.
- We will coordinate a fix and an advisory with you. Please allow **90 days** before public disclosure; we can agree on a shorter or longer window where appropriate.
- We will credit you in the advisory unless you ask to remain anonymous.
- There is no bug bounty.

## Scope

### In scope

Security issues in the code and packaging of the six packages in this repository:

- `dsh-os-trace`, `dsh-os-lease`, `dsh-os-quota`, `dsh-os-eval`, `dsh-os-catalog`, `dsh-os-registry`;
- their Cordis plugin entries, `cordis.patch.yml` bundle patches, tool schemas, core logic, and published npm tarballs;
- input validation, path handling, file writes, redaction, and evidence-bundle handling that could cause code execution, data loss, data exposure, or privilege bypass.

### Out of scope

- **Third-party plugins and tools**, including any plugin used alongside this suite. Report those to their maintainers. This suite's security scope ends at its own packages.
- DeepSeek Harness (DSH), Cordis, Node.js, npm, and other upstream projects.
- Vulnerabilities in dependencies: report them upstream; we will update when a fixed release is available.
- Issues that require an already-compromised machine, an attacker-controlled profile or `DSH_HOME`, leaked local keys, or physical access.
- Missing hardening or defense-in-depth suggestions without a concrete, reproducible impact.
- Automated scanner output with no demonstrated impact.
- The documented design limits of a package (for example advisory quotas, mocked backends, or local-only stores) are not vulnerabilities by themselves.

## Security-adjacent tools in this suite

These packages support governance; they are not security certifications or guarantees.

- **`dsh-os-trace`** produces hash-chained evidence bundles. “Tamper-evident” means an exported bundle is internally consistent; it does not prove the recorded events are true, complete, or legally admissible. The chain is not a signature or a notarization.
- **`dsh-os-quota`** is **advisory**. It reports and admits against budgets; it is not an enforcement boundary against a malicious process.
- **`dsh-os-eval`** is a regression gate, not a security control or a certification of correctness.

No package in this suite is an audit, a compliance certification, or a warranty of safety.

## Safe harbor

We welcome good-faith research. If you follow this policy, test only against your own installation, do not access other people's data, do not run destructive tests against shared infrastructure, and give us a reasonable time to fix the issue, we will not treat your report as abuse.

## Disclosure

We prefer coordinated disclosure. We will publish a GitHub Security Advisory after a fix is available, or after the agreed disclosure date if a fix is not feasible. We will not publish your personal information without permission.
