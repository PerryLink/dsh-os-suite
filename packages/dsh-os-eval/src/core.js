/**
 * Pure evaluation-gate logic for dsh-os-eval.
 *
 * Deliberately imports no DeepSeek Harness package: the whole module runs
 * offline under `node --test`. The store keeps only the latest run summary per
 * case in process memory; nothing is written to disk.
 */

import { isDeepStrictEqual } from 'node:util'

/** Default failed-case ratio allowed by {@link createEvalStore}.gate. */
export const DEFAULT_MAX_FAIL_RATIO = 0

/** Default token regression (fraction of baseline p50) tolerated by gate. */
export const DEFAULT_MAX_TOKEN_REGRESSION = 0.2

const EPSILON = 1e-9

/**
 * Error thrown for invalid eval data or API usage. `code` is stable and safe
 * to branch on; `message` is human-readable.
 */
export class EvalError extends Error {
  /**
   * @param {string} code Stable machine-readable error code.
   * @param {string} message Human-readable description.
   */
  constructor(code, message) {
    super(message)
    this.name = 'EvalError'
    this.code = code
  }
}

/**
 * @typedef {object} CaseExpect
 * @property {string[]} [contains] Every phrase must occur in a string output.
 * @property {unknown} [equals] Output must deep-equal this JSON value.
 * @property {number} [maxSteps] Inclusive upper bound on `Run.steps`.
 * @property {number} [maxTokens] Inclusive upper bound on `Run.tokens`.
 */

/**
 * @typedef {object} EvalCase
 * @property {string} id Stable identifier, unique inside one store.
 * @property {string} name Human-readable case name.
 * @property {unknown} input Fixture handed to the runner (prompt, transcript, ...).
 * @property {CaseExpect} expect Expectations that produce a PASS run.
 * @property {string[]} [tags] Optional labels; tags filters require all of them.
 */

/**
 * @typedef {object} Run
 * @property {string} caseId Case this run belongs to.
 * @property {unknown} output Runner output; usually a string.
 * @property {number} steps Number of agent/tool steps consumed.
 * @property {number} tokens Number of tokens consumed.
 * @property {number} latencyMs Wall-clock latency reported by the runner.
 * @property {'PASS'|'FAIL'} status Case-level grade.
 * @property {string[]} reasons Diagnostics; empty on PASS.
 */

/**
 * @typedef {object} Baseline
 * @property {string} caseId Case this baseline was recorded for.
 * @property {number} passRate Historical pass rate, in [0, 1].
 * @property {number} p50Tokens Historical median token usage.
 */

/**
 * @typedef {object} BaselineComparison
 * @property {string} caseId Compared case.
 * @property {Baseline} baseline Stored baseline.
 * @property {Run|null} run Latest run, or null when the case has not run yet.
 * @property {number|null} passRate Latest run's pass rate (0 or 1).
 * @property {number} baselinePassRate Baseline pass rate.
 * @property {number|null} passRateDelta Latest pass rate minus baseline.
 * @property {number|null} tokens Latest token usage.
 * @property {number} baselineP50Tokens Baseline median token usage.
 * @property {number|null} tokenRegression Fraction over baseline (0.2 = +20%).
 */

/**
 * @typedef {object} GateOptions
 * @property {number} [maxFailRatio=0] Allowed fraction of failed runs, in [0, 1].
 * @property {number} [maxTokenRegression=0.2] Allowed fractional token increase.
 * @property {string[]|string} [tags] Keep cases carrying every tag.
 */

/**
 * @typedef {object} GateResult
 * @property {'PASS'|'WARN'|'FAIL'} verdict Overall gate verdict.
 * @property {string[]} reasons Human-readable explanation, summary first.
 * @property {string[]} failed Case ids whose latest run failed.
 * @property {string[]} warned Case ids whose token usage regressed.
 * @property {number} failRatio failed / evaluated (0 when nothing ran).
 * @property {number} evaluated Number of selected cases with a latest run.
 */

/**
 * @typedef {object} ReportOptions
 * @property {string[]|string} [tags] Keep cases carrying every tag.
 */

