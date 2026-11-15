# dsh-os-eval

> Regression eval gates for DSH agents: case definitions, baseline comparison and CI verdicts.

**0.2.1 · pure ESM + JSDoc · Node 24+ · Apache-2.0**

A community project. Not affiliated with DeepSeek. No SLA, no warranty.

## Why this exists

The DSH ecosystem is young and moves fast, and almost none of the public
plugins ships a regression evaluation gate. Agents and prompts change, the chat
"looks fine", and nothing fails CI. Token cost drifts upward silently and a
renamed tool can break an instruction without anyone noticing.

`dsh-os-eval` is the smallest useful missing layer:

- **Cases are data.** A case has an id, input, expectations, and tags. No test
  framework required.
- **Runs are replayable.** A session can be read live through DSH
  `session-query` (`ctx.sessionQuery.readSession(sessionId)`) or from one
  exported JSONL file, paired into a tool trajectory, and graded
  deterministically. A host runner and a mock remain available when neither
  source is supplied.
- **Baselines are explicit.** Compare token usage with a stored p50 and turn a
  >20% regression into a WARN instead of a surprise bill.
- **CI gets one verdict.** `PASS`, `WARN`, or `FAIL`, with reasons and the
  affected case ids.

It is a gate, not a benchmark platform, tracing system, or dashboard.

## Install

