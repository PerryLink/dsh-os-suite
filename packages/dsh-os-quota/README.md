# dsh-os-quota

**Advisory token, job and disk budgets with admission decisions for DSH agents.**

> Community project. **Not affiliated with, endorsed by, or maintained by DeepSeek.** Provided as-is, with no SLA. Licensed under Apache-2.0.

`dsh-os-quota` adds the missing "resource governor" primitive to a DeepSeek Harness (DSH) deployment: one small ledger per scope (session, agent, team, sandbox — your choice of id), three budgets, and a policy answer to *"may this work start?"* — not just a meter that tells you later what it cost.

- Status: **0.1.2 MVP, published to npm** (name verified free on 2026-11-14).
- Runtime: pure ESM JavaScript, Node 24+, no build step, no `@deepseek-ai/*` imports in `src/core.js`.
- Tests: `node --test` (21 tests, offline, injectable clock).

## Why

DSH already ships `@deepseek-ai/dsh-token-meter`, but it is a **measurement** service: it replays the durable session log and reports token/context pressure so compaction and occupancy displays can agree on numbers. Its README is explicit that it "makes no loop decisions" — it observes and prices, it does not gate admission. Background jobs and disk usage similarly have no budget primitive in the base composition.

That leaves a gap an agent OS should close:

- an agent can keep looping, spawn background jobs, or fill a workspace disk **before** anyone reads a meter;
- there is no common place to declare "this session may spend 200k tokens, start 4 jobs, use 512 MB";
- there is no standard way to degrade gracefully instead of hitting a wall (or silently overrunning).

`dsh-os-quota` fills it with a deliberately small contract:

1. **Ledger** — `used` for tokens/jobs/diskMb per scope, plus limits and a window start.
2. **Admission** — `admit()` projects a spend without booking it: `ok`, `soft` (allowed, degraded) or `hard` (denied).
3. **Accounting** — `consume()` books actual usage; overage is recorded and surfaced (`overBy`) instead of being hidden or clamped away.
4. **Isolation** — each scope is an independent ledger; one runaway agent cannot consume another agent's budget.

The MVP is **accounting and policy only**. It does not intercept LLM calls or the jobs registry, and it does not by itself stop a process. Callers (or a future integration layer) decide whether to honor `allowed`.

## Install

The package is not on npm yet, so `npm view dsh-os-quota version` currently returns **404**. Use a checkout/tarball today:

```sh
# from the suite root: 04-build/dsh-os-suite
npm install
node --test packages/dsh-os-quota/test/*.test.js

# install the bundle into a DSH profile (link a checkout)
dsh plugin --profile quota add ./packages/dsh-os-quota
```

Or pack it first:

```sh
cd packages/dsh-os-quota
npm pack
dsh plugin --profile quota add ./dsh-os-quota-0.1.0.tgz
```

Once published, the same flow is:

```sh
dsh plugin --profile quota add dsh-os-quota
```

`package.json` declares `dsh.bundle.patch` and `engines.dsh` (`>=0.2.2-rc.3 <0.3.0`); check the range before installing into a different DSH release. The bundle patch inserts one plugin row (`dsh-os-quota`).

## Tools

All four tools return JSON (pretty-printed). `null` in serialized output means **unlimited** (JSON has no `Infinity`).

| Tool | Parameters | Behavior |
|---|---|---|
| `quota_status` | `scope?` | Read one scope's limits, usage, remaining budget, utilization, level and window. Omit `scope` to list every known scope. Read-only. |
| `quota_set` | `scope`, `tokens?`, `jobs?`, `diskMb?` | Merge limits into a scope (creates it if new). Omitted dimensions stay unchanged; `null` means unlimited. Lowering a limit below current usage immediately reports `hard`. |
| `quota_admit` | `scope`, `tokens?`, `jobs?`, `diskMb?` | Project a spend **without booking it**. Returns `allowed`, `reason`, `level`, `degrade` and remaining budget. `hard` means deny; `soft` is allowed but marked degraded. |
| `quota_consume` | `scope`, `tokens?`, `jobs?`, `diskMb?` | Book actual usage. Always accumulates; over a hard limit returns `allowed: false` and the overage in `overBy`. |

Example (abridged):

