# dsh-os-quota — design

**Status:** 0.1.0 MVP. Core ledger + admission policy are implemented; automatic integration with `token-meter`, `jobs`, and disk accounting is designed but **not shipped**.

This document describes what the ledger means, how decisions are made, where a future adapter can attach, what can go wrong, and a 30-day plan to move from "accounting library" to "governance layer".

---

## 1. Problem and scope

DSH composes capabilities from services: `ctx.tokenMeter` measures token/context pressure, `ctx.jobs` owns background work, the filesystem/workspace services own disk. None of them answers a single question before work starts:

> Given this scope's history and limits, may it spend N more tokens, start M more jobs, or claim D MB?

`dsh-os-quota` answers that question deterministically, with an injectable clock and no I/O in the core.

### Goals

- A tiny, dependency-free ledger with clear invariants.
- Admission levels that support graceful degradation: `ok` → `soft` → `hard`.
- Isolation by scope (session, agent, workspace, team — the caller names it).
- Honest accounting: actual overage is recorded and visible.
- Tools that let an agent (or an operator) inspect and update budgets.

### Non-goals in 0.1.0

- Enforcing anything outside the process. `allowed: false` is a verdict, not a kill switch.
- Persistence, clustering, or cross-process consistency.
- Automatic token/job/disk ingestion.
- Preemption (evicting jobs to make room).
- Authorization/tenancy: scope ids are unauthenticated strings.

---

## 2. Ledger model

### 2.1 Records

```text
Scope {
  id: string                  // e.g. "session:abc", "agent:lead", "workspace:repo"
  limits: { tokens, jobs, diskMb }
  used:   { tokens, jobs, diskMb }
  windowStartedAt: number     // epoch ms
}
```

`Request { scope, tokens?, jobs?, diskMb? }` is the input to `admit` and `consume`.

The `Governor` owns an isolated `Map<scopeId, Scope>` plus:

- `softRatio` — one policy threshold for all scopes in that governor (default `0.8`);
- `windowMs` — optional automatic window length (default: never auto-roll);
- a clock — `Date.now` by default, or an injected function returning epoch ms / `Date`.

### 2.2 Units and semantics of each dimension

All three dimensions are **cumulative charges inside a window**. The ledger's only write primitive is addition; `resetWindow` zeroes all three. There is no decrement in 0.1.0.

| Dimension | Unit | Recommended charging rule |
|---|---|---|
| `tokens` | Tokens (billed or estimated, caller decides) | Charge provider-reported usage after a model call; use estimates only for admission. |
| `jobs` | Job units for the window | Charge 1 per job start in the MVP. A future version can charge job-seconds at settlement or add reserve/release. This is **not** live concurrency: `used.jobs` never goes down until reset. |
| `diskMb` | MB charged for the window | Charge the high-water delta (or sample periodically) because allocation is not monotonically increasing. Reset the window after the workspace is cleaned up. |

Because jobs and disk are naturally gauges rather than counters, the current ledger approximates them. This is an honest MVP trade-off and a primary roadmap item (reservations/release), not a hidden behavior.

### 2.3 Normalization and invariants

Implementation invariants (enforced in `src/core.js`, covered by tests):

1. `used[dim] >= 0` always. A negative, `NaN`, or infinite request books `0`, never a refund. `consume` cannot decrease usage.
2. `limits[dim] >= 0` or `Infinity` (unlimited). A negative/non-numeric limit collapses to `0`; `null` in config/snapshots means unlimited.
3. Scopes are independent: operations on `scope A` never read or write `scope B`.
4. `admit()` is a projection and does not mutate the ledger. Only `consume()`, `setLimits()`, `resetWindow()` and lazy window rolling mutate.
5. Every read returns a detached copy (`limits`, `used`, `remaining`, arrays). Mutating a snapshot cannot corrupt the ledger.
6. Limits are **inclusive**: `used == limit` is allowed; `used > limit` is over.
7. Only a hard overage denies admission. Soft overage is allowed and flagged.
8. Time is injected and read once per operation, so a single call sees one consistent timestamp.

### 2.4 Windows

- `windowStartedAt` is set when a scope is first created and on every `resetWindow`.
- `resetWindow(scope)` zeroes `used` and sets `windowStartedAt = now`.
- If `windowMs` is configured, every access (`status`, `admit`, `consume`, `setLimits`, `list`) lazily rolls the scope when at least one window has elapsed. `windowStartedAt` advances by whole windows, so repeated rolling does not drift.
- Without `windowMs`, windows are manual: callers reset at session/turn boundaries, or not at all.
- Windows are per-scope and anchored at creation/reset, not aligned to wall-clock days. A future profile-level scheduler may align them (see failure mode F8).

