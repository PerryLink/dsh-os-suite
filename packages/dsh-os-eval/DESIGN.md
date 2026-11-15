# dsh-os-eval — design

Status: 0.1.2 (2026-11-15). Pure ESM, no build. Core logic is offline-testable
and imports no `@deepseek-ai/*` package. The read-only exported-JSONL adapter
lives in `src/session.js`; it adds I/O only for the one file a caller names.

## 1. Problem

DSH agents change through prompts, tools, model routes, and context assembly.
Today the feedback loop is mostly manual: run the agent, read the transcript, and
decide that it "looks fine". That misses three classes of regressions:

1. **Behaviour** — a phrase, tool, or structured field disappears from output.
2. **Cost** — token usage grows while output still looks acceptable.
3. **Budget discipline** — step or token counts exceed the intended envelope.

A regression gate turns that into a repeatable `PASS` / `WARN` / `FAIL` signal
that a CI job can consume.

## 2. Goals and non-goals

### Goals

- Cases as plain data with explicit expectations.
- A runner seam: the same gate works with a mock, a recorded trajectory, or a
  future live replay adapter.
- Baseline comparison with a token-regression warning.
- Tag-filtered suites for smoke/nightly/CI subsets.
- Deterministic core, no network, no filesystem, no model calls.
- One small, explainable verdict for CI.

### Non-goals (0.x)

- Hosted eval service, leaderboard, or benchmark dataset.
- Collecting production traces.
- UI/dashboard.
- Statistical significance, flake detection, or automatic baseline refresh.
- Calling a model from core.

## 3. Architecture

```
 config / inline case ─┐
                       ▼
                 ┌───────────┐    runner(case)     ┌───────────┐
                 │ EvalStore │ ──────────────────▶ │  Runner   │
                 │  cases    │                     │ mock now  │
                 │  runs     │ ◀────────────────── │ replay    │
                 │ baselines │    { output, steps,  │ later     │
                 └─────┬─────┘      tokens, ... }  └───────────┘
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
        ┌─────────┐        ┌──────────┐
        │ Scorer  │        │ Baseline │
        │ expect  │        │ p50 cost │
        └────┬────┘        └────┬─────┘
             └───────┬──────────┘
                     ▼
                ┌─────────┐
                │  Gate   │  PASS / WARN / FAIL
                └─────────┘
```

`src/core.js` owns the store, scorer, baseline math, and gate. `src/index.js` is
an adapter that registers `eval_run`, `eval_gate`, and `eval_report` and forwards
arguments to core. Tool execution is where the host can inject a runner; core
itself never imports a model or a session service.

## 4. Data model

### Case

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique in the store; duplicates are a hard error. |
| `name` | string | Human-readable label for reports. |
| `input` | any | Fixture handed to the runner: prompt, transcript, scenario id, etc. |
| `expect.contains` | string[] | All phrases must occur in a string output. |
| `expect.equals` | any | Deep equality against any JSON value. |
| `expect.maxSteps` | number | Inclusive upper bound. |
| `expect.maxTokens` | number | Inclusive upper bound. |
| `tags` | string[] | Optional labels; tag filters use **AND** semantics. |

Expectations are stored frozen inside the store. The runner receives a detached
copy, so it cannot rename a case or add expectations mid-run.

### Run

| Field | Type | Notes |
|---|---|---|
| `caseId` | string | Which case produced this run. |
| `output` | any | Runner output; usually a string. |
| `steps` | number | Agent/tool steps. Supplied by the runner. |
| `tokens` | number | Token usage. Supplied by the runner. |
| `latencyMs` | number | Supplied by the runner; defaults to 0. |
| `status` | `PASS` \| `FAIL` | Case-level grade from expectations. |
| `reasons` | string[] | Diagnostic extension; empty on PASS. |

Only the latest run per case is kept. Runs are summaries: the store never keeps
prompts, messages, tool-call transcripts, or a step-by-step trace. The injected
runner owns the raw trajectory; if it needs persistence, that is its policy.

### Baseline

| Field | Type | Notes |
|---|---|---|
| `caseId` | string | Baseline is keyed by case. |
| `passRate` | number | Historical pass rate in `[0, 1]`; reported, not gated in 0.1. |
| `p50Tokens` | number | Historical median token usage; the gate's cost reference. |

### Invariants

- Case ids are unique; `defineCase` throws `DUPLICATE_CASE_ID` on collision.
- Unknown ids throw `UNKNOWN_CASE`.
- Baselines may be stored before the first run; comparison fields stay `null`
  until a run exists.