/**
 * Create an in-memory eval store. All methods are synchronous and side-effect
 * free apart from the store's own maps.
 *
 * @returns {{
 *   defineCase: (candidate: EvalCase) => EvalCase,
 *   runCase: (id: string, runner: (evalCase: EvalCase) => object) => Run,
 *   compareToBaseline: (id: string, baseline: Baseline) => BaselineComparison,
 *   setBaseline: (baseline: Baseline) => Baseline,
 *   gate: (options?: GateOptions) => GateResult,
 *   report: (options?: ReportOptions) => object,
 * }}
 */
export function createEvalStore() {
  /** @type {Map<string, EvalCase>} */
  const cases = new Map()
  /** @type {Map<string, Run>} */
  const runs = new Map()
  /** @type {Map<string, Baseline>} */
  const baselines = new Map()

  /**
   * Register a case. Re-registering the same id is an error so suites cannot
   * silently overwrite each other.
   *
   * @param {EvalCase} candidate Case definition.
   * @returns {EvalCase} Detached copy of the stored case.
   */
  function defineCase(candidate) {
    const normalized = normalizeCase(candidate)
    if (cases.has(normalized.id)) {
      throw new EvalError('DUPLICATE_CASE_ID', `duplicate case id: "${normalized.id}"`)
    }
    const stored = freezeCase(normalized)
    cases.set(stored.id, stored)
    return copyCase(stored)
  }

  /**
   * Run one case with an injected synchronous runner. The runner is the only
   * place a model or replay adapter could be called; the core never calls one.
   *
   * @param {string} id Case id.
   * @param {(evalCase: EvalCase) => object} runner Injected runner.
   * @returns {Run} Detached run summary; also becomes the case's latest run.
   */
  function runCase(id, runner) {
    const evalCase = requireCase(id)
    if (typeof runner !== 'function') {
      throw new EvalError('INVALID_RUNNER', 'runner must be a synchronous function')
    }

    /** @type {object} */
    let raw
    try {
      raw = runner(copyCase(evalCase))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed = freezeRun({
        caseId: evalCase.id,
        output: null,
        steps: 0,
        tokens: 0,
        latencyMs: 0,
        status: 'FAIL',
        reasons: [`runner threw: ${message === '' ? 'unknown error' : message}`],
      })
      runs.set(evalCase.id, failed)
      return copyRun(failed)
    }

    if (raw !== null && (typeof raw === 'object' || typeof raw === 'function') && typeof raw.then === 'function') {
      throw new EvalError(
        'ASYNC_RUNNER_UNSUPPORTED',
        'runner returned a Promise; dsh-os-eval 0.1 only supports synchronous runners',
      )
    }
    if (!isPlainObject(raw)) {
      throw new EvalError('INVALID_RUN_RESULT', 'runner must return a plain object')
    }

    const output = Object.hasOwn(raw, 'output') ? raw.output : ''
    const steps = readNonNegativeNumber(raw.steps, 0, 'run.steps')
    const tokens = readNonNegativeNumber(raw.tokens, 0, 'run.tokens')
    const latencyMs = readNonNegativeNumber(raw.latencyMs, 0, 'run.latencyMs')
    const reasons = gradeExpect(evalCase.expect, output, steps, tokens)
    const run = freezeRun({
      caseId: evalCase.id,
      output,
      steps,
      tokens,
      latencyMs,
      status: reasons.length === 0 ? 'PASS' : 'FAIL',
      reasons,
    })
    runs.set(evalCase.id, run)
    return copyRun(run)
  }

  /**
   * Store a baseline and compare it with the case's latest run. Calling this
   * before the first run is allowed: the comparison fields are then null, and
   * a later gate uses the stored baseline.
   *
   * @param {string} id Case id.
   * @param {Baseline} baseline Baseline for that case.
   * @returns {BaselineComparison} Baseline plus latest-run deltas.
   */
  function compareToBaseline(id, baseline) {
    const evalCase = requireCase(id)
    const normalized = normalizeBaseline(baseline, evalCase.id)
    baselines.set(evalCase.id, normalized)
    const run = runs.get(evalCase.id) ?? null
    const passRate = run === null ? null : run.status === 'PASS' ? 1 : 0
    return {
      caseId: evalCase.id,
      baseline: { ...normalized },
      run: run === null ? null : copyRun(run),
      passRate,
      baselinePassRate: normalized.passRate,
      passRateDelta: passRate === null ? null : passRate - normalized.passRate,
      tokens: run === null ? null : run.tokens,
      baselineP50Tokens: normalized.p50Tokens,
      tokenRegression: run === null ? null : tokenRegressionRatio(run.tokens, normalized.p50Tokens),
    }
  }

  /**
   * Store a baseline without requiring a run. Useful when loading fixtures at
   * plugin activation time.
   *
   * @param {Baseline} baseline Baseline with an explicit `caseId`.
   * @returns {Baseline} Detached copy of the stored baseline.
   */
  function setBaseline(baseline) {
    const normalized = normalizeBaseline(baseline)
    requireCase(normalized.caseId)
    baselines.set(normalized.caseId, normalized)
    return { ...normalized }
  }

  /**
   * Evaluate the latest run of every selected case.
   *
   * Verdict ladder:
   * - FAIL when the failed-case ratio exceeds `maxFailRatio`, or no selected
   *   case has a run.
   * - WARN when a token regression exceeds `maxTokenRegression`.
   * - PASS otherwise. Failures tolerated by `maxFailRatio` are listed in
   *   `failed` and in the reasons, but do not change the verdict by themselves.
   *
   * @param {GateOptions} [options] Gate policy.
   * @returns {GateResult} Verdict, reasons, and affected case ids.
   */
  function gate(options) {
    const opts = asOptions(options, 'gate')
    const maxFailRatio = opts.maxFailRatio === undefined
      ? DEFAULT_MAX_FAIL_RATIO
      : readRatio(opts.maxFailRatio, 'maxFailRatio')
    const maxTokenRegression = opts.maxTokenRegression === undefined
      ? DEFAULT_MAX_TOKEN_REGRESSION
      : readNonNegativeNumber(opts.maxTokenRegression, DEFAULT_MAX_TOKEN_REGRESSION, 'maxTokenRegression')
    const selected = selectCases(opts.tags)

    if (selected.length === 0) {
      return {
        verdict: 'FAIL',
        reasons: ['no cases matched the tag filter'],
        failed: [],
        warned: [],
        failRatio: 0,
        evaluated: 0,
      }
    }

    /** @type {string[]} */
    const failed = []
    /** @type {string[]} */
    const warned = []
    /** @type {string[]} */
    const details = []
    let evaluated = 0

    for (const evalCase of selected) {
      const run = runs.get(evalCase.id)
      if (run === undefined) continue
      evaluated += 1

      if (run.status === 'FAIL') {
        failed.push(evalCase.id)
        const detail = run.reasons.length === 0 ? 'expectations not met' : run.reasons.join('; ')
        details.push(`case "${evalCase.id}" failed: ${detail}`)
      }

      const baseline = baselines.get(evalCase.id)
      if (baseline !== undefined) {
        const regression = tokenRegressionRatio(run.tokens, baseline.p50Tokens)
        if (regression - maxTokenRegression > EPSILON) {
          warned.push(evalCase.id)
          details.push(
            `case "${evalCase.id}" token regression ${formatPercent(regression)}`
            + ` exceeds ${formatPercent(maxTokenRegression)}`,
          )
        }
      }
    }

    if (evaluated === 0) {
      return {
        verdict: 'FAIL',
        reasons: ['no eval runs available for the selected cases'],
        failed,
        warned,
        failRatio: 0,
        evaluated: 0,
      }
    }

    const failRatio = failed.length / evaluated
    if (failRatio - maxFailRatio > EPSILON) {
      return {
        verdict: 'FAIL',
        reasons: [
          `failure ratio ${formatPercent(failRatio)} exceeds maxFailRatio ${formatPercent(maxFailRatio)}`,
          ...details,
        ],
        failed,
        warned,
        failRatio,
        evaluated,
      }
    }

    if (warned.length > 0) {
      return {
        verdict: 'WARN',
        reasons: [`token regression in ${warned.length} case(s)`, ...details],
        failed,
        warned,
        failRatio,
        evaluated,
      }
    }

    const summary = failed.length > 0
      ? `${failed.length} failure(s) within maxFailRatio ${formatPercent(maxFailRatio)}`
      : `all ${evaluated} evaluated case(s) passed`
    return {
      verdict: 'PASS',
      reasons: [summary, ...details],
      failed,
      warned,
      failRatio,
      evaluated,
    }
  }

  /**
   * Summarise stored cases without exposing raw runner output. This is the
   * payload suitable for logs and CI annotations.
   *
   * @param {ReportOptions} [options] Optional tag filter.
   * @returns {object} Aggregate counts plus one summary row per selected case.
   */
  function report(options) {
    const opts = asOptions(options, 'report')
    const selected = selectCases(opts.tags)
    /** @type {object[]} */
    const entries = []
    let runCount = 0
    let passed = 0
    let failed = 0
    let tokens = 0
    let steps = 0

    for (const evalCase of selected) {
      const run = runs.get(evalCase.id)
      const baseline = baselines.get(evalCase.id)
      entries.push({
        caseId: evalCase.id,
        name: evalCase.name,
        tags: [...evalCase.tags],
        status: run === undefined ? 'NOT_RUN' : run.status,
        steps: run === undefined ? null : run.steps,
        tokens: run === undefined ? null : run.tokens,
        latencyMs: run === undefined ? null : run.latencyMs,
        reasons: run === undefined ? [] : [...run.reasons],
        baseline: baseline === undefined
          ? null
          : { passRate: baseline.passRate, p50Tokens: baseline.p50Tokens },
        tokenRegression: run === undefined || baseline === undefined
          ? null
          : tokenRegressionRatio(run.tokens, baseline.p50Tokens),
      })

      if (run !== undefined) {
        runCount += 1
        if (run.status === 'PASS') passed += 1
        else failed += 1
        tokens += run.tokens
        steps += run.steps
      }
    }

    return {
      total: selected.length,
      runCount,
      passed,
      failed,
      notRun: selected.length - runCount,
      passRate: runCount === 0 ? null : passed / runCount,
      tokens,
      steps,
      cases: entries,
    }
  }

  /**
   * @param {string} id Candidate case id.
   * @returns {EvalCase} Stored case.
   */
  function requireCase(id) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new EvalError('INVALID_CASE', 'case id must be a non-empty string')
    }
    const evalCase = cases.get(id)
    if (evalCase === undefined) {
      throw new EvalError('UNKNOWN_CASE', `unknown case id: "${id}"`)
    }
    return evalCase
  }

  /**
   * @param {string[]|string} [tags] Tag filter.
   * @returns {EvalCase[]} Cases carrying every requested tag.
   */
  function selectCases(tags) {
    const filter = normalizeTagFilter(tags)
    const selected = []
    for (const evalCase of cases.values()) {
      if (filter.every((tag) => evalCase.tags.includes(tag))) selected.push(evalCase)
    }
    return selected
  }

  return { defineCase, runCase, compareToBaseline, setBaseline, gate, report }
}

