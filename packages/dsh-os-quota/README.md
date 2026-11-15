# dsh-os-quota

**Advisory token, job and disk budgets with admission decisions and opt-in pre-execute enforcement for DSH agents.**

> Community project. **Not affiliated with, endorsed by, or maintained by DeepSeek.** Provided as-is, with no SLA. Licensed under Apache-2.0.

`dsh-os-quota` adds the missing "resource governor" primitive to a DeepSeek Harness (DSH) deployment: one small ledger per scope (session, agent, team, sandbox — your choice of id), three budgets, and a policy answer to *"may this work start?"* — not just a meter that tells you later what it cost.

- Status: **0.2.0 MVP, published to npm** (name verified free on 2026-11-14).
- Runtime: pure ESM JavaScript, Node 24+, no build step, no `@deepseek-ai/*` imports in `src/core.js` or `src/enforce.js`.
- Tests: `node --test` (44 tests, offline, injectable clock, fake event bus).

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
5. **Opt-in enforcement** — with `enforce: true`, a `tools/pre-execute` waterfall gate denies hard tool calls, marks soft calls as degraded, and books reported result usage. It is off by default and depends on the host dispatching that hook.

Admission remains advisory by default: without `enforce`, nothing intercepts a real call. Even with enforcement enabled, this is a **budget gate for tool calls**, not a sandbox or an authorization boundary. It cannot stop an LLM request, a job start or a disk write by itself; it can only deny a tool call that the host routes through `tools/pre-execute`.

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
dsh plugin --profile quota add ./dsh-os-quota-0.2.0.tgz
```

Once published, the same flow is:

```sh
dsh plugin --profile quota add dsh-os-quota
```

`package.json` declares `dsh.bundle.patch` and `engines.dsh` (`>=0.2.2-rc.3 <0.3.0`); check the range before installing into a different DSH release. The bundle patch inserts one plugin row (`dsh-os-quota`).

## Tools

All five tools return JSON (pretty-printed). `null` in serialized output means **unlimited** (JSON has no `Infinity`).

| Tool | Parameters | Behavior |
|---|---|---|
| `quota_status` | `scope?` | Read one scope's limits, usage, remaining budget, utilization, level and window. Omit `scope` to list every known scope. Read-only. |
| `quota_set` | `scope`, `tokens?`, `jobs?`, `diskMb?` | Merge limits into a scope (creates it if new). Omitted dimensions stay unchanged; `null` means unlimited. Lowering a limit below current usage immediately reports `hard`. |
| `quota_admit` | `scope`, `tokens?`, `jobs?`, `diskMb?` | Project a spend **without booking it**. Returns `allowed`, `reason`, `level`, `degrade` and remaining budget. `hard` means deny; `soft` is allowed but marked degraded. |
| `quota_consume` | `scope`, `tokens?`, `jobs?`, `diskMb?` | Book actual usage. Always accumulates; over a hard limit returns `allowed: false` and the overage in `overBy`. |
| `quota_enforce_status` | `scope?` | Report whether the opt-in pre-execute gate is attached, the adapter policy/counters, the last decision, and current scope ledgers. Read-only and never gated. |

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

The plugin creates one governor per `apply(ctx)`. Optional Cordis config: `limits` (defaults for new scopes), `softRatio`, `windowMs`, `scopes` (seed scopes), `now` (a clock function, useful in tests/embedding), and `enforce` (see below).

## Enforcement (opt-in)

`enforce: true` attaches the adapter in [`src/enforce.js`](./src/enforce.js); an object form configures it inline:

```js
apply(ctx, {
  enforce: {
    enabled: true,
    scope: 'session:abc',
    costOf: {
      shell: { tokens: 500 },
      web_fetch: { tokens: 2000, jobs: 1 },
      write: { diskMb: 8 },
    },
    onDeny: (decision, call) => ctx.logger.warn(`denied ${call.name}: ${decision.reason}`),
  },
})
```

Top-level equivalents: `scope`, `costOf`, `costs` (a convenience name→cost map), `onDeny`, `throwOnDeny`, `enforceIgnore`. `quota_*` tools are always exempt from the gate.

**Before a tool call** (`tools/pre-execute` waterfall; `next()` is the rest of the chain):

1. Resolve the cost estimate — `costOf(name, call)` (or a name→cost map, `'*'` wildcard supported), then `call.cost`/`call.estimate`, then direct numeric `tokens`/`jobs`/`diskMb` fields. A number means tokens; omitted dimensions are 0.
2. Resolve the scope — an explicit configured scope wins, then `call.scope`, then `call.arguments.scope`, else `"default"`. Scope ids are not authenticated, so do not expose scope selection to untrusted model input.
3. Call `governor.admit({ scope, ...cost })`:
   - **hard** → return `{ kind: 'deny', allow: false, reason }` and **do not call `next()`**. DSH renders `reason` as the model-facing failure. With `throwOnDeny: true` the adapter throws `QuotaDeniedError` instead (returning is the preferred waterfall convention).
   - **soft** → call `next()` and return its decision with `degrade: true` and `allow: true`.
   - **ok** → call `next()` and return its decision unchanged.
4. Estimator/admission failures **fail open** (the call proceeds) and are counted in `quota_enforce_status`; only a real `hard` decision fails closed.

**After a tool result** the adapter listens on `tools/result` (canonical Cordis event), `tool/result` (compatibility spelling), and `session/event` for durable `tool/result` records. If the result carries `usage.tokens` — at the top level, under `meta.usage`, or under `value.usage` — it calls `governor.consume` for the pending scope. A result without that field is skipped, never estimated. Alias events for the same `callId` are booked once.

`attach(ctx)` uses `ctx.on('tools/pre-execute', handler)` and the result listeners above; if a host has no event bus but exposes `ctx.tools.preExecute(handler)`, that registration seam is used instead. `detach()` removes every listener (idempotent, and safe even if a host returned no disposer). `quota_enforce_status` reports `enabled`, `attached`, `hooks`, `counters`, `last` and the current ledgers.

**What this does not do:** it is not a `token-meter` or `jobs` adapter and does not meter LLM requests, job starts or disk writes automatically. It only gates tool calls that the host actually routes through `tools/pre-execute`, and only books usage that a tool explicitly reports. The built-in `quota_*` tools help an operator inspect and book usage, but they are not a measurement source.

## Permissions and data

- **Reads** tool-call names, optional cost hints and reported result `usage`; tool arguments only for a `scope` id.
- **Writes** only an in-process, in-memory ledger. No files, no database, no network, no child processes, no session transcript access, no prompt content.
- **Does not block by default.** With `enforce: false` (default), `quota_admit` is advisory and an agent can ignore it. With `enforce: true`, a hard decision denies the tool call only if the host runs `tools/pre-execute`; it still does not abort an LLM request, kill a job or prevent a disk write. This is not a security boundary.
- **No automatic metering**: nothing consumes LLM tokens, job starts or disk usage. The result listener books only an explicit `usage.tokens` field in a tool result; otherwise usage is only what a caller reports through `quota_consume`. Token-meter remains the measurement source of truth.
- **Data lifetime**: process lifetime. Restart, profile reload, or a crash drops every ledger. No PII is collected; avoid secrets in scope ids because they may appear in tool output/logs.
- **Scope ids are unauthenticated strings**. Any client that can call these tools can touch any scope ledger. Do not treat scope isolation as an authorization mechanism.

## Limitations (MVP)

1. **In-memory ledger only** — no persistence, no restart recovery, no cross-process or multi-host coordination. Two DSH processes keep two independent ledgers.
2. **Still not wired to `token-meter` or `jobs`** — there is no subscription to token-meter, the jobs registry or the filesystem. LLM token usage, job starts and disk growth are not metered automatically. Consumption happens only when a tool result explicitly carries `usage.tokens` or a caller invokes `quota_consume`; jobs/disk remain caller-reported.
3. **Enforcement depends on the host and on estimates** — the gate only runs if the host dispatches `tools/pre-execute` (stock DSH does). It covers tool calls, not model requests or job starts, and only for tools whose cost is non-zero or whose scope is already over budget. Missing or wrong `costOf` values mean under-admission. It is not a sandbox or an authorization boundary.
4. **No preemption** — one scope cannot evict another scope's jobs to reclaim budget. Degradation is only a flag today.
5. **Global soft ratio** — one `softRatio` for all scopes in a governor; no per-scope ratios or weighted dimensions.
6. **No history or metrics** — `list()` snapshots current scopes only; no time series, no exports, no alerts.
7. **Unbounded scope cardinality** — every new scope id creates a ledger entry for the process lifetime; high-cardinality ids can grow memory.
8. **0.1.x, API may change** — no compatibility promise and no SLA.

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
node --check packages/dsh-os-quota/src/enforce.js
node --check packages/dsh-os-quota/src/index.js
node --test packages/dsh-os-quota/test/*.test.js
```

`src/core.js` has no `@deepseek-ai/*` imports and no I/O, so the core tests need no network, no DSH profile, and no real clock. `src/enforce.js` is equally dependency-free and is unit-tested against a fake event bus (including the waterfall's `next()` contract). `src/index.js` imports `defineTool` from `@deepseek-ai/dsh-tools` and only adapts the core and the enforcement adapter for Cordis.

## License

Apache-2.0 (declared in `package.json`). This is a community project and is not an official DeepSeek product.
