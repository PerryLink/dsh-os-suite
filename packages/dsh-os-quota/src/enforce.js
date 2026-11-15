/**
 * Opt-in tool-call enforcement adapter for dsh-os-quota.
 *
 * `src/core.js` is the policy engine (admit/consume); this module is the thin
 * seam that lets a DSH host enforce that policy on real tool calls:
 *
 * - `preExecute(call, next)` is a `tools/pre-execute` waterfall listener. It
 *   estimates the call's cost, asks the governor for admission, denies a hard
 *   overage, and otherwise delegates to `next()` (marking `degrade` on soft).
 * - The attached result listener books reality when a tool result carries
 *   `usage.tokens`; a result without usage is skipped, never guessed.
 *
 * The module imports nothing from `@deepseek-ai/*` so it can be unit-tested
 * with a fake context. It still speaks the DSH waterfall convention
 * (`{ kind: 'deny', reason }`); denial decisions also carry `allow: false` so
 * simple adapters can read the same object without knowing the DSH tag.
 */

/** Stable error code attached to a hard rejection. */
export const QUOTA_DENIED_CODE = 'QUOTA_HARD_LIMIT'

/** Scope used when neither the config nor the call names one. */
const DEFAULT_SCOPE = 'default'

/** Quota's own tools are observability/control-plane calls: never gate them. */
const QUOTA_TOOL_PREFIX = 'quota_'

/** Bound for callId bookkeeping so a long-lived process cannot grow forever. */
const MAX_TRACKED_CALLS = 4096

/** @typedef {'tokens' | 'jobs' | 'diskMb'} Dimension */

/** @typedef {{ tokens: number, jobs: number, diskMb: number }} Usage */

/**
 * A hard-limit denial. `preExecute` returns the denial object by default; it
 * throws this error only when `throwOnDeny: true` (or when called directly by
 * an embedder that prefers exceptions).
 */
export class QuotaDeniedError extends Error {
  /**
   * @param {object} [decision] Admission decision from the governor.
   * @param {object} [options]
   * @param {string} [options.reason] Override the generated model-facing reason.
   * @param {object} [options.call] The tool execution that was denied.
   * @param {string} [options.tool] Tool name when `call` is unavailable.
   */
  constructor(decision, options = {}) {
    const reason = typeof options.reason === 'string' && options.reason !== ''
      ? options.reason
      : describeDenial(decision, options.call, options.tool)
    super(reason)
    this.name = 'QuotaDeniedError'
    this.code = QUOTA_DENIED_CODE
    this.reason = reason
    this.scope = typeof decision?.scope === 'string' ? decision.scope : DEFAULT_SCOPE
    this.level = 'hard'
    this.allowed = false
    this.allow = false
    this.decision = decision ?? null
    this.call = options.call ?? null
    this.info = { name: this.name, code: this.code, reason }
  }
}

/** @param {unknown} value @returns {boolean} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string | null} */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Read a tool name from the two spellings hosts use: `name` (DSH) and `tool`
 * (lighter adapters).
 * @param {unknown} call
 * @returns {string}
 */
export function toolNameOf(call) {
  if (!isObject(call)) return ''
  return nonEmptyString(call.name)
    ?? nonEmptyString(call.tool)
    ?? nonEmptyString(call.toolName)
    ?? ''
}

/**
 * Resolve the Session a pre-execute call belongs to. DSH passes a
 * `ToolExecution` whose live `agent.session` is the durable session; lighter
 * adapters may hand the session through `call.session` instead.
 * @param {unknown} call
 * @returns {object | undefined}
 */
export function sessionOfCall(call) {
  if (!isObject(call)) return undefined
  if (isObject(call.session)) return call.session
  if (isObject(call.agent) && isObject(call.agent.session)) return call.agent.session
  return undefined
}

/**
 * Clamp an estimated amount to a non-negative finite number. Estimates are not
 * bookings: bad input becomes 0 rather than corrupting the projection.
 * @param {unknown} value
 * @returns {number}
 */
function estimateAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Merge one cost estimate over another. A bare number means tokens; an object
 * may carry any subset of the three dimensions (including an explicit zero).
 * @param {Usage} base
 * @param {unknown} patch
 * @returns {Usage}
 */