/**
 * @param {unknown} value Candidate case definition.
 * @returns {EvalCase} Validated, mutable deep-ish copy.
 */
function normalizeCase(value) {
  if (!isPlainObject(value)) {
    throw new EvalError('INVALID_CASE', 'case must be a plain object')
  }
  const id = requireNonEmptyString(value.id, 'case.id', 'INVALID_CASE')
  const name = requireNonEmptyString(value.name, 'case.name', 'INVALID_CASE')

  if (!isPlainObject(value.expect)) {
    throw new EvalError('INVALID_CASE', `case "${id}" expects an expect object`)
  }

  /** @type {CaseExpect} */
  const expect = {}
  if (value.expect.contains !== undefined) {
    if (!Array.isArray(value.expect.contains)) {
      throw new EvalError('INVALID_CASE', `case "${id}" expect.contains must be an array of strings`)
    }
    expect.contains = value.expect.contains.map((phrase, index) => requireNonEmptyString(
      phrase,
      `case "${id}" expect.contains[${index}]`,
      'INVALID_CASE',
    ))
  }
  if (Object.hasOwn(value.expect, 'equals')) {
    expect.equals = value.expect.equals
  }
  if (value.expect.maxSteps !== undefined) {
    expect.maxSteps = readNonNegativeNumber(
      value.expect.maxSteps,
      0,
      `case "${id}" expect.maxSteps`,
      'INVALID_CASE',
    )
  }
  if (value.expect.maxTokens !== undefined) {
    expect.maxTokens = readNonNegativeNumber(
      value.expect.maxTokens,
      0,
      `case "${id}" expect.maxTokens`,
      'INVALID_CASE',
    )
  }

  /** @type {string[]} */
  let tags = []
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags)) {
      throw new EvalError('INVALID_CASE', `case "${id}" tags must be an array of strings`)
    }
    tags = [...new Set(value.tags.map((tag, index) => requireNonEmptyString(
      tag,
      `case "${id}" tags[${index}]`,
      'INVALID_CASE',
    )))]
  }

  return { id, name, input: value.input, expect, tags }
}

