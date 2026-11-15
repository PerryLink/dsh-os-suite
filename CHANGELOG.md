# Changelog

## [0.2.0] - 2026-11-15

### Added
- `dsh-os-trace`: live event ingestion (`session/tools/approval/agent/subagent/job/mcp`) and optional HMAC-signed evidence bundles.
- `dsh-os-quota`: `tools/pre-execute` enforcement (hard deny / soft degrade), usage consumption.
- `dsh-os-lease`: optional real file applier with temp+fsync+rename, journal and rollback.
- `dsh-os-eval`: session JSONL parsing, trajectory pairing and replay/evaluate.
- CI: real `DSH_HOME` install smoke, Windows/macOS matrix, coverage artifact.

## [0.1.2] - 2026-11-14

### Changed
- First release published by the GitHub Actions `release.yml` workflow with npm provenance.
- No functional changes; version alignment only.

All notable changes to `dsh-os-suite` are documented here.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The six packages are versioned and released in lockstep.

## [Unreleased]

### Added

- Repository hygiene documentation: `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, and GitHub issue forms for bugs and features. Security reports are routed to private GitHub Security Advisories.
- A `Security · Contributing · Changelog` navigation line at the top of the root README.

## [0.1.1] - 2026-11-14

### Changed

- All six packages moved from `0.1.0` to `0.1.1` and were republished to npm.
- Root README: replaced the “not published” status with the published status and added an **Install** section with the six `dsh plugin --profile web add` commands.
- Package READMEs with a status line: updated to `0.1.1` and “published to npm”.
- `AUDIT.md` records the release and the isolated-`DSH_HOME` install result.

### Fixed

- Stale publication status in the root README and in the package status lines, which still described the suite as unpublished.
- Release metadata: `package.json` versions now match the published `0.1.1` tarballs.

### Notes

- **No runtime source changes** between `0.1.0` and `0.1.1`; this is a documentation, status, and version-metadata release.
- npm published `0.1.0` at 2026-11-14 17:47 (+08) and `0.1.1` at 17:51 (+08). GitHub release: [`v0.1.1`](https://github.com/PerryLink/dsh-os-suite/releases/tag/v0.1.1).
- **Known documentation debt:** some package README examples and limitations prose still reference `0.1.0` (for example `dsh-os-eval`'s header and `dsh-os-quota`'s sample tarball path). These are documentation-only, do not affect the `0.1.1` tarballs, and are left for a follow-up package-docs pass.

### Packages

All six packages at `0.1.1`: `dsh-os-trace`, `dsh-os-lease`, `dsh-os-quota`, `dsh-os-eval`, `dsh-os-catalog`, `dsh-os-registry`.

## [0.1.0] - 2026-11-14

### Added

- First public release: six composable governance-layer plugins for DeepSeek Harness:
  - [`dsh-os-trace`](packages/dsh-os-trace/) — causal audit and tamper-evident evidence bundles. Tools: `trace_query`, `trace_why`, `trace_export`, `trace_verify`.
  - [`dsh-os-lease`](packages/dsh-os-lease/) — workspace lease intents and multi-file transaction plans. Tools: `workspace_lease`, `workspace_apply`, `workspace_rollback`, `workspace_status`.
  - [`dsh-os-quota`](packages/dsh-os-quota/) — advisory token, job, and disk budgets with admission decisions. Tools: `quota_status`, `quota_set`, `quota_admit`, `quota_consume`.
  - [`dsh-os-eval`](packages/dsh-os-eval/) — regression eval gates with cases, baselines, and CI verdicts. Tools: `eval_run`, `eval_gate`, `eval_report`.
  - [`dsh-os-catalog`](packages/dsh-os-catalog/) — intent-based capability catalog for tools, plugins, and MCP servers. Tools: `capability_search`, `capability_preflight`, `capability_register`.
  - [`dsh-os-registry`](packages/dsh-os-registry/) — local service and port registry for dev servers. Tools: `service_register`, `service_list`, `service_stop`.
- 21 tools registered through `defineTool`, each with explicit `parameters` and `output` schemas.
- Pure `src/core.js` per package with no `@deepseek-ai/*` imports; 90 offline tests (`npm test`).
- Apache-2.0 LICENSE full text in every package, `cordis.patch.yml` bundle patches, and `engines.dsh` (`>=0.2.2-rc.3 <0.3.0`) plus `engines.node` (`^22.19.0 || >=24.9.0`) declarations.
- `DESIGN.md` per package covering the data model, integration points, failure modes, and roadmap.

### Fixed

Pre-release audit findings, fixed before the `0.1.0` publish:

- replaced the MIT text that had shipped as `dsh-os-lease`'s LICENSE with the Apache-2.0 full text, and added `LICENSE` to every package's `files` list;
- corrected overclaiming descriptions for `dsh-os-eval`, `dsh-os-lease`, and `dsh-os-quota`;
- made `quota_status` read-only for unknown scopes (no ledger creation), with a regression test.

### Notes

- Published to npm on 2026-11-14 at 17:47 (+08). The first publish briefly showed npm's `0.0.0-stage` placeholder before `0.1.0` became visible; that was normal staged processing, not a failed publish.
- All six tarballs installed into an isolated `DSH_HOME` with `dsh plugin --profile web add`; `--dump-config` listed all six entries.
