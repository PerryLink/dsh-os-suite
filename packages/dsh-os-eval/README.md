# dsh-os-eval

> Regression eval gates for DSH agents: case definitions, baseline comparison and CI verdicts.

**0.2.3 · pure ESM + JSDoc · Node 24+ · Apache-2.0**

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
  source is supplied. An explicit watcher can also follow one session's live
  `session/event` feed and pair steps as they arrive.
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

The package requires a DSH version matching `>=0.2.3-rc.3 <0.3.0` and
`@deepseek-ai/dsh-tools` `0.2.3-rc.3`.

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

To follow a session while it is still growing, attach an explicit in-memory
watcher with `eval_watch` (see [below](#eval_watch)). It subscribes to one
session id only when you ask it to; it is never started automatically.

Without a session source or an injected runner, pass a `mock` result.

## Tools

All four tools are local. They do not call a model, open a network connection,
or write files. `eval_watch` can subscribe to the host's `session/event` feed,
but only after an explicit attach, and it keeps observed events in memory only.

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

### `eval_watch`

Attaches, inspects, or detaches an explicit live watcher for one session id.
Attaching subscribes to `ctx.on('session/event', (session, event) => ...)`,
ignores events from every other session, and appends the matching events in
memory. Pairing is by tool call id, using the same parser as recorded files.
Unknown event types and fields are retained by the watcher and skipped by the
trajectory, so newer session events do not break it.

| Parameter | Type | Meaning |
|---|---|---|
| `action` | string (required) | `attach`, `status`, or `detach`. |
| `sessionId` | string | Target session id. Required for `attach`; optional for `status` and `detach` (omit to cover every watcher). |

Examples:

```json
{ "action": "attach", "sessionId": "01KSESSIONID" }
{ "action": "status", "sessionId": "01KSESSIONID" }
{ "action": "detach" }
```

Every action returns `{ action, watchers }`, where each watcher row is
`{ sessionId, attached, events, steps, paired, toolErrors, tools }`. Raw events,
tool arguments, and tool results are never returned by the tool.

Lifecycle rules:

- **Explicit only.** Activation registers the tool but creates no watcher and
  subscribes to nothing. `attach` is the only action that registers a listener.
- **One listener per session id.** Attaching an already-attached id is
  idempotent; it does not duplicate the subscription.
- **Detach stops receipt, not history.** `detach` removes the listener (or all
  listeners when `sessionId` is omitted) and returns the final counts; already
  observed events remain in memory for `snapshot()` and `trajectory()` until the
  plugin instance is gone. Re-attaching continues the same in-memory history.
- **No persistence.** Watchers are not stored, not restored after a restart, and
  are detached when the plugin is disposed. Nothing is written to disk. A
  long-lived watcher grows by one retained event per append; detach it when the
  session is finished.
- **Other sessions are ignored** by session id, and malformed or unknown events
  do not throw.

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

## Live watcher API

The `dsh-os-eval/watch` subpath exposes the explicit subscription handle used by
`eval_watch`:

```js
import { createWatcher } from 'dsh-os-eval/watch'

const watcher = createWatcher({ ctx, sessionId: '01KSESSIONID' })
watcher.attach()       // subscribes to ctx.on('session/event') for this id

watcher.snapshot()     // raw events observed so far (shallow copy)
watcher.trajectory()   // paired tool steps, same shape as trajectoryOf(session)

watcher.detach()       // stops future events; history stays readable
```

`createWatcher({ ctx, sessionId })` returns exactly
`{ attach, detach, snapshot, trajectory }`. `attach()` registers one
`session/event` listener and ignores events whose `session.id` is not the
configured id; calling it again while attached is a no-op. `detach()` removes
the listener and is idempotent. `snapshot()` returns the retained events in
append order; `trajectory()` serializes them to the same JSONL shape as a
recorded file and reuses `trajectoryOf`, so calls and results pair by call id,
results that arrive before their call still pair, and unknown events are
skipped. Raw events are never persisted.

Errors use stable `EvalError` codes: `INVALID_SESSION_ID`,
`SESSION_EVENTS_UNAVAILABLE` when `ctx.on('session/event')` is missing, and
`SESSION_EVENTS_SUBSCRIBE_FAILED` when the host subscription throws.

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
  `ctx.sessionQuery` service; a watcher subscribes to the host's in-process
  `session/event` feed only after an explicit `eval_watch` attach. No outbound
  network request is made in any path.
- **Visible-tool-run data.** The store keeps the latest run per case: caseId,
  output, steps, tokens, latency, status, reasons, `source`, plus a compact
  trajectory summary (session id, counts, tool names, error count). It does not
  keep prompts, user/system messages, complete tool transcripts, or history.
  The live watcher is the one explicit exception: after an attach it retains raw
  `session/event` objects for the watched session in memory. `eval_watch` status
  exposes only counts and tool names, never raw events, arguments, or results.
- **Reports contain summaries only.** `eval_report` omits `output`, tool
  arguments, and raw tool results. The programmatic `replay`, `evaluate`,
  `evaluateLive`, and watcher `snapshot`/`trajectory` APIs return step details to
  their caller; nothing is persisted by this package.
- **Memory only.** Data lives for the lifetime of the plugin instance and is
  gone after a restart. Baselines are loaded from config, not from a database.
  Watchers are not persisted: detach stops the subscription, and a plugin
  restart discards both the subscription and the retained events.
- **Explicit file, explicit session id, explicit watcher.** `sessionFile` reads
  exactly the one path given by the caller; `liveSessionId` reads exactly the one
  session id given by the caller; a watcher observes exactly the one session id
  given to `attach`. There is no session-root discovery, directory listing, or
  subagent archive traversal. Treat exported logs and session data as trusted
  fixtures.
- **Injected runners run with host permissions.** If a host supplies
  `apply(ctx, { runner })`, that code can do anything the host can do. Audit it
  like any other plugin, and never put secrets in cases, mocks, or recordings.

## Limitations (0.2.3)

- **Exact reads by default; live watching is opt-in.** Exported plain-text
  JSONL (`sessionFile`) and `ctx.sessionQuery.readSession(sessionId)`
  (`liveSessionId`) are supported. A watcher can subscribe to one session's
  `session/event` feed after an explicit attach, but it keeps raw events in
  memory only and does not reconcile sequence gaps, resume a detached period, or
  persist history. There is no OTel exporter and no direct session-database
  read. Zstandard-compressed logs (`.jsonl.zstd`), session directories, and
  exported ZIP archives are not supported; use the host's Export session action
  and pass the resulting uncompressed `.jsonl` file.
- **Recorded output replay, not live model replay.** `replay` invokes only the
  local synchronous callback it is given. The package never calls a model,
  re-runs a prompt, or compares against a fresh live run. A `liveSessionId` read
  grades the session's already-recorded events, not a new generation. A watcher
  observes events the host already committed; it does not drive the session.
- **No persistent or automatic watcher.** `attach(ctx)` in the `live` adapter
  still probes availability only, and `eval_run` never consumes a watcher: it
  re-reads a snapshot on each call. A watcher exists only after an explicit
  `eval_watch` attach, keeps events in memory, and stops at detach or plugin
  dispose. There is no automatic resume after a plugin reload.
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