- A runner exception becomes a `FAIL` run (with reason), not a thrown gate.
- The store is in-memory; process restart clears runs and baselines.

## 5. Cases and trajectories

A **case** describes what to replay and what to accept. A **trajectory** is the
run's observed path: output, step count, token count, and latency.

In 0.1, `runner(case)` is the entire replay seam:

```js
const run = store.runCase('greeting', (evalCase) => ({
  output: replay(evalCase.input),
  steps: 2,
  tokens: 84,
  latencyMs: 1200,
}))
```

The default plugin mock echoes `case.input` and reports zero cost. It is a gate
fixture, not an evaluator. The 0.1.2 adapter translates one exported session
into the same run shape; the scorer and gate do not change.

`src/session.js` parses plain-text DSH session JSONL, pairs `tool/call` with
`tool/result` on the call id, and exposes `parseSessionJsonl`, `trajectoryOf`,
`replay`, and `evaluate`. `eval_run` accepts one explicit `sessionFile` path;
`eval_report` adds a compact trajectory summary. There is no live-session,
session-query, OTel, or compressed-log read.

Trajectory storage is deliberately outside core. This keeps the package free of
session schemas and makes the data policy simple: summaries in, summaries out.
Raw messages, tool arguments, and tool results are returned to a programmatic
`replay` caller but never stored or reported by the plugin.

## 6. Scorers

The scorer is rule-based and synchronous:

| Expectation | Pass condition | Failure reason |
|---|---|---|
| `contains` | every phrase is a substring of a string output | `output does not contain "<phrase>"` |
| `equals` | deep strict equality | `output does not equal <expected>` |
| `maxSteps` | `steps <= maxSteps` | steps exceed bound |
| `maxTokens` | `tokens <= maxTokens` | tokens exceed bound |

All expectations are checked; reasons accumulate. An empty `expect` passes. A
non-string output with `contains` fails rather than being stringified, which
avoids accidental object-to-JSON matches.

Scorers intentionally do not include an LLM-as-judge in 0.1: it would make the
gate non-deterministic, cost tokens, and require a model call from a module that
must stay pure. That is a separate adapter with its own budget and audit story.

## 7. Gate

Inputs: latest runs, stored baselines, tag filter, `maxFailRatio` (default 0),
`maxTokenRegression` (default 0.2).

```
selected  = cases carrying every filter tag
evaluated = selected cases with a latest run
failed    = evaluated cases whose run.status == FAIL
warned    = evaluated cases with baseline and (tokens - p50) / p50 > threshold
failRatio = |failed| / |evaluated|
```

Verdict ladder:

1. If `selected` is empty → **FAIL** (`no cases matched`).
2. If `evaluated` is zero → **FAIL** (`no eval runs available`). A gate must not
   pass without evidence.
3. If `failRatio > maxFailRatio` → **FAIL**.
4. If any token regression exceeds `maxTokenRegression` → **WARN**.
5. Otherwise → **PASS**. Tolerated failures remain in `failed` and in the
   reasons; with the default `maxFailRatio = 0`, any failure is a FAIL.

Failures dominate warnings. Comparisons use a small epsilon so an exact 20.0%
token increase is not reported as a regression because of floating-point noise.

Edge cases:

- A baseline with `p50Tokens = 0` treats any positive usage as 100% regression
  (conservative).
- Negative regression (cost improvement) is reported by `compareToBaseline` but
  never warns.
- Cases without runs are `NOT_RUN` in reports. If at least one selected case ran,
  the unrun cases are excluded from the ratio. This is documented as an MVP
  limitation; a future strict mode will require full suite coverage.

## 8. Integration points

### Exported session JSONL (implemented in 0.1.2)

`src/session.js` is the adapter:

1. Read one caller-supplied, uncompressed `.jsonl` export.
2. Parse `turn/*`, `step/*`, `tool/call`, `tool/result`, and
   `assistant/message`; ignore malformed lines and unknown events/fields.
3. Pair tool calls and results by call id; derive final assistant text, paired
   step count, summed token usage, and event-span latency.
4. Feed the resulting `Run` to the existing scorer/gate; expose per-step replay
   through a synchronous callback.

The module imports `core.js` and `node:fs` only. `core.js` remains free of
session schemas and I/O. Read failures surface as adapter errors before a run is
recorded, not as a fake PASS.

### session-query (not implemented)

Live session-query reads are out of scope for 0.1.2. The current boundary is one
exported file; there is no query-by-id/tag, no session-root discovery, and no
session service injection.

### OTel (not implemented)