### 2.5 Levels

Given usage vector `U`, limits `L`, and ratio `r`:

```text
hard    ⇔ ∃ d: L[d] finite and U[d] > L[d]
soft    ⇔ no hard overage, and ∃ d: L[d] finite and U[d] > r × L[d]
ok      ⇔ otherwise
```

For admission, `U = used + request` (projected). For consumption, `U = used` after booking. `overBy[d] = max(0, U[d] - L[d])`, `remaining[d] = max(0, L[d] - U[d])` (`Infinity` if unlimited).

---

## 3. Admission, degradation, preemption

### 3.1 Admission pipeline

```text
request ──► normalize amounts (clamp <0/NaN/∞ to 0)
        ──► resolve/create scope ──► lazily roll window if due
        ──► projected = used + amount
        ──► classify(projected, limits, softRatio)
        ──► { allowed, level, reason, degrade, remaining, overBy, … }
```

`admit` is advisory: callers may ignore it. The value is a shared, deterministic protocol so every caller agrees on what "over budget" means.

| Projected utilization | Level | `allowed` | `degrade` | Intended caller behavior |
|---|---|---|---|---|
| ≤ `softRatio` | `ok` | `true` | `false` | Proceed normally. |
| `(softRatio, limit]` | `soft` | `true` | `true` | Proceed, but reduce scope (smaller prompt/model, fewer jobs, compact context, warn). |
| `> limit` | `hard` | `false` | `false` | Do not start; surface the blocked action and, when possible, offer a path (reset, raise limit, wait for window). |

Exactly at a limit is allowed (soft, no remaining headroom). `reason` is a stable machine code: `ok`, `soft-limit`, `hard-limit`.

### 3.2 Degradation policy

`degrade: true` is a suggestion, not an action. Consumers can map it to concrete behavior:

- **LLM** — drop to a cheaper model, reduce max output, compact context earlier, or ask the user.
- **Jobs** — queue work instead of starting it, lower parallelism, or reduce per-job output caps.
- **Disk** — clean caches, switch to streaming, or refuse large artifacts.

The ledger does not choose the mechanism; it only standardizes the signal.

### 3.3 Consumption semantics

`consume` books reality. If usage ends up above the hard limit, the ledger:

- still adds the amount (the tokens/jobs/disk were already used);
- returns `allowed: false`, `level: 'hard'`, and `overBy` per dimension;
- never clamps `used` down or hides the overage.

This ordering matters: **admission is the control point; consumption is the audit point.** Trying to reject consumption would falsify the ledger and make later admission decisions wrong. Callers that need strict enforcement must check `admit` before the spend and refuse to proceed on `hard`.

### 3.4 Preemption (designed, not implemented)

Preemption means making room by stopping work, rather than merely refusing new work. It is deliberately absent from 0.1.0 because safe preemption needs:

- a priority/preemptible classification on jobs,
- an authority that can cancel another agent's job within its ownership boundary,
- asynchronous cancel-and-recheck semantics,
- anti-thrash policy.

A future design that fits the current API:

1. On a hard admission with `preempt: true`, return `preemptCandidates` — jobs in the same scope (or an allowed parent pool) with `preemptible: true`, ordered by lowest priority and most recent start.
2. The caller (job scheduler) requests cancellation and waits for settlement.
3. The governor recomputes `admit`; only if the projection becomes `soft` or `ok` does the new work start.
4. Never preempt critical/interactive work; cap preemptions per scope per window; add a cooldown to avoid livelock.

This is a scheduler capability, not a ledger operation. It will be added as an optional adapter, not silently inside `admit`, because `admit` must stay synchronous and side-effect free.

---

## 4. Integration points

The core has no DSH imports. Integration belongs in adapters (a future `src/adapters/*.js` or a separate package), which call the same five governor methods.

### 4.1 `token-meter`

`@deepseek-ai/dsh-token-meter` is a deterministic, replay-based **measurement** service (`ctx.tokenMeter.measure(session)`, `contextPressure`, `tokenUsage`, `estimateMessage`). Its own docs say it makes no loop decisions. That makes it the natural source of truth for token numbers, while `dsh-os-quota` supplies the decision.

Proposed flow (pseudocode; exact service signatures need verification against the target DSH release):

```js
// Before a model call: estimate and admit.
const scope = `session:${session.id}`
const estimate = ctx.tokenMeter.measure(session).projectedTokens ?? heuristic
const verdict = governor.admit({ scope, tokens: estimate })
if (verdict.level === 'hard') {
  // Caller decides: compact, switch model, queue, or refuse.
  return blocked(verdict)
}
if (verdict.degrade) enableCheapMode()

// After the call: book provider-reported usage, never the estimate.
const billed = readProviderUsage(session) // e.g. tokenUsage projection
governor.consume({ scope, tokens: billed.totalTokens })
```

