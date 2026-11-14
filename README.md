# dsh-os-suite

[![CI](https://github.com/PerryLink/dsh-os-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/PerryLink/dsh-os-suite/actions/workflows/ci.yml)


[Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

Six small, composable **governance-layer** plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

> **Community project. Not affiliated with, sponsored by, or endorsed by DeepSeek.**
> Apache-2.0. No SLA, no warranty. Early MVP, published as `0.1.2` on npm (2026-11-14).

DSH already has the organs of an agent OS — sessions, tools, agent loop, sandbox, approvals, jobs, teams, worktrees, MCP. What it lacks is the **nervous system**: who is running, what they consume, why something happened, how to resume after a crash, what can do X, and whether a change made things worse. These six packages target that layer, not another UI skin or file search.

## Packages

| Package | Gap | Tools |
|---|---|---|
| [`dsh-os-trace`](packages/dsh-os-trace/) | Causal audit & tamper-evident evidence bundles | `trace_query`, `trace_why`, `trace_export`, `trace_verify` |
| [`dsh-os-lease`](packages/dsh-os-lease/) | Workspace lease intents & multi-file transaction plans | `workspace_lease`, `workspace_apply`, `workspace_rollback`, `workspace_status` |
| [`dsh-os-quota`](packages/dsh-os-quota/) | Advisory token/job/disk budgets & admission decisions | `quota_status`, `quota_set`, `quota_admit`, `quota_consume` |
| [`dsh-os-eval`](packages/dsh-os-eval/) | Regression eval gates: cases, baselines, CI verdicts | `eval_run`, `eval_gate`, `eval_report` |
| [`dsh-os-catalog`](packages/dsh-os-catalog/) | Intent-based capability catalog for tools/plugins/MCP | `capability_search`, `capability_preflight`, `capability_register` |
| [`dsh-os-registry`](packages/dsh-os-registry/) | Local service & port registry for dev servers | `service_register`, `service_list`, `service_stop` |

## Status (2026-11-14)

- **90/90 tests pass** (`npm test`; six packages).
- **21 tools** register through `defineTool`; all six entries import and `apply()` under a fake Cordis context.
- **Names verified**: `npm view <name>` → E404; GitHub exact-name search → 0 (2026-11-14). See [NAME-CHECK.md](NAME-CHECK.md).
- **Pre-release audit**: [AUDIT.md](AUDIT.md); three findings fixed (Apache-2.0 LICENSE, description accuracy, read-only `quota_status`).
- **Real install verified** in an isolated `DSH_HOME`: all six tarballs install via `dsh plugin --profile web add`, and `--dump-config` lists all six entries.
- **Published**: all six packages at `0.1.2` on npm (2026-11-14).

## Install

```sh
dsh plugin --profile web add dsh-os-trace
dsh plugin --profile web add dsh-os-lease
dsh plugin --profile web add dsh-os-quota
dsh plugin --profile web add dsh-os-eval
dsh plugin --profile web add dsh-os-catalog
dsh plugin --profile web add dsh-os-registry
```

## Quick start

```sh
npm install
npm test

# inspect a package tarball without publishing
cd packages/dsh-os-trace && npm pack --dry-run
```

Each package ships `src/`, `cordis.patch.yml`, `README.md`, `DESIGN.md`, `LICENSE`, and declares `dsh.bundle.patch` + `engines.dsh`.

## Design rules

- Core logic (`src/core.js`) imports **no** `@deepseek-ai/*`; tests run offline.
- The plugin entry only registers tools and calls core.
- Every tool declares explicit `parameters` and `output` schemas.
- Descriptions describe what the MVP actually does; mocks and limits are stated in each README.
- No network or filesystem writes in core; no secrets.

## License

Apache-2.0. See each package's `LICENSE`.