/**
 * @param {EvalCase} value Case to freeze.
 * @returns {EvalCase} Frozen case with frozen nested expectation/tag arrays.
 */
function freezeCase(value) {
  const expect = { ...value.expect }
  if (expect.contains !== undefined) expect.contains = Object.freeze([...expect.contains])
  return Object.freeze({
    id: value.id,
    name: value.name,
    input: value.input,
    expect: Object.freeze(expect),
    tags: Object.freeze([...value.tags ?? []]),
  })
}

/**
 * @param {EvalCase} value Case to copy.
 * @returns {EvalCase} Detached copy safe to hand to a runner.
 */
function copyCase(value) {
  const expect = { ...value.expect }
  if (expect.contains !== undefined) expect.contains = [...expect.contains]
  return { id: value.id, name: value.name, input: value.input, expect, tags: [...value.tags ?? []] }
}

/**
 * @param {Run} run Run to freeze.
 * @returns {Run} Frozen run with a frozen reasons array.
 */
function freezeRun(run) {
  return Object.freeze({ ...run, reasons: Object.freeze([...run.reasons]) })
}

/**
 * @param {Run} run Run to copy.
 * @returns {Run} Detached run copy.
 */
function copyRun(run) {
  return { ...run, reasons: [...run.reasons] }
}