DSH and host runtimes can export GenAI spans (model call, tool call, token usage,
duration), but this package does not consume them. If an OTel adapter is added
later, the planned mapping is:

### OTel

DSH and host runtimes can export GenAI spans (model call, tool call, token usage,
duration). The planned mapping:

| Run field | OTel source |
|---|---|
| `steps` | count of agent/tool spans for the run |
| `tokens` | sum of `gen_ai.usage.input_tokens` + `gen_ai.usage.output_tokens` |
| `latencyMs` | span duration |
| `output` | post-processing result, not the raw span attribute |

The adapter should normalize token accounting across routes before comparing to
`p50Tokens`; a tokenizer/route change is a baseline-version event, not a silent
regression. `dsh-os-trace` can later attach the gate verdict to an evidence
bundle for audit.

### CI

0.1.2 has no CLI. A CI job imports the core or drives the tools and maps:

| Verdict | Proposed exit code | Meaning |
|---|---|---|
| `PASS` | 0 | Ship. |
| `WARN` | 0 (annotation) | Ship with a warning; token regression is visible. |
| `FAIL` | 1 | Block the merge. |

A future CLI will emit JUnit XML and a compact JSON artifact so the same verdict
can be posted as a PR check without parsing prose.

## 9. Failure modes

| Failure | Observable effect | Mitigation |
|---|---|---|
| Brittle `contains` | PASS becomes FAIL after harmless wording changes | Prefer `equals` for structured data; review fixtures; tag flaky cases separately. |
| Nondeterministic output | Same case flips between PASS/FAIL | 0.1.2 runs once; add repeated runs and flake rate in 0.2. |
| Token accounting drift | WARN without a real behaviour regression | Normalize tokenizer/route; version baselines; re-baseline deliberately. |
| Stale baseline | Gate passes while cost keeps rising | CI refresh job and baseline age in a future release. |
| Missing run | Silent gap in a partial suite | `eval_report` shows `NOT_RUN`; all-unrun gate is FAIL; strict full-coverage mode planned. |
| Duplicate case id | Suites overwrite each other | Hard error at `defineCase`. |
| Runner throws | The whole gate would crash | Converted to a FAIL run with the error message. |
| Async runner | Core returns before results exist | Explicit `ASYNC_RUNNER_UNSUPPORTED`; use a synchronous adapter. |
| Mock drift | Gate is green while the real agent regresses | Mock is labelled as a fixture; host runner injection is the production path. |
| Secret leakage | A case or output appears in logs | Reports omit output; injected runners own persistence; do not put secrets in fixtures. |
| Unbounded memory | Long-lived process grows | Only the latest run per case is retained; store dies with the process. |

## 10. Security and privacy

- Core has no I/O; the session adapter reads only the one `sessionFile` path a caller names.
- No raw messages, prompts, tool arguments, or tool results are persisted by this package; reports carry counts, tool names, and error counts only.
- `eval_report` returns status, metrics, reasons, and compact trajectory summaries; `eval_run` returns the run object including output to its caller.
- Cases are trusted configuration. They are not a sandbox; an injected runner
  runs with host permissions.
- Baselines contain only pass rate and p50 tokens.

## 11. 30-day roadmap

| Window | Work | Exit criterion |
|---|---|---|
| Days 1–7 (2026-11-15 → 11-21) | Harden 0.1: fixture JSON loader, config validation, test coverage, pack dry-run, docs review. | `npm pack` succeeds; core tests green offline. |
| Days 8–14 (11-22 → 11-28) | Exported-JSONL replay landed in 0.1.2; remaining: live `session-query` read, baseline JSON format, redaction rules. | More than one exported session can produce a `Run` without touching core. |
| Days 15–21 (11-29 → 12-05) | CLI (`run`/`gate`/`report`), exit codes, JUnit XML, repeated-run support (k, p50); OTel span adapter spike. | A local CI script blocks on FAIL and annotates WARN. |
| Days 22–30 (12-06 → 12-14) | GitHub Actions example, strict coverage mode, baseline freshness policy, security review, naming recheck, 0.2.0. | A real repository runs the gate in CI; release notes list adapters and limits. |

Deferred beyond 30 days: hosted results service, dashboard, LLM judge, automatic
baseline tuning, cross-repository leaderboards.

## 12. Open questions

- Should token regression compare against `p50` or a trimmed mean, and per model
  route?
- Is WARN allowed to fail CI by policy, or always advisory?
- How long should a baseline remain valid before it must be refreshed?
- Should strict coverage be the default for tagged suites in 0.2?
- What is the canonical normalized step count across native and PTC tool
  execution?
