# dsh-os-quota

**Advisory token, job and disk budgets with admission decisions, opt-in pre-execute enforcement, and a context-pressure gate for DSH agents.**

> Community project. **Not affiliated with, endorsed by, or maintained by DeepSeek.** Provided as-is, with no SLA. Licensed under Apache-2.0.

`dsh-os-quota` adds the missing "resource governor" primitive to a DeepSeek Harness (DSH) deployment: one small ledger per scope (session, agent, team, sandbox — your choice of id), three budgets, and a policy answer to *"may this work start?"* — not just a meter that tells you later what it cost.

- Status: **0.2.4 MVP, published to npm** (name verified free on 2026-11-14).
- Runtime: pure ESM JavaScript, Node 24+, no build step, no `@deepseek-ai/*` imports in `src/core.js`, `src/enforce.js`, `src/meter.js` or `src/pressure.js`.
- Tests: `node --test` (73 tests, offline, injectable clock, fake event bus, fake token-meter/jobs services).

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
6. **Opt-in automatic session metering** — with `autoMeter: true`, provider-reported token usage from `assistant/message` / `assistant/attempt` session events is booked automatically, deduped by `sessionId + turn + step + type`.
7. **Opt-in context-pressure gate** — with `pressureLimit`, `ctx.tokenMeter.contextPressure(session).pressureTokens` is checked before a tool call; over the threshold the call is denied. `killJobs: true` additionally asks `ctx.jobs` to stop the session's running jobs. The gate never interrupts an LLM request.

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
dsh plugin --profile quota add ./dsh-os-quota-0.2.4.tgz
```

Once published, the same flow is:

```sh
dsh plugin --profile quota add dsh-os-quota
```

`package.json` declares `dsh.bundle.patch` and `engines.dsh` (`>=0.2.2-rc.3 <0.3.0`); check the range before installing into a different DSH release. The bundle patch inserts one plugin row (`dsh-os-quota`).

## Tools

All seven tools return JSON (pretty-printed). `null` in serialized output means **unlimited** (JSON has no `Infinity`).

| Tool | Parameters | Behavior |
|---|---|---|
| `quota_status` | `scope?` | Read one scope's limits, usage, remaining budget, utilization, level and window. Omit `scope` to list every known scope. Read-only. |
| `quota_set` | `scope`, `tokens?`, `jobs?`, `diskMb?` | Merge limits into a scope (creates it if new). Omitted dimensions stay unchanged; `null` means unlimited. Lowering a limit below current usage immediately reports `hard`. |
| `quota_admit` | `scope`, `tokens?`, `jobs?`, `diskMb?` | Project a spend **without booking it**. Returns `allowed`, `reason`, `level`, `degrade` and remaining budget. `hard` means deny; `soft` is allowed but marked degraded. |
| `quota_consume` | `scope`, `tokens?`, `jobs?`, `diskMb?` | Book actual usage. Always accumulates; over a hard limit returns `allowed: false` and the overage in `overBy`. |
| `quota_enforce_status` | `scope?` | Report whether the opt-in pre-execute gate is attached, the adapter policy/counters, the last decision, and current scope ledgers. Read-only and never gated. |
| `quota_meter_status` | `scope?` | Report whether automatic session metering is attached, the `assistant/message` / `assistant/attempt` event counters, dedupe identity, last booking or skip, and current scope ledgers. Read-only and never gated. |
| `quota_pressure_status` | `scope?` | Report whether the context-pressure gate is configured/attached, the threshold, token-meter/jobs service availability, observed pressure, denial/kill counters, killed job ids, and current scope ledgers. Read-only and never gated. |

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

The plugin creates one governor per `apply(ctx)`. Optional Cordis config: `limits` (defaults for new scopes), `softRatio`, `windowMs`, `scopes` (seed scopes), `now` (a clock function, useful in tests/embedding), `enforce` (see below), `autoMeter` with its optional `scopeOf` resolver (see below), and `pressureLimit` with `killJobs` (see below).

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
5. **If `pressureLimit` is configured**, run the token-meter pressure check from the next section *after* the governor allows. A pressure denial wins over the downstream chain even when `enforce` is false: the pressure gate attaches on its own.

**After a tool result** the adapter listens on `tools/result` (canonical Cordis event), `tool/result` (compatibility spelling), and `session/event` for durable `tool/result` records. If the result carries `usage.tokens` — at the top level, under `meta.usage`, or under `value.usage` — it calls `governor.consume` for the pending scope. A result without that field is skipped, never estimated. Alias events for the same `callId` are booked once.

`attach(ctx)` uses `ctx.on('tools/pre-execute', handler)` and the result listeners above; if a host has no event bus but exposes `ctx.tools.preExecute(handler)`, that registration seam is used instead. `detach()` removes every listener (idempotent, and safe even if a host returned no disposer). `quota_enforce_status` reports `enabled`, `attached`, `hooks`, `counters`, `last` and the current ledgers.

**What this does not do:** the enforcement adapter does not gate LLM requests, job starts or disk writes, and only books result usage that a tool explicitly reports. Automatic model-token accounting is the separate opt-in `autoMeter` subscription described below; live context pressure is the separate opt-in `pressureLimit` gate. Even with every feature on, this is not a sandbox or an authorization boundary.

## Automatic session metering (opt-in)

`autoMeter: true` attaches [`src/meter.js`](./src/meter.js). It subscribes to the durable `session/event` feed and books provider-reported token usage into the scope ledger — no token-meter service, log file or prompt content is read.

```js
apply(ctx, {
  autoMeter: true,
  // Optional: map a session to another ledger. Return a non-empty string.
  scopeOf: (session) => `session:${session.id}`,
  limits: { tokens: 200000 },
})
```

Only two event types are considered:

| Event | Usage source |
|---|---|
| `assistant/message` | `event.data.usage`; the committed message's top-level usage is authoritative |
| `assistant/attempt` | top-level `usage` when the host provides it, else the last `usage` chunk of the compact provider stream |

For each usable sample:

1. **Charge** — `tokens = usage.totalTokens ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`. `TokenUsage` buckets are disjoint (cached input is **not** inside `inputTokens`), so the fallback sum is the full call.
2. **Scope** — `scopeOf(session)` when configured and it returns a non-empty string, else `session.id`. The default is one ledger per session.
3. **Dedupe** — at most one booking per `sessionId + turn + step + type`, so a re-published event or host replay cannot double-charge.
4. **Skip** — an event missing usage, a usable token count, its scope, or its turn/step is counted as skipped and never estimated. Bookings are accounting-only: `governor.consume` accumulates even past a hard limit.

`quota_meter_status` reports `enabled`, `attached`, `eventTypes`, `dedupeKey`, `scopeSource`, `counters` (`events`, `assistantEvents`, `consumed`, `duplicates`, `skipped`, `errors`, `tokens`), `sessions`, `last` and the current ledgers. [`attachTokenMeter(ctx, { governor, scopeOf, now })`](./src/meter.js) is exported for embedding; it returns `{ detach, stats }`, where `stats` is a live read-only object (counters update in place).

This is still **accounting, not control**: it reads committed usage events, not token-meter's live context pressure, and it never interrupts or denies a model request. `autoMeter` is off by default. Jobs and disk usage remain caller-reported.

## Context-pressure gate (opt-in)

`pressureLimit` attaches [`src/pressure.js`](./src/pressure.js). It is a second pre-execute policy, not a token budget: after the governor allows a call (when `enforce` is on), it reads `ctx.tokenMeter.contextPressure(session).pressureTokens` and denies when the value is strictly above the limit. The gate attaches even when `enforce` is false.

```js
apply(ctx, {
  pressureLimit: 120000, // tokens; null/omitted disables the gate
  killJobs: true,        // optional: stop this session's running jobs on denial
})
```

Decision contract:

- `pressureTokens <= pressureLimit` → allowed; the limit is inclusive.
- no `pressureTokens` yet → allowed; the provider has not reported usage.
- above the limit → `{ kind: 'deny', allow: false, reason: 'pressure' }`; `next()` is not called.
- missing/throwing `tokenMeter`, or a missing session → `{ allow: true, reason: 'unavailable' }`; the check fails open and is counted instead of throwing.

The session comes from DSH's `ToolExecution.agent.session` (falling back to `call.session`). `quota_*` tools are never gated.

With `killJobs: true`, an over-limit check calls `ctx.jobs.list(session.id)` and invokes `ctx.jobs.kill(id, session.id, 'quota')` for every returned job whose status is exactly `running`. Completed, failed, killed and stopping records are never touched; duplicate kill requests for the same id are suppressed; list/kill failures are contained and the pressure denial still stands.

`quota_pressure_status` reports `enabled`, `configured`, `attached`, `available` (the token-meter service), `jobService`, `maxPressure`, `killJobs`, `pressureTokens` (last observed), `counters` (`checks`, `allowed`, `denied`, `unavailable`, `errors`, `killLists`, `killRequests`, `killed`, `killSkipped`, `killErrors`), `last`, `lastError`, `killedJobs` and the current ledgers. The guard is exported for embedding: `createPressureGuard({ ctx, governor, maxPressure, killJobs })` returns `{ check, status, ... }`.

This is a **snapshot gate on tool calls**: `pressureTokens` is the latest provider-reported prompt size (absent until usage is recorded), and denying a tool call cannot cancel the LLM request that produced it, trigger compaction, or stop a job when `killJobs` is false. The pressure limit is independent of the governor's token budget — set both if you want both admission policies.

## Permissions and data

- **Reads** tool-call names, optional cost hints and reported result `usage`; tool arguments only for a `scope` id. With `autoMeter: true`, it also reads provider-reported `usage` counters from committed `assistant/message` / `assistant/attempt` session events — never prompt content. With `pressureLimit`, it reads `ctx.tokenMeter.contextPressure(session)` (a token count, not prompt content) and, with `killJobs: true`, the session's visible job roster from `ctx.jobs.list`.
- **Writes** only an in-process, in-memory ledger, plus — only when `pressureLimit` is over the threshold and `killJobs: true` — job-kill requests through `ctx.jobs.kill`. No files, no database, no network, no child processes, no session transcript access, no prompt content.
- **Does not block by default.** With `enforce: false` and no `pressureLimit` (the defaults), `quota_admit` is advisory and an agent can ignore it. `enforce: true` denies hard tool calls only if the host runs `tools/pre-execute`; `pressureLimit` denies over-threshold tool calls and `killJobs` asks the jobs registry to stop the session's running jobs. Neither aborts an LLM request nor prevents a disk write. This is not a security boundary.
- **Automatic metering is opt-in and accounting-only**: with `autoMeter: true` it books token usage after a model step settles; it does not subscribe to token-meter pressure and cannot interrupt a request. With `autoMeter: false`, nothing consumes LLM tokens. Jobs and disk are only what a caller reports through `quota_consume`.
- **Data lifetime**: process lifetime. Restart, profile reload, or a crash drops every ledger. No PII is collected; avoid secrets in scope ids because they may appear in tool output/logs.
- **Scope ids are unauthenticated strings**. Any client that can call these tools can touch any scope ledger. Do not treat scope isolation as an authorization mechanism.

## Limitations (MVP)

1. **In-memory ledger only** — no persistence, no restart recovery, no cross-process or multi-host coordination. Two DSH processes keep two independent ledgers.
2. **Partial `token-meter` / `jobs` integration only** — with `pressureLimit`, the plugin reads token-meter's latest `pressureTokens` snapshot and can optionally ask `ctx.jobs` to kill running jobs. It does not gate `ctx.jobs.start`, job starts are not metered, disk growth is not observed, and job/disk usage remains caller-reported. It never subscribes to model-request events to interrupt or compact a request.
3. **Enforcement depends on the host and on estimates** — the gates only run if the host dispatches `tools/pre-execute` (stock DSH does). They cover tool calls, not model requests or job starts, and the governor gate only evaluates tools whose cost is non-zero or whose scope is already over budget. Missing or wrong `costOf` values mean under-admission. This is not a sandbox or an authorization boundary.
4. **No budget preemption** — one scope cannot evict another scope's jobs to reclaim budget, and the pressure gate cannot enforce a token reservation. `killJobs` is a blunt, opt-in pressure response: it requests a kill for every running job visible to the session, with no priority ordering and no wait for settlement. Degradation is only a flag today.
5. **Global soft ratio** — one `softRatio` for all scopes in a governor; no per-scope ratios or weighted dimensions.
6. **No history or metrics** — `list()` snapshots current scopes only; no time series, no exports, no alerts.
7. **Unbounded scope cardinality** — every new scope id creates a ledger entry for the process lifetime; high-cardinality ids can grow memory.
8. **0.2.x, API may change** — no compatibility promise and no SLA.

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
node --check packages/dsh-os-quota/src/meter.js
node --check packages/dsh-os-quota/src/pressure.js
node --check packages/dsh-os-quota/src/index.js
node --test packages/dsh-os-quota/test/*.test.js
```

`src/core.js` has no `@deepseek-ai/*` imports and no I/O, so the core tests need no network, no DSH profile, and no real clock. `src/enforce.js`, `src/meter.js` and `src/pressure.js` are equally dependency-free and are unit-tested against a fake event bus and fake token-meter/jobs services (including the waterfall's `next()` contract, synthetic `session/event` records, and pressure kill calls). `src/index.js` imports `defineTool` from `@deepseek-ai/dsh-tools` and only adapts the core, enforcement adapter, token meter and pressure guard for Cordis.

## License

Apache-2.0 (declared in `package.json`). This is a community project and is not an official DeepSeek product.