Key rules:

- **Admission uses estimates; consumption uses billed numbers.** Never charge an estimate after the fact.
- Reconcile retries: a retried attempt may bill twice; count every billed attempt.
- Scope mapping: `session:<id>` is the default; parent/agent aggregation can consume the same amount into a parent scope explicitly (the core has no hierarchy today).
- Turn/session lifecycle events are the natural place to `resetWindow` for per-turn or per-session windows.
- `contextPressure` / `contextWindow` can add a second guard (e.g., refuse when context is near capacity), but that policy belongs to the adapter.

### 4.2 `jobs`

`@deepseek-ai/dsh-jobs` owns job identity, ownership and lifecycle; jobs are owned by the agent session that started them. Proposed integration:

- Before `ctx.jobs.start(...)`: `governor.admit({ scope, jobs: 1 })`. On `hard`, fail the start with a clear error rather than starting work the agent cannot run.
- On settlement: either book 1 job unit (MVP semantics) or, once release exists, book job-seconds and release the reservation.
- On cancellation: still book the actual usage (a cancelled job consumed resources).
- Ownership: the scope should be derived from the owning session, not from arbitrary model input. Do not let one agent charge another agent's scope without authorization.
- Concurrency semantics need a future `reserve`/`release` API; until then, document that `jobs` is a per-window start budget, not a live gauge.

### 4.3 Disk

No first-class disk hook is proposed for 0.1.0. Adapters can:

- sample workspace size before/after large artifacts and `consume` the delta;
- charge a fixed estimate per declared artifact;
- call `resetWindow` after a cleanup and accept the loss of token/job history for that scope (or use separate scopes for disk vs tokens).

A future version may add per-dimension reset/release so disk gauges can be adjusted without clearing token history.

### 4.4 Tool layer

The four tools are intentionally thin: they let an agent or operator set budgets, inspect them, and book usage. A stronger integration can wrap tool execution in middleware:

```text
before side-effecting tool → admit(scope, cost estimate) → deny or downgrade
after tool                 → consume(scope, measured cost)
```

`quota_set` is a **privileged** operation in any real deployment: a model that can raise its own limits has no budget. Production profiles should gate it with user approval, an allowlist, or keep it operator-only (see F10).

### 4.5 Persistence (future)

For restart recovery and multiple processes:

- append-only JSONL or SQLite, one writer per profile, fsync at booking boundaries;
- an idempotency key per booking (session + turn + dimension + amount) to survive retries;
- periodic snapshots + log replay;
- monotonic sequence numbers so a restarted process can detect a divergent tail;
- never let two writers own the same scope without a lease.

---

## 5. Failure modes

| # | Failure | Effect | Mitigation / status |
|---|---|---|---|
| F1 | Process restart or profile reload | Ledger resets to zero; over-admission possible | MVP known limitation; persistence roadmap; start conservative after restart |
| F2 | Caller forgets `consume` | Under-count, false `ok` | Integration adapter must pair admit/consume; future audit warning for admits without bookings |
| F3 | Caller ignores `allowed: false` | Real overrun; ledger reports it after the fact | Enforcement is the adapter's job; tools/docs say advisory; future middleware |
| F4 | Admit-then-consume race between concurrent async tasks | Several tasks can pass admission against the same remaining budget | Core calls are synchronous, but the gap is async; future atomic `reserve`/`release` or per-scope serialization |
| F5 | Retry double booking | Budget exhausted early | Idempotency keys in adapter (future); count every billed attempt deliberately |
| F6 | Estimate vs billed mismatch | Soft decisions are approximate | Admit with conservative estimate + headroom; consume billed usage |
| F7 | Clock jumps backward/forward | Window may not roll, or rolls early; `windowAgeMs` can be negative | Injectable clock for tests; lazy rolls; future monotonic timestamps or sanity clamp |
| F8 | Per-scope window drift | Different scopes reset at different times; aggregate budgets are fuzzy | Documented; future aligned windows at profile/session start |
| F9 | `Infinity`/`null` confusion in JSON | `null` in output means unlimited, but a client may read it as 0 | Documented in README; adapters must map `null → unlimited` |
| F10 | Model calls `quota_set` to raise its own limit | Governance bypass | Treat `quota_set` as privileged; gate with approval/allowlist; not enforced in MVP |
| F11 | Scope id explosion / collisions | Memory growth; accidental shared budgets | Naming convention; cardinality cap and eviction roadmap; ids are not auth |
| F12 | Negative/NaN amounts silently become 0 | Under-count, surprising result | Core invariant protects the ledger; adapters should validate inputs and log normalization |
| F13 | Negative limits become 0 | Scope appears closed unexpectedly | Configuration validation is the caller's job; tests pin the behavior |
| F14 | `jobs` used as concurrency | Budget drains permanently until reset | Documented as cumulative; future reserve/release or job-seconds |
| F15 | Disk charged cumulatively | False `hard` after files are deleted | Charge deltas/high-water; reset window after cleanup; future per-dimension reset |
| F16 | Multi-process deployments | Divergent ledgers; budgets multiplied by process count | Single-process MVP; persistence + lease before any multi-process claim |
| F17 | Floating point accumulation | Tiny drift near thresholds | Counters should be integers where possible; treat threshold comparisons as approximate |
| F18 | `softRatio` too high/low | No early warning, or constant degradation | Default 0.8; configurable per governor; future per-scope policy |