function mergeCost(base, patch) {
  if (patch === undefined || patch === null) return base
  if (typeof patch === 'number') return { ...base, tokens: estimateAmount(patch) }
  if (!isObject(patch)) return base
  /** @type {Usage} */
  const next = { ...base }
  for (const dim of /** @type {readonly Dimension[]} */ (['tokens', 'jobs', 'diskMb'])) {
    if (Object.hasOwn(patch, dim)) next[dim] = estimateAmount(patch[dim])
  }
  return next
}

/**
 * Extract a normalized usage vector. Presence of a finite `tokens` number is
 * the trigger; `jobs`/`diskMb` ride along when present.
 * @param {unknown} value
 * @returns {Usage | null}
 */
function usageOf(value) {
  if (!isObject(value)) return null
  if (typeof value.tokens !== 'number' || !Number.isFinite(value.tokens)) return null
  return {
    tokens: estimateAmount(value.tokens),
    jobs: estimateAmount(value.jobs),
    diskMb: estimateAmount(value.diskMb),
  }
}

/**
 * Look for a usage vector in the shapes tool results actually take:
 * `result.usage`, `result.meta.usage`, the canonical `result.value.usage`, a
 * wrapped `{ result }`, and (last) a bare `{ tokens }` object.
 * @param {...unknown} sources
 * @returns {Usage | null}
 */