/**
 * Grade a run's output against a case's expectations. An empty `expect` passes.
 *
 * @param {CaseExpect} expect Expectations.
 * @param {unknown} output Runner output.
 * @param {number} steps Observed steps.
 * @param {number} tokens Observed tokens.
 * @returns {string[]} Failure reasons; empty means PASS.
 */
function gradeExpect(expect, output, steps, tokens) {
  /** @type {string[]} */
  const reasons = []

  if (expect.contains !== undefined) {
    if (typeof output !== 'string') {
      reasons.push('output is not a string; contains cannot be checked')
    } else {
      for (const phrase of expect.contains) {
        if (!output.includes(phrase)) {
          reasons.push(`output does not contain ${JSON.stringify(phrase)}`)
        }
      }
    }
  }

  if (Object.hasOwn(expect, 'equals') && !isDeepStrictEqual(output, expect.equals)) {
    reasons.push(`output does not equal ${preview(expect.equals)}`)
  }

  if (expect.maxSteps !== undefined && steps > expect.maxSteps) {
    reasons.push(`steps ${steps} exceed maxSteps ${expect.maxSteps}`)
  }

  if (expect.maxTokens !== undefined && tokens > expect.maxTokens) {
    reasons.push(`tokens ${tokens} exceed maxTokens ${expect.maxTokens}`)
  }

  return reasons
}

/**
 * @param {unknown} value Candidate baseline.
 * @param {string} [caseIdHint] Case id supplied by the caller.
 * @returns {Baseline} Frozen, validated baseline.
 */
