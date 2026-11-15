/**
 * Opt-in context-pressure guard for dsh-os-quota.
 *
 * DSH's token-meter service exposes `ctx.tokenMeter.contextPressure(session)`,
 * a synchronous snapshot of the provider-reported prompt size of the most
 * recent request. This module turns that read-only measurement into one narrow
 * admission rule: while the latest `pressureTokens` is above `maxPressure`,
 * deny the gated tool call and (optionally) ask the jobs registry to stop the
 * session's running jobs.
 *
 * Design rules:
 *
 * - The guard is dependency-free (no `@deepseek-ai/*` imports) and unit-tested
 *   with a fake context, matching `core.js`, `enforce.js` and `meter.js`.
 * - Pressure is a **snapshot**, not a reservation: exactly at `maxPressure` is
 *   allowed, and only the latest recorded provider sample is consulted. It is
 *   not a token budget; the governor remains the budget authority.
 * - A missing/broken `tokenMeter` or a missing session fails **open** with
 *   `{ allow: true, reason: 'unavailable' }`. The guard never throws at the
 *   host because losing observability must not brick tool calls.
 * - `killJobs` is deliberately blunt: only jobs whose status is exactly
 *   `running` are killed, always with the `'quota'` reason and the session id
 *   as the caller. Completed/failed/killed/stopping records are never touched.
 *   Repeated checks do not re-request a kill for an id already requested.
 * - This still cannot interrupt an LLM request. It only denies a tool call
 *   that the host routes through `tools/pre-execute`.
 */

/** Bound for kill bookkeeping so a long-lived process cannot grow forever. */
const MAX_TRACKED_JOBS = 4096

/** @typedef {{ allow: true, reason?: string } | { kind: 'deny', allow: false, reason: string }} PressureDecision */

/** @param {unknown} value @returns {boolean} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string | null} */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read a non-negative finite token count from a context-pressure projection.
 * `undefined` means the provider has not reported usage yet; malformed values
 * are treated the same way rather than denying on bad telemetry.
 * @param {unknown} projection
 * @returns {number | null}
 */
