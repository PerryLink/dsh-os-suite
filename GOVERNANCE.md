# Governance

## Scope

This repository contains 6 治理层 packages. It is a community project, not affiliated with DeepSeek.

## Decisions

- **Lazy consensus**: proposals stay open for 7 days; silence means consent.
- **Code changes**: one PR per concern; tests required; no unrelated refactors.
- **Releases**: maintainer with release rights; version follows `VERSIONING.md` (next-suite) or semver 0.1.x (os-suite).
- **Security**: follow `SECURITY.md`; do not open public issues for vulnerabilities.

## Roles

| Role | Rights | How |
|---|---|---|
| Contributor | PRs, issues | anyone |
| Reviewer | triage, review | 3 merged PRs |
| Co-maintainer | merge/release for one package | see `MAINTAINERS.md` |
| Maintainer | all packages, releases | current maintainer |

## Conflicts

Disclose commercial interests (e.g., a fork or enterprise distribution) in the PR/issue. Do not use the project name to imply endorsement.

## Changes to this document

Same lazy-consensus rule; changes need one maintainer approval.