Not on npm yet (see [Naming check](#naming-check-2026-11-14)). From this
repository:

```sh
cd 04-build/dsh-os-suite
npm install
node --test packages/dsh-os-eval/test/*.test.js
```

Load it into DSH through **Plugins → Add plugin** and select
`packages/dsh-os-eval`, or install the directory with the `plugin_manager`
`install_bundle` action. The package ships a `cordis.patch.yml` that inserts the
`dsh-os-eval` row; no build step is involved.

Once published, the normal install path will be:

```sh
npm install dsh-os-eval
```

The package requires a DSH version matching `>=0.2.2-rc.3 <0.3.0` and
`@deepseek-ai/dsh-tools` `0.2.2-rc.3`.

### Configure a suite

The bundle row can preload cases and baselines. To add config to the row the
bundle inserted, use a loader patch that targets its id:

```yaml
- id: dsh-os-eval
  config:
    cases:
      - id: greeting
        name: Greets the user
        input: "Say hello to the world"
        expect:
          contains: ["hello", "world"]
          maxSteps: 3
          maxTokens: 200
        tags: [smoke]
    baselines:
      - caseId: greeting
        passRate: 1
        p50Tokens: 120
```

Without preloaded cases, pass an inline `case` to `eval_run`.

To grade a recording, export one session as **plain-text JSONL** (the Web UI's
**Export session** action or the host's `/api/session.export` route) and pass
its path as `sessionFile`:

```json
{
  "caseId": "recorded-greeting",
  "sessionFile": "/tmp/dsh-evals/recorded-greeting.jsonl"
}
```

To grade a live or persisted session without exporting it, pass its id as
`liveSessionId`. The adapter calls `ctx.sessionQuery.readSession(sessionId)` and
grades the returned `SessionLogSnapshot` exactly like an exported recording:

```json
{
  "caseId": "live-greeting",
  "liveSessionId": "01KSESSIONID"
}
```

`sessionFile` and `liveSessionId` are mutually exclusive. Either source wins over
an injected host runner and over `mock`; the fallback chain is
**liveSessionId | sessionFile → host runner → mock**. There is no implicit model
call in any branch. If the host has no `sessionQuery` service, `liveSessionId`
fails with a clear `SESSION_QUERY_UNAVAILABLE` error instead of falling through
to the runner or the mock; `sessionFile` and the runner/mock paths keep working.

Without a session source or an injected runner, pass a `mock` result.

## Tools

All three tools are local. They do not call a model, open a network connection,
or write files.

### `eval_run`

Runs one case through the injected runner, grades it, and records the latest
run.

| Parameter | Type | Meaning |
|---|---|---|
| `caseId` | string (required) | Id of a configured case, or of the inline `case`. |
| `case` | object | Optional inline `{ id, name, input, expect, tags? }`. Duplicate ids are rejected. |
| `sessionFile` | string | Path to one exported, uncompressed session `.jsonl` file. Mutually exclusive with `liveSessionId`; highest precedence when supplied. |
| `liveSessionId` | string | Id of a live or persisted session read through `ctx.sessionQuery.readSession`. Mutually exclusive with `sessionFile`; highest precedence when supplied. |
| `mock` | object | Mock runner result: `{ output?, steps?, tokens?, latencyMs? }`. Used only when neither a session source nor a host runner is present. |
| `baseline` | object | Optional `{ passRate, p50Tokens }` to store and compare with this run. |

Returns `{ run, comparison, trajectory, source }`. `run` is
`{ caseId, output, steps, tokens, latencyMs, status, reasons }`, and `source` is
`"live"`, `"file"`, or `null` (runner/mock). `trajectory` is `null` for a
mock/host run; for a live or file session it is a compact summary
(`sessionId`, `turns`, `messages`, `steps`, `tokens`, `latencyMs`, `paired`,
`toolErrors`, `tools`) with no tool arguments or raw results.

For a session-backed run, `output` is the final non-empty assistant message,
`steps` is the number of paired tool calls, and `tokens` is the summed
assistant-message usage. A runner exception or a missing expectation is still
recorded as a `FAIL` run.

The standalone mock echoes `input` as text and reports 0 steps/tokens unless the
mock overrides them. It exists to test the gate, not to evaluate a model.

### `eval_gate`

Evaluates the latest run of the selected cases. It never executes a case.

| Parameter | Default | Meaning |
|---|---|---|
| `maxFailRatio` | `0` | Allowed fraction of failed runs, in `[0, 1]`. |
| `maxTokenRegression` | `0.2` | Allowed fractional token increase over the baseline p50. |
| `tags` | all | Only cases carrying **every** listed tag are evaluated. |

Returns:

```json
{
  "verdict": "WARN",
  "reasons": ["token regression in 1 case(s)", "case \"costly\" token regression 30.0% exceeds 20.0%"],
  "failed": [],
  "warned": ["costly"],
  "failRatio": 0,
  "evaluated": 1
}
```

Verdict rules:

- **FAIL** if `failed / evaluated > maxFailRatio`, or if no selected case has a
  run (a gate must not pass without evidence).
- **WARN** if any case's token usage is more than `maxTokenRegression` above its
  baseline p50.
- **PASS** otherwise. Failures tolerated by `maxFailRatio` still appear in
  `failed` and in `reasons`, but do not change the verdict by themselves.

### `eval_report`

Returns aggregate counts (`total`, `runCount`, `passed`, `failed`, `notRun`,
`passRate`, `tokens`, `steps`) plus one summary row per case. It never includes
raw runner output, only status, metrics, failure reasons, `source`, and — when
the case was last run from a session — a `trajectory` summary.

`source` is reported at three levels:

- `source` on each case row: `"live"`, `"file"`, or `null`.
- top-level `source`: `"live"`, `"file"`, `"mixed"`, or `null` when no selected
  case has a recorded session.
- top-level `sources`: `{ "live": n, "file": n }` counts over the selected rows.

The top-level `trajectory` object aggregates the selected recorded cases:

```json
{
  "sessions": 1,
  "turns": 2,
  "messages": 2,
  "steps": 1,
  "tokens": 27,
  "latencyMs": 7,
  "toolErrors": 0,
  "tools": { "read": 1 }
}
```

Per-case `trajectory` is `null` for a mock/host run, and a later non-session run
clears the stale summary and source. Optional `tags` uses the same AND filter as
`eval_gate`.

## Recorded-session API

The same read-only replay logic is available outside the tools through the
`dsh-os-eval/session` subpath:

```js
import {
  evaluate,
  parseSessionJsonl,
  readSessionFile,
  replay,
  trajectoryOf,
} from 'dsh-os-eval/session'

const session = readSessionFile('/tmp/dsh-evals/recorded-greeting.jsonl')
const trajectory = trajectoryOf(session)     // paired { tool, args, result } steps

const replayed = replay(session, {
  runner: ({ tool, args, result }) => ({ tool, ok: result !== null }),
})
// replayed.results === one runner return value per tool step

const grades = evaluate(session, [{
  id: 'recorded-greeting',
  name: 'Recorded greeting',
  expect: { contains: ['hello'], maxSteps: 3, maxTokens: 200 },
}])
// grades.cases === one { caseId, status, reasons, ... } row per case
```

`parseSessionJsonl(text)` accepts `type` or `kind` tags, nested `data` or flat
payloads, the `tool/call` / `tool/result` / `assistant/message` / `turn/*` and
`step/*` events, and ignores malformed lines and unknown event types/fields.
`trajectoryOf` pairs calls and results by `callId`, including results that
arrive before their call; unanswered calls remain with `hasResult: false`.

## Live-session API

The `dsh-os-eval/live` subpath exposes the exact-read adapter directly. It reads
one session through the optional `ctx.sessionQuery` service; it does **not**
subscribe to the live event stream.

```js
import {
  attach,
  evaluateLive,
  readLiveSession,
  snapshotToJsonl,
} from 'dsh-os-eval/live'

const capability = attach(ctx)
if (!capability.available) {
  // capability.reason names the missing service
}

const session = await readLiveSession(ctx, '01KSESSIONID')
const grades = await evaluateLive(ctx, '01KSESSIONID', [{
  id: 'live-greeting',
  name: 'Live greeting',
  expect: { contains: ['hello'], maxSteps: 3, maxTokens: 200 },
}])
// grades.source === 'live'
// grades.trajectory === compact summary (same shape as evaluate())
// grades.toolTrajectory === trajectoryOf(session) steps for the caller
```

`readLiveSession` calls `ctx.sessionQuery.readSession(sessionId)` once, requires
the returned `SessionLogSnapshot` to carry a session header and an events array,
and converts it to the JSONL text accepted by `parseSessionJsonl` through
`snapshotToJsonl(snapshot)`. `evaluateLive` composes the same `trajectoryOf` and
`evaluate` building blocks as the file adapter. `attach(ctx)` only probes
`ctx.sessionQuery.readSession` for availability; it registers no listener and
caches nothing.

Errors use stable `EvalError` codes: `INVALID_SESSION_ID`,
`SESSION_QUERY_UNAVAILABLE`, `SESSION_QUERY_READ_FAILED` (or the service's own
stable `SESSION_QUERY_*` code), and `INVALID_SESSION_SNAPSHOT`.

## Scoring

Every check in `expect` must hold; a single failure makes the run `FAIL`.

| Field | Check |
|---|---|
| `contains: string[]` | The string output contains every phrase, case-sensitively. |
| `equals: any` | Output deep-equals this value (works for structured output). |
| `maxSteps: number` | `steps <= maxSteps`. |
| `maxTokens: number` | `tokens <= maxTokens`. |

For a session-backed run (live or file), `output` is the final non-empty
assistant text (reasoning and tool-call blocks excluded), `steps` counts paired
tool calls, and `tokens` sums `totalTokens` when present, otherwise input +
output + cache-read + cache-write tokens. Tool arguments and result texts are
available to `replay` callbacks but are not graded by `expect`.

A runner exception is recorded as a `FAIL` run with the error message, rather
than crashing the gate.

## Permissions and data

- **No model, network, or shell access.** The core is pure logic. One sync
  filesystem read happens only when a caller explicitly supplies `sessionFile`;
  a `liveSessionId` read delegates one exact-read call to the host's
  `ctx.sessionQuery` service.
- **Visible-tool-run data.** The store keeps the latest run per case: caseId,
  output, steps, tokens, latency, status, reasons, `source`, plus a compact
  trajectory summary (session id, counts, tool names, error count). It does not
  keep prompts, user/system messages, complete tool transcripts, or history.
- **Reports contain summaries only.** `eval_report` omits `output`, tool
  arguments, and raw tool results. The programmatic `replay`, `evaluate`, and
  `evaluateLive` APIs return step details to their caller; nothing is persisted
  by this package.
- **Memory only.** Data lives for the lifetime of the plugin instance and is
  gone after a restart. Baselines are loaded from config, not from a database.
- **Explicit file or explicit session id.** `sessionFile` reads exactly the one
  path given by the caller; `liveSessionId` reads exactly the one session id
  given by the caller. There is no session-root discovery, directory listing, or
  subagent archive traversal. Treat exported logs and session data as trusted
  fixtures.
- **Injected runners run with host permissions.** If a host supplies
  `apply(ctx, { runner })`, that code can do anything the host can do. Audit it
  like any other plugin, and never put secrets in cases, mocks, or recordings.

## Limitations (0.2.1)

- **Reads files or exact session snapshots, not streams.** Exported plain-text
  JSONL (`sessionFile`) and `ctx.sessionQuery.readSession(sessionId)`
  (`liveSessionId`) are supported. There is no live event-stream subscription,
  no OTel exporter, and no direct session-database read. Zstandard-compressed
  logs (`.jsonl.zstd`), session directories, and exported ZIP archives are not
  supported; use the host's Export session action and pass the resulting
  uncompressed `.jsonl` file.
- **Recorded output replay, not live model replay.** `replay` invokes only the
  local synchronous callback it is given. The package never calls a model,
  re-runs a prompt, or compares against a fresh live run. A `liveSessionId` read
  grades the session's already-recorded events, not a new generation.
- **No session-query subscription.** `attach(ctx)` probes availability only; the
  plugin does not observe session events as they arrive. Re-run `eval_run` after
  a session grows to grade a newer snapshot.
- **Synchronous runners only.** Returning a Promise raises
  `ASYNC_RUNNER_UNSUPPORTED`.
- **One latest run per case.** No repeated runs, flake detection, confidence
  intervals, or percentiles beyond a configured baseline.
- **Gate scope is evidence-based.** If at least one selected case has run,
  unrun selected cases are reported as `NOT_RUN` but are not counted in the
  failure ratio. Gate all cases only after running all of them.
- **Baseline pass rate is informational.** `compareToBaseline` reports
  `passRateDelta`, but the current gate only warns on token regression.
- **No persistence, parallelism, dashboard, or UI.**
- **Trusted fixtures.** Cases and recordings are not a sandbox; do not feed
  untrusted prompts or secrets into a shared suite.

## Naming check (2026-11-14)

Both package and repository names were checked before implementation:

| Check | Command | Result |
|---|---|---|
| npm | `npm view dsh-os-eval version` | `npm error code E404` — unclaimed |
| GitHub | `curl -s 'https://api.github.com/search/repositories?q=dsh-os-eval+in:name'` | `"total_count": 0` |

Re-run both checks immediately before publishing. Names can be claimed at any
time.

## Development

```sh
node --test packages/dsh-os-eval/test/*.test.js
node --check packages/dsh-os-eval/src/*.js
```

No build step. `src/core.js` has no `@deepseek-ai/*` imports, so the tests are
offline and deterministic.

## License

Apache-2.0. See [the Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

This is an independent community project, **not** an official DeepSeek product.
DeepSeek and DSH are trademarks of their respective owners. No SLA and no
warranty; use at your own risk.