function pressureTokensOf(projection) {
  if (!isObject(projection)) return null
  const value = projection.pressureTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * @param {(() => number | Date) | number | Date | undefined} now
 * @returns {() => number}
 */
function createClock(now) {
  if (now === undefined) return () => Date.now()
  if (typeof now === 'function') {
    return () => {
      const value = now()
      if (value instanceof Date) return value.getTime()
      if (typeof value === 'number' && Number.isFinite(value)) return value
      throw new TypeError('now() must return epoch milliseconds or a Date')
    }
  }
  const fixed = now instanceof Date ? now.getTime() : now
  if (typeof fixed !== 'number' || !Number.isFinite(fixed)) {
    throw new TypeError('now must be epoch milliseconds, a Date, or a function')
  }
  return () => fixed
}

/**
 * Create a context-pressure guard.
 *
 * @param {object} options
 * @param {object} [options.ctx] Cordis context exposing `tokenMeter` and,
 *   when `killJobs` is enabled, `jobs`. A missing context is not a construction
 *   error: `check()` then reports the service as unavailable.
 * @param {object} [options.governor] Optional governor from
 *   {@link import('./core.js').createGovernor}, exposed for embedders/status.
 *   Pressure policy is independent of the ledger limits; the guard never books
 *   usage.
 * @param {number} options.maxPressure Inclusive threshold in tokens. A check
 *   denies only when the reported `pressureTokens` is strictly greater.
 *   `Infinity` is accepted and effectively disables denial.
 * @param {boolean} [options.killJobs=false] When true, an over-threshold check
 *   also calls `ctx.jobs.kill(id, session.id, 'quota')` for every visible job
 *   whose status is exactly `running`.
 * @param {(() => number | Date) | number | Date} [options.now] Clock override
 *   for the `at` field in status; intended for embedding and tests.
 * @returns {{
 *   check: (input?: object) => PressureDecision,
 *   status: () => object,
 *   governor: object | undefined,
 *   maxPressure: number,
 *   killJobs: boolean,
 *   readonly available: boolean,
 *   readonly jobService: boolean,
 * }}
 */
export function createPressureGuard(options = {}) {
  if (!isObject(options)) throw new TypeError('createPressureGuard options must be an object')
  const { ctx, governor } = options
  const maxPressure = options.maxPressure
  if (typeof maxPressure !== 'number' || Number.isNaN(maxPressure) || maxPressure < 0) {
    throw new TypeError('createPressureGuard requires maxPressure as a non-negative number')
  }
  if (options.killJobs !== undefined && typeof options.killJobs !== 'boolean') {
    throw new TypeError('killJobs must be a boolean')
  }
  const killJobs = options.killJobs === true
  const clock = createClock(options.now)

  const counters = {
    /** `check()` calls, including unavailable/allow/deny outcomes. */
    checks: 0,
    /** Checks that allowed the call. */
    allowed: 0,
    /** Checks that denied the call for pressure. */
    denied: 0,
    /** Checks that could not read the token-meter service or session. */
    unavailable: 0,
    /** Contained service/list/kill failures. */
    errors: 0,
    /** Successful `ctx.jobs.list(session.id)` calls. */
    killLists: 0,
    /** Successful `ctx.jobs.kill(...)` invocations (any return value). */
    killRequests: 0,
    /** Kill invocations the registry accepted as `requested`. */
    killed: 0,
    /** Running jobs skipped because their id was already kill-requested. */
    killSkipped: 0,
    /** Jobs/list/kill failures during a pressure kill sweep. */
    killErrors: 0,
  }

  /** @type {object | null} */
  let last = null
  /** @type {string | null} */
  let lastError = null
  /** @type {number | null} */
  let lastPressureTokens = null

  /** @type {Set<string>} */
  const killRequested = new Set()
  /** @type {string[]} */
  const killOrder = []

  /**
   * @param {object} entry
   * @returns {void}
   */
  function recordLast(entry) {
    last = { ...entry, at: clock() }
  }

  /** @returns {object | undefined} */
  function meterOf() {
    try {
      return isObject(ctx) ? ctx.tokenMeter : undefined
    } catch {
      return undefined
    }
  }

  /** @returns {object | undefined} */
  function jobsOf() {
    try {
      return isObject(ctx) ? ctx.jobs : undefined
    } catch {
      return undefined
    }
  }

  /**
   * @param {unknown} value
   * @param {string} name
   * @returns {boolean}
   */
  function hasFunction(value, name) {
    if (!isObject(value)) return false
    try {
      return typeof value[name] === 'function'
    } catch {
      return false
    }
  }

  /** @returns {boolean} */
  function isMeterAvailable() {
    return hasFunction(meterOf(), 'contextPressure')
  }

  /** @returns {boolean} */
  function isJobServiceAvailable() {
    const jobs = jobsOf()
    return hasFunction(jobs, 'list') && hasFunction(jobs, 'kill')
  }

  /**
   * Remember a job id we already asked the registry to kill. Bounded insertion
   * order keeps the memory flat while still suppressing duplicate requests.
   * @param {string} id
   * @returns {void}
   */
  function rememberKill(id) {
    if (killRequested.has(id)) return
    killRequested.add(id)
    killOrder.push(id)
    if (killOrder.length <= MAX_TRACKED_JOBS) return
    const oldest = killOrder.shift()
    if (oldest !== undefined) killRequested.delete(oldest)
  }

  /**
   * Ask the jobs registry to stop every running job visible to `session`.
   * Failures are contained: the caller still returns the pressure denial.
   * @param {object} session
   * @returns {string[]} Ids for which a kill was newly requested.
   */
  function killRunningJobs(session) {
    const jobs = jobsOf()
    if (!hasFunction(jobs, 'list') || !hasFunction(jobs, 'kill')) {
      counters.killErrors += 1
      counters.errors += 1
      lastError = 'ctx.jobs.list()/kill() is not available'
      return []
    }
    const sessionId = nonEmptyString(session.id)
    if (sessionId === null) {
      counters.killSkipped += 1
      lastError = 'session.id is required to list jobs'
      return []
    }

    let visible
    try {
      visible = jobs.list(sessionId)
      counters.killLists += 1
    } catch (error) {
      counters.killErrors += 1
      counters.errors += 1
      lastError = errorMessage(error)
      return []
    }
    if (!Array.isArray(visible)) {
      counters.killErrors += 1
      counters.errors += 1
      lastError = 'ctx.jobs.list() did not return an array'
      return []
    }

    /** @type {string[]} */
    const killed = []
    for (const job of visible) {
      if (!isObject(job) || job.status !== 'running') continue
      const id = nonEmptyString(job.id)
      if (id === null) {
        counters.killSkipped += 1
        continue
      }
      if (killRequested.has(id)) {
        counters.killSkipped += 1
        continue
      }
      try {
        const outcome = jobs.kill(id, sessionId, 'quota')
        counters.killRequests += 1
        rememberKill(id)
        killed.push(id)
        if (outcome === 'requested') counters.killed += 1
      } catch (error) {
        counters.killErrors += 1
        counters.errors += 1
        lastError = errorMessage(error)
      }
    }
    return killed
  }

  /**
   * Evaluate the latest context pressure against `maxPressure`.
   *
   * The documented denial is exactly `{ kind: 'deny', allow: false,
   * reason: 'pressure' }`. A missing service, missing session, or malformed
   * projection fails open instead of throwing.
   *
   * @param {{ session?: object } | object} [input] `{ session }`, or the
   *   session object itself for lighter adapters.
   * @returns {PressureDecision}
   */
  function check(input = {}) {
    counters.checks += 1
    const session = isObject(input) && isObject(input.session)
      ? input.session
      : isObject(input) && nonEmptyString(input.id) !== null
        ? input
        : null
    const meter = meterOf()
    if (!hasFunction(meter, 'contextPressure')) {
      counters.unavailable += 1
      recordLast({ kind: 'unavailable', reason: 'unavailable', detail: 'tokenMeter service missing' })
      return { allow: true, reason: 'unavailable' }
    }
    if (session === null) {
      counters.unavailable += 1
      recordLast({ kind: 'unavailable', reason: 'unavailable', detail: 'session missing' })
      return { allow: true, reason: 'unavailable' }
    }

    let projection
    try {
      projection = meter.contextPressure(session)
    } catch (error) {
      counters.unavailable += 1
      counters.errors += 1
      lastError = errorMessage(error)
      recordLast({ kind: 'unavailable', reason: 'unavailable', error: lastError })
      return { allow: true, reason: 'unavailable' }
    }

    const pressureTokens = pressureTokensOf(projection)
    if (pressureTokens === null) {
      counters.allowed += 1
      lastPressureTokens = null
      recordLast({ kind: 'allow', reason: 'no-pressure' })
      return { allow: true }
    }
    lastPressureTokens = pressureTokens

    if (pressureTokens <= maxPressure) {
      counters.allowed += 1
      recordLast({ kind: 'allow', pressureTokens })
      return { allow: true }
    }

    counters.denied += 1
    const killed = killJobs ? killRunningJobs(session) : []
    recordLast({ kind: 'deny', reason: 'pressure', pressureTokens, killed })
    return { kind: 'deny', allow: false, reason: 'pressure' }
  }

  /**
   * Read-only snapshot for `quota_pressure_status`.
   * @returns {object}
   */
  function status() {
    return {
      enabled: true,
      configured: true,
      provider: 'tokenMeter',
      available: isMeterAvailable(),
      jobService: isJobServiceAvailable(),
      maxPressure,
      killJobs,
      counters: { ...counters },
      last: last === null ? null : { ...last },
      lastError,
      pressureTokens: lastPressureTokens,
      killedJobs: [...killOrder],
    }
  }

  const guard = {
    check,
    status,
    governor,
    maxPressure,
    killJobs,
    get available() { return isMeterAvailable() },
    get jobService() { return isJobServiceAvailable() },
  }
  return guard
}