```json
{
  "scope": "session:abc",
  "allowed": true,
  "level": "soft",
  "reason": "soft-limit",
  "degrade": true,
  "used": { "tokens": 0, "jobs": 0, "diskMb": 0 },
  "projected": { "tokens": 90000, "jobs": 1, "diskMb": 0 },
  "remaining": { "tokens": 10000, "jobs": 3, "diskMb": 512 },
  "overBy": { "tokens": 0, "jobs": 0, "diskMb": 0 },
  "limits": { "tokens": 100000, "jobs": 4, "diskMb": 512 },
  "softRatio": 0.8
}
```

Semantics:

- Limits are **inclusive**: spending exactly up to the limit is allowed (`overBy` stays 0).
- All three dimensions are **cumulative charges in a window**; 0.1.0 has no release/decrement. Charge jobs as one unit per start (or job-seconds if the caller aggregates), and disk as a high-water delta. `resetWindow` (core API) clears all three.
- `soft` triggers when projected/actual usage is **strictly above** `softRatio × limit` (default `softRatio = 0.8`).
- `hard` triggers when usage is **strictly above** the limit. `admit` denies; `consume` still books reality.
- Negative, `NaN` and infinite *amounts* book 0. Usage never decreases through `consume`.
- `resetWindow` is available on the core API and zeroes usage; the tool surface intentionally does not expose a "clear the evidence" operation in the MVP.

The plugin creates one governor per `apply(ctx)`. Optional Cordis config: `limits` (defaults for new scopes), `softRatio`, `windowMs`, `scopes` (seed scopes), and `now` (a clock function, useful in tests/embedding).

## Permissions and data

- **Reads** only tool arguments (`scope` ids and numeric amounts).
- **Writes** only an in-process, in-memory ledger. No files, no database, no network, no child processes, no session transcript access, no prompt content.
- **Does not block** real LLM calls, job starts or disk writes. `quota_admit` is advisory in this MVP; an agent can ignore it. This is not a security boundary.
- **No automatic metering**: nothing consumes usage unless something calls `quota_consume`. Numbers are only as good as the caller's accounting.
- **Data lifetime**: process lifetime. Restart, profile reload, or a crash drops every ledger. No PII is collected; avoid secrets in scope ids because they may appear in tool output/logs.
- **Scope ids are unauthenticated strings**. Any client that can call these tools can touch any scope ledger. Do not treat scope isolation as an authorization mechanism.

## Limitations (MVP)

1. **In-memory ledger only** — no persistence, no restart recovery, no cross-process or multi-host coordination. Two DSH processes keep two independent ledgers.
2. **Not wired to `token-meter` or `jobs`** — there is no event subscription or automatic consumption. Token-meter remains the measurement source of truth; this ledger is only what callers report. Jobs/disk are caller-reported too.
3. **Advisory, not enforcing** — `allowed: false` does not abort an LLM request or kill a job. Enforcement needs an integration layer (see [DESIGN.md](./DESIGN.md)).
4. **No preemption** — one scope cannot evict another scope's jobs to reclaim budget. Degradation is only a flag today.
5. **Global soft ratio** — one `softRatio` for all scopes in a governor; no per-scope ratios or weighted dimensions.
6. **No history or metrics** — `list()` snapshots current scopes only; no time series, no exports, no alerts.
7. **Unbounded scope cardinality** — every new scope id creates a ledger entry for the process lifetime; high-cardinality ids can grow memory.
8. **0.1.0, unpublished, API may change** — no compatibility promise and no SLA.

## Naming verification (2026-11-14)

Confirmed free before publishing this MVP:

```text
$ npm view dsh-os-quota version
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/dsh-os-quota - Not found

$ curl 'https://api.github.com/search/repositories?q=dsh-os-quota+in:name'
{ "total_count": 0, ... }
```

Re-run both checks immediately before any `npm publish`; names can be claimed at any time.

## Development

```sh
cd 04-build/dsh-os-suite
npm install
node --check packages/dsh-os-quota/src/core.js
node --check packages/dsh-os-quota/src/index.js
node --test packages/dsh-os-quota/test/*.test.js
```

`src/core.js` has no `@deepseek-ai/*` imports and no I/O, so the core tests need no network, no DSH profile, and no real clock. `src/index.js` imports `defineTool` from `@deepseek-ai/dsh-tools` and only adapts the core for Cordis.

## License

Apache-2.0 (declared in `package.json`). This is a community project and is not an official DeepSeek product.