---

## 6. 30-day roadmap

Assumes one engineer, part-time, with a DSH checkout and the suite's `npm test` as the gate.

### Days 1–3 — harden and publish 0.1.x

- Re-run naming checks (`npm view`, GitHub search) immediately before publish.
- Add LICENSE at the repository root and verify `npm pack --dry-run` contents.
- Smoke-install the tarball into a throwaway profile (`dsh plugin --profile quota-test add ...`) and verify tool registration.
- Add CI: `node --test`, `node --check` on `src/*.js`, Node 24 matrix.
- Publish `0.1.0` (or `0.1.0-alpha.1`) after the checks pass.

### Week 1 — token-meter read-only adapter

- Spike an adapter that maps `session:<id>` scopes and reads `ctx.tokenMeter.measure(session)` / provider usage.
- Admit before a model call using a conservative estimate; consume billed usage after.
- Add fake-meter unit tests (no real model calls).
- Measure estimate-vs-billed error on sample sessions; tune headroom guidance.
- Ship behind an opt-in profile config; never change base defaults silently.

### Week 2 — jobs admission + job accounting

- Gate `ctx.jobs.start` behind `admit({ jobs: 1 })`; return a clear denial error.
- Book usage on settlement and on cancellation.
- Introduce a **reservation** primitive (`reserve`/`release` or an atomic admit-and-hold) to close F4 and make concurrency semantics possible.
- Add per-scope policy config: limits, `softRatio`, window mode.
- Gate `quota_set` behind an explicit privileged flag/approval.

### Week 3 — persistence and restart recovery

- Append-only JSONL or SQLite ledger with idempotency keys and a single writer per profile.
- Snapshot + replay; recovery tests (crash between admit and consume, duplicate booking, torn write).
- Add audit records for limit changes and resets (who/when/why); expose read-only history.
- Load test with tens of thousands of scopes; add cardinality cap and eviction policy.

### Week 4 — preemption MVP, docs, 0.2.0

- Priority classes (`critical`, `interactive`, `background`) and `preemptible` job metadata.
- On hard admission with preemption enabled, return candidates; scheduler cancels and re-admits; bounded attempts + cooldown.
- Metrics/logging: admit/deny/soft counts, overage bytes/tokens, preemption outcomes.
- Security review of `quota_set`, scope naming, and cross-agent charging.
- Update README/DESIGN with measured numbers, publish `0.2.0`, and define the compatibility promise.

### Explicitly deferred beyond 30 days

- Multi-process/cluster budgets and distributed leases.
- Hierarchical scopes with automatic parent rollups.
- Weighted multi-resource optimization (e.g., token-per-dollar).
- UI dashboards (a client view can be added later).
- Billing-grade token reconciliation beyond provider-reported usage.

---

## 7. Testing strategy

- **Core** (`test/core.test.js`): pure logic with a fake clock — ok/soft/hard boundaries, exact-limit behavior, consume overage, non-negative invariant, cross-scope isolation, reset, lazy windows, setLimits merge/tighten, snapshot detachment, seeding, invalid config, all three dimensions.
- **Plugin** (`test/index.test.js`): fake `ctx.tools.register`, assert the four tool names/schemas/required fields, shared governor behavior, and JSON serialization (`Infinity → null`).
- **Future adapter tests**: fake token-meter/jobs services; no network, no real model, no real jobs; property tests for "used never decreases" and "admit never mutates".

All current tests run offline with `node --test packages/dsh-os-quota/test/*.test.js`.

---

## 8. Naming and license

- Package name `dsh-os-quota` verified unclaimed on npm (E404) and GitHub (0 exact repository hits) on **2026-11-14**. Re-verify before publish.
- Apache-2.0.
- Community project, not affiliated with DeepSeek; no SLA.