export function findUsage(...sources) {
  for (const source of sources) {
    if (!isObject(source)) continue
    const candidates = [
      source.usage,
      isObject(source.meta) ? source.meta.usage : undefined,
      isObject(source.value) ? source.value.usage : undefined,
      isObject(source.result) ? source.result.usage : undefined,
      isObject(source.data) ? source.data.usage : undefined,
    ]
    for (const candidate of candidates) {
      const usage = usageOf(candidate)
      if (usage !== null) return usage
    }
    // A bare `{ tokens }` usage object is accepted, but never a call-shaped
    // object: a call's admission estimate must not be mistaken for a result.
    const callShaped = nonEmptyString(source.name) !== null
      || nonEmptyString(source.tool) !== null
      || source.callId !== undefined
      || isObject(source.arguments)
    if (!callShaped) {
      const direct = usageOf(source)
      if (direct !== null) return direct
    }
  }
  return null
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function callIdOf(value) {
  if (!isObject(value)) return null
  const candidates = [
    value.callId,
    value.toolCallId,
    isObject(value.exec) ? value.exec.callId : undefined,
    isObject(value.execution) ? value.execution.callId : undefined,
    isObject(value.message) ? value.message.toolCallId : undefined,
    isObject(value.result) ? value.result.callId : undefined,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
  }
  return null
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'unlimited'
}

/**
 * Build a deterministic, model-facing denial reason.
 * @param {object | undefined} decision
 * @param {unknown} [call]
 * @param {string} [tool]
 * @returns {string}
 */
export function describeDenial(decision, call, tool) {
  const name = nonEmptyString(tool) || toolNameOf(call) || 'tool'
  const scope = typeof decision?.scope === 'string' ? decision.scope : DEFAULT_SCOPE
  const exceeded = Array.isArray(decision?.exceeded) && decision.exceeded.length > 0
    ? decision.exceeded
    : ['tokens', 'jobs', 'diskMb']
  const detail = exceeded.map((dim) => {
    const used = isObject(decision?.projected) ? decision.projected[dim] : undefined
    const limit = isObject(decision?.limits) ? decision.limits[dim] : undefined
    return `${dim} ${formatNumber(used)} > limit ${formatNumber(limit)}`
  }).join(', ')
  return `Quota hard limit reached for scope "${scope}" (${detail}); tool "${name}" was denied.`
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
 * Create the opt-in enforcement adapter.
 *
 * @param {object} options
 * @param {object} options.governor A governor from {@link createGovernor};
 *   only `admit` is required, `consume` is used by the result listener.
 * @param {(decision: object, call: object, error: QuotaDeniedError) => void} [options.onDeny]
 *   Observer for hard denials. Exceptions are contained and counted, never
 *   turned into a different admission outcome.
 * @param {((name: string, call: object) => unknown) | Record<string, unknown>} [options.costOf]
 *   Cost estimator for a tool name. A function receives `(name, call)`; an
 *   object is looked up by exact name, then by `'*'`. A number means tokens.
 * @param {string | ((call: object) => string)} [options.scope]
 *   Fixed scope id, or a resolver called with the execution. When omitted, a
 *   call-level `scope` (or `arguments.scope`) is used, then `"default"`.
 * @param {string[]} [options.ignore] Extra tool names never gated. `quota_*`
 *   tools are always ignored.
 * @param {boolean} [options.throwOnDeny=false] Throw a {@link QuotaDeniedError}
 *   instead of returning a denial object. Returning is the DSH-preferred path.
 * @param {boolean} [options.enabled=true] When false, the governor gate is
 *   skipped; the pre-execute hook still attaches when a `pressure` guard is
 *   configured, so pressure can be enforced on its own.
 * @param {{ check: (input: { session?: object }) => object }} [options.pressure]
 *   Optional context-pressure guard from `createPressureGuard`. It runs after
 *   the governor admission and before `next()`; a denial short-circuits the
 *   call and is reported as `{ kind: 'deny', allow: false, reason }`.
 * @param {(call: object) => object | undefined} [options.sessionOf] Optional
 *   resolver for the Session passed to the pressure guard. Defaults to
 *   `call.session`, then `call.agent.session` (the DSH `ToolExecution` shape).
 * @param {(() => number | Date) | number | Date} [options.now] Clock override
 *   for status timestamps; intended for tests and embedding.
 * @param {object} [config] Optional second settings object, accepted for hosts
 *   that pass the plugin config separately; same keys as `options`.
 * @returns {{
 *   preExecute: (call: object, next?: () => Promise<unknown>) => Promise<unknown>,
 *   attach: (ctx: object) => object,
 *   detach: () => object,
 *   status: () => object,
 *   governor: object,
 *   readonly pressure: object | null,
 *   readonly attached: boolean,
 *   readonly enabled: boolean,
 * }}
 */
export function createEnforcer(options = {}, config = undefined) {
  if (!isObject(options)) throw new TypeError('createEnforcer options must be an object')
  // Accept the adapter settings at the top level, under `config`, or as a
  // second argument, so the same factory works directly and from a Cordis
  // plugin config object.
  const base = isObject(options.config) ? { ...options.config, ...options } : { ...options }
  const settings = isObject(config) ? { ...base, ...config } : base
  const governor = options.governor ?? settings.governor
  if (!isObject(governor) || typeof governor.admit !== 'function') {
    throw new TypeError('createEnforcer requires governor.admit()')
  }
  if (governor.consume !== undefined && typeof governor.consume !== 'function') {
    throw new TypeError('governor.consume must be a function when present')
  }
  if (settings.onDeny !== undefined && settings.onDeny !== null && typeof settings.onDeny !== 'function') {
    throw new TypeError('onDeny must be a function')
  }
  if (settings.costOf !== undefined && settings.costOf !== null
    && typeof settings.costOf !== 'function' && !isObject(settings.costOf)) {
    throw new TypeError('costOf must be a function or an object map')
  }
  if (settings.scope !== undefined && settings.scope !== null
    && typeof settings.scope !== 'string' && typeof settings.scope !== 'function') {
    throw new TypeError('scope must be a string or a function')
  }
  const pressure = settings.pressure ?? null
  if (pressure !== null && (!isObject(pressure) || typeof pressure.check !== 'function')) {
    throw new TypeError('pressure must be an object with check({ session })')
  }
  if (settings.sessionOf !== undefined && settings.sessionOf !== null
    && typeof settings.sessionOf !== 'function') {
    throw new TypeError('sessionOf must be a function')
  }

  const onDeny = settings.onDeny ?? null
  const costOf = settings.costOf ?? null
  const scopeOption = settings.scope ?? null
  const throwOnDeny = settings.throwOnDeny === true
  const enabled = settings.enabled !== false
  const sessionOf = typeof settings.sessionOf === 'function' ? settings.sessionOf : sessionOfCall
  const clock = createClock(settings.now)
  /** @type {Set<string>} */
  const ignoreNames = new Set(Array.isArray(settings.ignore)
    ? settings.ignore.filter((name) => typeof name === 'string' && name !== '')
    : [])

  /** @type {Map<string, { scope: string, name: string }>} */
  const pendingCalls = new Map()
  /** @type {Map<string, true>} */
  const consumedCallIds = new Map()
  /** @type {string[]} */
  const consumedOrder = []
  /** @type {WeakSet<object>} */
  const consumedResults = new WeakSet()

  const counters = {
    preExecute: 0,
    allowed: 0,
    denied: 0,
    degraded: 0,
    bypassed: 0,
    errors: 0,
    results: 0,
    consumed: 0,
    skipped: 0,
    duplicates: 0,
    tokensConsumed: 0,
    jobsConsumed: 0,
    diskMbConsumed: 0,
  }

  /** @type {object | null} */
  let last = null
  /** @type {string | null} */
  let lastError = null

  /** @type {object | null} */
  let attachedCtx = null
  let attached = false
  const hookFlags = { preExecute: false, result: false }
  /** @type {Array<() => void>} */
  let disposers = []

  /**
   * @param {object} entry
   * @returns {void}
   */
  function recordLast(entry) {
    last = { ...entry, at: clock() }
  }

  /**
   * @param {unknown} error
   * @returns {string}
   */
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error)
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  function isIgnored(name) {
    if (name === '') return false
    if (ignoreNames.has('*') || ignoreNames.has(name)) return true
    return name.startsWith(QUOTA_TOOL_PREFIX)
  }

  /**
   * Resolve the budget scope for one execution.
   * @param {unknown} call
   * @returns {string}
   */
  function resolveScope(call) {
    if (typeof scopeOption === 'function') {
      try {
        const fromResolver = nonEmptyString(scopeOption(call))
        if (fromResolver !== null) return fromResolver
      } catch (error) {
        counters.errors += 1
        lastError = errorMessage(error)
      }
    }
    const configured = nonEmptyString(scopeOption)
    if (configured !== null) return configured
    if (isObject(call)) {
      const direct = nonEmptyString(call.scope)
      if (direct !== null) return direct
      const args = isObject(call.arguments) ? call.arguments : isObject(call.args) ? call.args : null
      const fromArgs = args === null ? null : nonEmptyString(args.scope)
      if (fromArgs !== null) return fromArgs
    }
    return DEFAULT_SCOPE
  }

  /**
   * Estimate the cost of a call, in precedence order: configured estimator,
   * the call's own `cost`/`estimate`, then direct numeric fields on the call.
   * @param {object} call
   * @param {string} name
   * @returns {Usage}
   */
  function estimateCost(call, name) {
    let configured
    try {
      if (typeof costOf === 'function') configured = costOf(name, call)
      else if (isObject(costOf)) configured = Object.hasOwn(costOf, name) ? costOf[name] : costOf['*']
    } catch (error) {
      counters.errors += 1
      lastError = errorMessage(error)
    }
    let cost = mergeCost({ tokens: 0, jobs: 0, diskMb: 0 }, configured)
    cost = mergeCost(cost, isObject(call) ? call.cost ?? call.estimate ?? call.estimatedCost : undefined)
    if (isObject(call)) {
      for (const dim of /** @type {readonly Dimension[]} */ (['tokens', 'jobs', 'diskMb'])) {
        if (Object.hasOwn(call, dim)) cost[dim] = estimateAmount(call[dim])
      }
    }
    return cost
  }

  /**
   * @param {object} call
   * @param {string} scope
   * @param {string} name
   * @returns {void}
   */
  function rememberCall(call, scope, name) {
    const callId = callIdOf(call)
    if (callId === null) return
    pendingCalls.delete(callId)
    pendingCalls.set(callId, { scope, name })
    if (pendingCalls.size <= MAX_TRACKED_CALLS) return
    const oldest = pendingCalls.keys().next().value
    if (oldest !== undefined) pendingCalls.delete(oldest)
  }

  /**
   * @param {string | null} callId
   * @param {unknown} result
   * @returns {boolean} True when this outcome was already booked.
   */
  function markConsumed(callId, result) {
    if (callId !== null) {
      if (consumedCallIds.has(callId)) return true
      consumedCallIds.set(callId, true)
      consumedOrder.push(callId)
      if (consumedOrder.length > MAX_TRACKED_CALLS) {
        const oldest = consumedOrder.shift()
        if (oldest !== undefined) consumedCallIds.delete(oldest)
      }
    }
    if (isObject(result)) {
      if (consumedResults.has(result)) return true
      consumedResults.add(result)
    }
    return false
  }

  /**
   * Add `degrade: true` to an allow decision without touching a downstream
   * deny/ask/cancel.
   * @param {unknown} result
   * @returns {unknown}
   */
  function markDegraded(result) {
    if (!isObject(result)) return { kind: 'allow', allow: true, degrade: true }
    if (result.allow === false) return result
    if (result.kind !== undefined && result.kind !== 'allow') return result
    return { ...result, kind: 'allow', allow: true, degrade: true }
  }

  /**
   * Run the configured context-pressure guard. A broken/missing guard fails
   * open (the governor gate, when enabled, is still authoritative), matching
   * the adapter's "observability failures must not brick the host" rule.
   * @param {object} call
   * @returns {object | null} The denial verdict, or null to allow.
   */
  function checkPressure(call) {
    if (pressure === null) return null
    let session
    try {
      session = sessionOf(call)
    } catch (error) {
      counters.errors += 1
      lastError = errorMessage(error)
      return null
    }
    let verdict
    try {
      verdict = pressure.check({ session })
    } catch (error) {
      counters.errors += 1
      lastError = errorMessage(error)
      return null
    }
    if (!isObject(verdict)) return null
    return verdict.allow === false || verdict.kind === 'deny' ? verdict : null
  }

  /**
   * The `tools/pre-execute` waterfall listener.
   * @param {object} call
   * @param {() => Promise<unknown>} [next]
   * @returns {Promise<unknown>}
   */
  async function preExecute(call, next) {
    const proceed = typeof next === 'function' ? next : () => Promise.resolve({ kind: 'allow' })
    if ((!enabled && pressure === null) || !isObject(call)) return proceed()
    const name = toolNameOf(call)
    if (isIgnored(name)) {
      counters.bypassed += 1
      recordLast({ kind: 'bypass', tool: name })
      return proceed()
    }

    const scope = resolveScope(call)
    /** @type {object | null} */
    let decision = null

    if (enabled) {
      const cost = estimateCost(call, name)
      try {
        decision = governor.admit({ scope, ...cost })
      } catch (error) {
        // Fail open: a broken estimator/policy must not brick the host. When a
        // pressure guard is configured, it still gets its independent check.
        counters.errors += 1
        lastError = errorMessage(error)
        recordLast({ kind: 'error', tool: name, scope, error: lastError })
        if (pressure === null) return proceed()
      }

      counters.preExecute += 1
      if (decision?.level === 'hard' || decision?.allowed === false) {
        counters.denied += 1
        const reason = describeDenial(decision, call, name)
        const denial = new QuotaDeniedError(decision, { reason, call, tool: name })
        recordLast({ kind: 'deny', tool: name, scope, level: 'hard', reason })
        if (onDeny !== null) {
          try {
            onDeny(decision, call, denial)
          } catch (error) {
            counters.errors += 1
            lastError = errorMessage(error)
          }
        }
        if (throwOnDeny) throw denial
        return { kind: 'deny', allow: false, reason }
      }
    } else {
      counters.preExecute += 1
    }

    if (pressure !== null) {
      const verdict = checkPressure(call)
      if (verdict !== null) {
        counters.denied += 1
        const reason = nonEmptyString(verdict.reason) ?? 'pressure'
        const denial = new QuotaDeniedError(
          isObject(decision) ? decision : { scope, level: 'hard' },
          { reason, call, tool: name },
        )
        recordLast({ kind: 'deny', tool: name, scope, level: 'hard', reason })
        if (onDeny !== null) {
          try {
            onDeny(verdict, call, denial)
          } catch (error) {
            counters.errors += 1
            lastError = errorMessage(error)
          }
        }
        if (throwOnDeny) throw denial
        return { kind: 'deny', allow: false, reason }
      }
    }

    const degraded = enabled && (decision?.degrade === true || decision?.level === 'soft')
    counters.allowed += 1
    if (degraded) counters.degraded += 1
    if (enabled) rememberCall(call, scope, name)
    recordLast({
      kind: degraded ? 'degrade' : 'allow',
      tool: name,
      scope,
      level: isObject(decision) ? decision.level ?? 'ok' : 'ok',
    })
    const downstream = await proceed()
    return degraded ? markDegraded(downstream) : downstream
  }

  /**
   * Normalize the two supported result-listener signatures: DSH's
   * `(exec, result)` and a lighter single event/result object.
   * @param {unknown[]} args
   * @returns {{ exec: object | null, result: object | null }}
   */
  function normalizeResultArgs(args) {
    if (args.length >= 2 && isObject(args[0]) && isObject(args[1])) {
      return { exec: args[0], result: args[1] }
    }
    const only = args[0]
    if (!isObject(only)) return { exec: null, result: null }
    if (isObject(only.result)) {
      return { exec: isObject(only.exec) ? only.exec : isObject(only.execution) ? only.execution : only, result: only.result }
    }
    return { exec: only, result: only }
  }

  /**
   * Book a result's reported usage exactly once. Called by `tools/result`,
   * the compatibility `tool/result` Cordis event, and the durable
   * `session/event` observer.
   * @param {object | null} exec
   * @param {object | null} result
   * @returns {void}
   */
  function consumeResult(exec, result) {
    counters.results += 1
    // Usage must come from the result, never from the call's admission
    // estimate; otherwise an estimate would be booked as if it were reality.
    const usage = findUsage(result)
    if (usage === null) {
      counters.skipped += 1
      recordLast({ kind: 'skip', tool: toolNameOf(exec) || toolNameOf(result), reason: 'no usage.tokens' })
      return
    }
    const callId = callIdOf(result) ?? callIdOf(exec)
    if (markConsumed(callId, result)) {
      counters.duplicates += 1
      return
    }
    const pending = callId === null ? undefined : pendingCalls.get(callId)
    const scope = pending?.scope ?? resolveScope(exec ?? result)
    const name = pending?.name || toolNameOf(exec) || toolNameOf(result) || 'tool'
    if (typeof governor.consume !== 'function') {
      counters.errors += 1
      lastError = 'governor.consume() is not available'
      recordLast({ kind: 'error', tool: name, scope, error: lastError })
      return
    }
    try {
      governor.consume({ scope, ...usage })
      counters.consumed += 1
      counters.tokensConsumed += usage.tokens
      counters.jobsConsumed += usage.jobs
      counters.diskMbConsumed += usage.diskMb
      recordLast({ kind: 'consume', tool: name, scope, tokens: usage.tokens })
    } catch (error) {
      counters.errors += 1
      lastError = errorMessage(error)
      recordLast({ kind: 'error', tool: name, scope, error: lastError })
    } finally {
      if (callId !== null) pendingCalls.delete(callId)
    }
  }

  /** @param {...unknown} args */
  function onToolResult(...args) {
    if (!attached) return
    const { exec, result } = normalizeResultArgs(args)
    if (exec === null && result === null) return
    consumeResult(exec, result)
  }

  /**
   * Durable session events are the correct place to observe `tool/result` in
   * DSH; the payload may carry `meta.usage`.
   * @param {unknown} _session
   * @param {object} event
   * @returns {void}
   */
  function onSessionEvent(_session, event) {
    if (!attached || !isObject(event) || event.type !== 'tool/result') return
    consumeResult(event, event)
  }

  /**
   * Register one listener and normalize Cordis's disposer shapes.
   * @param {Function} on
   * @param {string} name
   * @param {Function} handler
   * @returns {(() => void) | null}
   */
  function subscribe(on, name, handler) {
    const call = on.bind(attachedCtx)
    let off
    try {
      off = call(name, handler)
    } catch (error) {
      counters.errors += 1
      lastError = errorMessage(error)
      return null
    }
    hookFlags[name === 'tools/pre-execute' ? 'preExecute' : 'result'] = true
    if (typeof off === 'function') return () => { off() }
    if (isObject(off) && typeof off.dispose === 'function') return () => { off.dispose() }
    if (isObject(off) && typeof off[Symbol.dispose] === 'function') return () => { off[Symbol.dispose]() }
    if (isObject(attachedCtx) && typeof attachedCtx.off === 'function') {
      return () => { attachedCtx.off(name, handler) }
    }
    return null
  }

  /**
   * Fallback seam for hosts that expose `ctx.tools.preExecute(handler)` instead
   * of the Cordis event bus.
   * @param {object} tools
   * @param {Function} handler
   * @returns {(() => void) | null}
   */
  function subscribeToolsPre(tools, handler) {
    let off
    try {
      off = tools.preExecute(handler)
    } catch (error) {
      counters.errors += 1
      lastError = errorMessage(error)
      return null
    }
    hookFlags.preExecute = true
    if (typeof off === 'function') return () => { off() }
    if (isObject(off) && typeof off.dispose === 'function') return () => { off.dispose() }
    if (isObject(off) && typeof off[Symbol.dispose] === 'function') return () => { off[Symbol.dispose]() }
    if (typeof tools.removePreExecute === 'function') return () => { tools.removePreExecute(handler) }
    if (isObject(tools) && typeof tools.off === 'function') return () => { tools.off('pre-execute', handler) }
    return null
  }

  /**
   * Attach the pre-execute gate and the usage consumer. Calling `attach` twice
   * is idempotent; attaching to a different context detaches first.
   * @param {object} ctx
   * @returns {object} The enforcer, for chaining.
   */
  function attach(ctx) {
    if (!enabled && pressure === null) return enforcer
    if (!isObject(ctx)) throw new TypeError('attach(ctx) requires a context object')
    if (attached && attachedCtx === ctx) return enforcer
    if (attached) detach()

    attachedCtx = ctx
    const on = typeof ctx.on === 'function' ? ctx.on : null
    /** @type {Array<(() => void) | null>} */
    const registered = []

    if (on !== null) {
      registered.push(subscribe(on, 'tools/pre-execute', preHandler))
      if (enabled) {
        registered.push(subscribe(on, 'tools/result', onToolResult))
        // The task brief names the singular event; hosts that expose it get the
        // same handler. It is inert (never fired) on a stock DSH event bus.
        registered.push(subscribe(on, 'tool/result', onToolResult))
        // DSH's durable `tool/result` is a session event, not a Cordis event.
        registered.push(subscribe(on, 'session/event', onSessionEvent))
      }
    }
    if (!hookFlags.preExecute && isObject(ctx.tools) && typeof ctx.tools.preExecute === 'function') {
      registered.push(subscribeToolsPre(ctx.tools, preHandler))
    }

    disposers = registered.filter((dispose) => dispose !== null)
    attached = hookFlags.preExecute || hookFlags.result
    if (attached) lastError = null
    else {
      lastError = 'no tools/pre-execute hook available on this context'
      if (isObject(ctx.logger) && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`[dsh-os-quota] ${lastError}; the gate is configured but inert`)
      }
    }
    return enforcer
  }

  /**
   * Remove every listener registered by {@link attach}. Safe to call when
   * detached or when a host returned no disposer: the handlers also check
   * `attached` and delegate immediately.
   * @returns {object} The enforcer, for chaining.
   */
  function detach() {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch (error) {
        lastError = errorMessage(error)
      }
    }
    attached = false
    attachedCtx = null
    hookFlags.preExecute = false
    hookFlags.result = false
    pendingCalls.clear()
    return enforcer
  }

  /**
   * Read-only enforcement state for `quota_enforce_status`.
   * @returns {object}
   */
  function status() {
    return {
      enabled,
      enforce: enabled,
      attached,
      hooks: { preExecute: hookFlags.preExecute, result: hookFlags.result },
      policy: {
        scope: typeof scopeOption === 'string' ? scopeOption : null,
        costOf: costOf !== null,
        ignore: [...ignoreNames],
        quotaToolsIgnored: true,
        throwOnDeny,
        pressure: pressure !== null,
        governor: enabled,
      },
      counters: { ...counters },
      last: last === null ? null : { ...last },
      lastError,
      pending: pendingCalls.size,
      pressure: pressure === null ? null : pressure.status(),
    }
  }

  /**
   * @param {object} call
   * @param {Function} [next]
   * @returns {Promise<unknown>}
   */
  function preHandler(call, next) {
    if (!attached) return typeof next === 'function' ? next() : Promise.resolve({ kind: 'allow' })
    return preExecute(call, next)
  }

  const enforcer = {
    preExecute,
    attach,
    detach,
    status,
    governor,
    get pressure() { return pressure },
    get attached() { return attached },
    get enabled() { return enabled },
  }
  return enforcer
}
