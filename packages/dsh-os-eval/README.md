# dsh-os-eval

> Regression eval gates for DSH agents: case definitions, baseline comparison and CI verdicts.

**0.1.0 MVP · pure ESM + JSDoc · Node 24+ · Apache-2.0**

A community project. Not affiliated with DeepSeek. No SLA, no warranty.

## Why this exists

The DSH ecosystem is young and moves fast, and almost none of the public
plugins ships a regression evaluation gate. Agents and prompts change, the chat
"looks fine", and nothing fails CI. Token cost drifts upward silently and a
renamed tool can break an instruction without anyone noticing.

`dsh-os-eval` is the smallest useful missing layer:

- **Cases are data.** A case has an id, input, expectations, and tags. No test
  framework required.
- **Runs are replayable.** A runner is injected. In the MVP it is a mock; a host
  can plug in a recorded-trajectory adapter without changing the gate.
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

Without preloaded cases, pass an inline `case` to `eval_run`. Without an
injected host runner, pass a `mock` result; there is no implicit model call.

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
| `mock` | object | Mock runner result: `{ output?, steps?, tokens?, latencyMs? }`. Ignored when the host injected a runner. |
| `baseline` | object | Optional `{ passRate, p50Tokens }` to store and compare with this run. |

Returns `{ run, comparison }`. `run` is
`{ caseId, output, steps, tokens, latencyMs, status, reasons }`.

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
raw runner output, only status, metrics, and failure reasons.

Optional `tags` uses the same AND filter as `eval_gate`.

## Scoring

Every check in `expect` must hold; a single failure makes the run `FAIL`.

| Field | Check |
|---|---|
| `contains: string[]` | The string output contains every phrase, case-sensitively. |
| `equals: any` | Output deep-equals this value (works for structured output). |
| `maxSteps: number` | `steps <= maxSteps`. |
| `maxTokens: number` | `tokens <= maxTokens`. |

A runner exception is recorded as a `FAIL` run with the error message, rather
than crashing the gate.

## Permissions and data

- **No model, network, filesystem, or shell access.** The core is pure logic;
  the plugin only registers tools.
- **No raw trajectories are stored.** The store keeps the latest run per case:
  caseId, output, steps, tokens, latency, status, reasons. It does not keep
  prompts, messages, tool-call transcripts, or history.
- **Reports contain summaries only.** `eval_report` omits `output`.
- **Memory only.** Data lives for the lifetime of the plugin instance and is
  gone after a restart. Baselines are loaded from config, not from a database.
- **Injected runners run with host permissions.** If a host supplies
  `apply(ctx, { runner })`, that code can do anything the host can do. Audit it
  like any other plugin, and never put secrets in cases or mocks.

## Limitations (MVP)

- **No real session/runner adapter.** The standalone runner is a mock. A host
  can inject a synchronous `runner`, but this package does not read DSH
  sessions, replay live model calls, or attach to session-query/OTel yet. See
  [DESIGN.md](DESIGN.md) for the planned adapters.
- **Synchronous runners only.** Returning a Promise raises
  `ASYNC_RUNNER_UNSUPPORTED`.
- **One latest run per case.** No repeated runs, flake detection, confidence
  intervals, or percentiles beyond a configured baseline.
- **Gate scope is evidence-based.** If at least one selected case has run,
  unrun selected cases are reported as `NOT_RUN` but are not counted in the
  failure ratio. Gate all cases only after running all of them.
- **Baseline pass rate is informational.** `compareToBaseline` reports
  `passRateDelta`, but the 0.1 gate only warns on token regression.
- **No persistence, parallelism, dashboard, or UI.**
- **Trusted fixtures.** Cases are not a sandbox; do not feed untrusted prompts
  or secrets into a shared suite.

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
