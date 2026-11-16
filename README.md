# dsh-os-suite

[![CI](https://github.com/PerryLink/dsh-os-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/PerryLink/dsh-os-suite/actions/workflows/ci.yml)


[Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

Six small, composable **governance-layer** plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

> **Community project. Not affiliated with, sponsored by, or endorsed by DeepSeek.**
> Apache-2.0. No SLA, no warranty. Early MVP, published as `0.2.4` on npm (2026-11-15).

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

## Status (2026-11-15)

- **276/276 tests pass** (`npm test`; six packages).
- **Branch protection**: `main` requires a PR, the CI/CodeQL checks, and an up-to-date branch; force pushes and deletion are blocked.
- **Release auth**: `NPM_TOKEN` (transitional); trusted-publishing steps are in [`docs/trusted-publishing.md`](docs/trusted-publishing.md).
- **Host-service integration**: five tests mount the real DSH `0.2.2-rc.3` service packages (Cordis Context, ToolRuntime, NativeToolExecutor, SessionStore, SessionProjectionRegistry, SessionQuery, TokenMeter) and verify quota denial, trace spans, eval live reads, and token-meter pressure; run `npm run test:integration`.
- **Coverage gate**: lines 85% / functions 80% / branches 70% (`npm run test:coverage`).
- **21 tools** register through `defineTool`; all six entries import and `apply()` under a fake Cordis context.
- **Names verified**: `npm view <name>` → E404; GitHub exact-name search → 0 (2026-11-15). See [NAME-CHECK.md](NAME-CHECK.md).
- **Pre-release audit**: [AUDIT.md](AUDIT.md) (historical, 0.1.x); the three findings were fixed in 0.2.x.
- **Real install verified** in an isolated `DSH_HOME`: all six tarballs install via `dsh plugin --profile web add`, and `--dump-config` lists all six entries.
- **Published**: all six packages at `0.2.4` on npm (2026-11-15).

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