function normalizeBaseline(value, caseIdHint) {
  if (!isPlainObject(value)) {
    throw new EvalError('INVALID_BASELINE', 'baseline must be a plain object')
  }

  let caseId
  if (caseIdHint === undefined) {
    caseId = requireNonEmptyString(value.caseId, 'baseline.caseId', 'INVALID_BASELINE')
  } else {
    caseId = caseIdHint
    if (value.caseId !== undefined && value.caseId !== caseIdHint) {
      throw new EvalError('INVALID_BASELINE', 'baseline.caseId must match the case id')
    }
  }

  const passRate = readRatio(value.passRate, `case "${caseId}" baseline.passRate`, 'INVALID_BASELINE')
  if (value.p50Tokens === undefined) {
    throw new EvalError('INVALID_BASELINE', `case "${caseId}" baseline.p50Tokens is required`)
  }
  const p50Tokens = readNonNegativeNumber(
    value.p50Tokens,
    0,
    `case "${caseId}" baseline.p50Tokens`,
    'INVALID_BASELINE',
  )

  return Object.freeze({ caseId, passRate, p50Tokens })
}

/**
 * Fractional token change over the baseline. A zero-token baseline treats any
 * token usage as 100% regression (conservative for a gate).
 *
 * @param {number} tokens Latest tokens.
 * @param {number} p50Tokens Baseline median tokens.
 * @returns {number} Regression fraction; negative means an improvement.
 */
function tokenRegressionRatio(tokens, p50Tokens) {
  if (p50Tokens > 0) return (tokens - p50Tokens) / p50Tokens
  return tokens > 0 ? 1 : 0
}

/**
 * @param {unknown} tags Tag filter.
 * @returns {string[]} Normalised filter tags (AND semantics).
 */
function normalizeTagFilter(tags) {
  if (tags === undefined || tags === null) return []
  const list = typeof tags === 'string' ? [tags] : tags
  if (!Array.isArray(list)) {
    throw new EvalError('INVALID_OPTIONS', 'tags must be a string or an array of strings')
  }
  return [...new Set(list.map((tag, index) => requireNonEmptyString(
    tag,
    `tags[${index}]`,
    'INVALID_OPTIONS',
  )))]
}

/**
 * @param {unknown} value Candidate options.
 * @param {string} label Method name for error messages.
 * @returns {object} Options object.
 */
function asOptions(value, label) {
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    throw new EvalError('INVALID_OPTIONS', `${label} options must be a plain object`)
  }
  return value
}

/**
 * @param {unknown} value Candidate number.
 * @param {number} fallback Value used when undefined.
 * @param {string} label Field name for error messages.
 * @param {string} [code] Error code to throw.
 * @returns {number} Validated non-negative finite number.
 */
function readNonNegativeNumber(value, fallback, label, code = 'INVALID_RUN_RESULT') {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new EvalError(code, `${label} must be a non-negative finite number`)
  }
  return value
}

/**
 * @param {unknown} value Candidate ratio.
 * @param {string} label Field name for error messages.
 * @param {string} [code] Error code to throw.
 * @returns {number} Validated number in [0, 1].
 */
function readRatio(value, label, code = 'INVALID_OPTIONS') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new EvalError(code, `${label} must be a finite number between 0 and 1`)
  }
  return value
}

/**
 * @param {unknown} value Candidate string.
 * @param {string} label Field name for error messages.
 * @param {string} code Error code to throw.
 * @returns {string} The original non-empty string.
 */
function requireNonEmptyString(value, label, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EvalError(code, `${label} must be a non-empty string`)
  }
  return value
}

/**
 * @param {unknown} value Candidate value.
 * @returns {value is Record<string, unknown>} Whether it is a plain object.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * @param {unknown} value Value to render.
 * @returns {string} Bounded JSON-ish preview.
 */
function preview(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (typeof text !== 'string') text = String(value)
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

/**
 * @param {number} ratio Fraction to render.
 * @returns {string} Percentage with one decimal.
 */
function formatPercent(ratio) {
  return `${(ratio * 100).toFixed(1)}%`
}
