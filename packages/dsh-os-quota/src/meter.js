/**
 * Automatic session-usage metering for dsh-os-quota.
 *
 * DSH publishes every committed session event on `session/event`. When a model
 * step settles, `assistant/message` carries the provider's `usage` in the event
 * payload, and a failed/retried `assistant/attempt` keeps its usage in the
 * embedded stream. This module turns those records into `governor.consume`
 * bookings without reading prompt content or replaying the session log:
 *
 * - only `assistant/message` and `assistant/attempt` are considered;
 * - `usage.totalTokens` wins when present, otherwise the disjoint buckets are
 *   summed (`inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`);
 * - events without usable usage are skipped, never estimated;
 * - one booking per `sessionId + turn + step + type`;
 * - an event missing its scope or the turn/step identity is skipped.
 *
 * The module imports nothing from `@deepseek-ai/*`; tests drive it with a fake
 * Cordis-like context. It is accounting only: it never denies a request, and it
 * does not read `@deepseek-ai/dsh-token-meter` pressure or interrupt a loop.
 */

/** Event types that can settle a model call and carry token usage. */
export const METER_EVENT_TYPES = Object.freeze(['assistant/message', 'assistant/attempt'])

/** Dedupe identity documented on `quota_meter_status`. */
export const METER_DEDUPE_KEY = 'sessionId+turn+step+type'

/** Bound for dedupe bookkeeping so a long-lived process cannot grow forever. */
const MAX_TRACKED_KEYS = 4096

/**
 * @typedef {{ tokens: number, jobs: number, diskMb: number }} Usage
 * @typedef {import('./core.js').Governor} Governor
 */

/** @param {unknown} value @returns {boolean} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string | null} */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * A token bucket count: finite and non-negative. `null` marks an unusable
 * value so callers can distinguish a real 0 from a missing bucket.
 * @param {unknown} value
 * @returns {number | null}
 */
function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Optional cache buckets collapse to 0 when absent, but an explicitly malformed
 * value invalidates the sample instead of silently undercounting it.
 * @param {unknown} value
 * @returns {number | null}
 */
function optionalCountOf(value) {
  if (value === undefined || value === null) return 0
  return countOf(value)
}

/**
 * Resolve the token charge for one usage sample.
 *
 * `TokenUsage` buckets are disjoint: inputTokens is uncached input, cache
 * reads/writes are separate input buckets, and outputTokens is generation.
 * `totalTokens`, when the adapter reports it, is the authoritative full-call
 * total, so it wins over the sum.
 *
 * @param {unknown} usage
 * @returns {number | null} `null` when no usable token count exists.
 */
export function tokensOfUsage(usage) {
  if (!isObject(usage)) return null
  const total = countOf(usage.totalTokens)
  if (total !== null) return total
  const input = countOf(usage.inputTokens)
  const output = countOf(usage.outputTokens)
  if (input === null || output === null) return null
  const cacheRead = optionalCountOf(usage.cacheReadTokens)
  const cacheWrite = optionalCountOf(usage.cacheWriteTokens)
  if (cacheRead === null || cacheWrite === null) return null
  return input + output + cacheRead + cacheWrite
}

/**
 * The `session/event` payload is the logged `SessionEvent` (`{ type, data }`),
 * but lightweight hosts/tests may hand the data payload directly. Treat both
 * shapes alike.
 * @param {unknown} event
 * @returns {object | null}
 */
function dataOfEvent(event) {
  if (!isObject(event)) return null
  return isObject(event.data) ? event.data : event
}

/**
 * Find the usage sample for one assistant settlement. A committed
 * `assistant/message` keeps usage at the top level; an `assistant/attempt`
 * without a surface message retains it in the compact provider stream, so the
 * last stream usage chunk is the fallback.
 * @param {object} event
 * @param {object} data
 * @returns {object | null}
 */
function usageOfEvent(event, data) {
  if (isObject(data.usage)) return data.usage
  if (isObject(event.usage)) return event.usage
  const stream = Array.isArray(data.stream)
    ? data.stream
    : Array.isArray(event.stream)
      ? event.stream
      : null
  if (stream === null) return null
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const chunk = stream[index]
    if (isObject(chunk) && isObject(chunk.usage)) return chunk.usage
  }
  return null
}

/**
 * Resolve a numeric turn/step. Both are required for the dedupe identity.
 * @param {unknown} value
 * @returns {number | null}
 */
function positionOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Attach automatic token metering to a DSH context.
 *
 * `ctx.on('session/event', handler)` is the only subscription. It is both an
 * observer feed (post-commit) and the same event stream the session uses for
 * durable replay, so no log file or token-meter service is read.
 *
 * @param {object} ctx Cordis context exposing `on(event, handler)`.
 * @param {object} options
 * @param {Governor} options.governor Ledger that receives `consume({scope, tokens})`.
 * @param {((session: object) => string) | undefined} [options.scopeOf]
 *   Optional scope resolver. When it returns a non-empty string it wins;
 *   otherwise the session id is used. Exceptions fail over to the session id.
 * @param {(() => number | Date) | number | Date} [options.now]
 *   Clock override for the `at` timestamp in `stats.last`; intended for
 *   embedding and tests.
 * @returns {{ detach: () => object, readonly stats: object }}
 */
export function attachTokenMeter(ctx, options = {}) {
  if (!isObject(ctx) || typeof ctx.on !== 'function') {
    throw new TypeError('attachTokenMeter(ctx, ...) requires a context with on()')
  }
  if (!isObject(options)) throw new TypeError('attachTokenMeter options must be an object')
  const { governor } = options
  if (!isObject(governor) || typeof governor.consume !== 'function') {
    throw new TypeError('attachTokenMeter requires governor.consume()')
  }
  const scopeOf = typeof options.scopeOf === 'function' ? options.scopeOf : null
  const clock = createClock(options.now)

  const counters = {
    /** Every event delivered on `session/event`. */
    events: 0,
    /** Events whose type is `assistant/message` or `assistant/attempt`. */
    assistantEvents: 0,
    /** Successful `governor.consume` bookings. */
    consumed: 0,
    /** Repeated `sessionId + turn + step + type` identities. */
    duplicates: 0,
    /** Assistant events without usable usage/identity/scope. */
    skipped: 0,
    /** Listener/consume/scope resolver failures (contained). */
    errors: 0,
    /** Tokens booked by this meter. */
    tokens: 0,
  }

  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {string[]} */
  const seenOrder = []
  /** @type {Set<string>} */
  const sessions = new Set()

  /**
   * Live read-only stats object. `counters` is the same mutable object the
   * listener updates, so both `meter.stats.consumed` and a destructured
   * `stats` stay current. Treat it as read-only: it is observation, not
   * configuration.
   */
  const stats = {
    attached: true,
    eventTypes: METER_EVENT_TYPES,
    dedupeKey: METER_DEDUPE_KEY,
    scopeSource: scopeOf === null ? 'session.id' : 'scopeOf(session)',
    counters,
    sessions: 0,
    last: /** @type {object | null} */ (null),
    lastError: /** @type {string | null} */ (null),
  }
  let attached = true
  /** @type {(() => void) | null} */
  let disposer = null

  /**
   * @param {object} entry
   * @returns {void}
   */
  function recordLast(entry) {
    stats.last = { ...entry, at: clock() }
  }

  /**
   * @param {string} reason
   * @param {object} [fields]
   * @returns {void}
   */
  function skip(reason, fields = {}) {
    counters.skipped += 1
    recordLast({ kind: 'skip', reason, ...fields })
  }

  /**
   * Use `scopeOf(session)` when it yields a usable id, otherwise the session
   * id. A resolver failure is counted but must not stop accounting.
   * @param {object} session
   * @returns {string | null}
   */
  function resolveScope(session) {
    if (scopeOf !== null) {
      try {
        const resolved = nonEmptyString(scopeOf(session))
        if (resolved !== null) return resolved
      } catch (error) {
        counters.errors += 1
        stats.lastError = errorMessage(error)
      }
    }
    return nonEmptyString(session?.id)
  }

  /**
   * Return true when this identity was already booked. The bounded insertion
   * order keeps memory flat while still catching duplicate publications of
   * recent events.
   * @param {string} key
   * @returns {boolean}
   */
  function isDuplicate(key) {
    if (seen.has(key)) return true
    seen.add(key)
    seenOrder.push(key)
    if (seenOrder.length > MAX_TRACKED_KEYS) {
      const oldest = seenOrder.shift()
      if (oldest !== undefined) seen.delete(oldest)
    }
    return false
  }

  /**
   * The `session/event` listener.
   * @param {object} session
   * @param {object} event
   * @returns {void}
   */
  function onSessionEvent(session, event) {
    if (!attached) return
    counters.events += 1
    if (!isObject(event)) {
      counters.skipped += 1
      recordLast({ kind: 'skip', reason: 'missing event' })
      return
    }
    const type = nonEmptyString(event.type)
    if (type === null || !METER_EVENT_TYPES.includes(type)) return
    counters.assistantEvents += 1

    const data = dataOfEvent(event)
    if (data === null) {
      skip('missing event data', { type })
      return
    }

    const scope = resolveScope(session)
    if (scope === null) {
      skip('missing session.id/scope', { type })
      return
    }
    const sessionId = nonEmptyString(session?.id) ?? scope
    const turn = positionOf(data.turn) ?? positionOf(event.turn)
    const step = positionOf(data.step) ?? positionOf(event.step)
    if (turn === null) {
      skip('missing turn', { type, sessionId, scope })
      return
    }
    if (step === null) {
      skip('missing step', { type, sessionId, scope })
      return
    }

    const usage = usageOfEvent(event, data)
    if (usage === null) {
      skip('missing usage', { type, sessionId, scope, turn, step })
      return
    }
    const tokens = tokensOfUsage(usage)
    if (tokens === null) {
      skip('invalid usage', { type, sessionId, scope, turn, step })
      return
    }

    const key = `${sessionId}|${turn}|${step}|${type}`
    if (isDuplicate(key)) {
      counters.duplicates += 1
      recordLast({ kind: 'duplicate', type, sessionId, scope, turn, step, tokens })
      return
    }

    try {
      const decision = governor.consume({ scope, tokens })
      counters.consumed += 1
      counters.tokens += tokens
      sessions.add(sessionId)
      stats.sessions = sessions.size
      recordLast({
        kind: 'consume',
        type,
        sessionId,
        scope,
        turn,
        step,
        tokens,
        level: isObject(decision) && typeof decision.level === 'string' ? decision.level : undefined,
      })
    } catch (error) {
      counters.errors += 1
      stats.lastError = errorMessage(error)
      recordLast({ kind: 'error', type, sessionId, scope, turn, step, error: stats.lastError })
    }
  }

  try {
    const off = ctx.on('session/event', onSessionEvent)
    if (typeof off === 'function') {
      disposer = () => { off() }
    } else if (isObject(off) && typeof off.dispose === 'function') {
      disposer = () => { off.dispose() }
    } else if (isObject(off) && typeof off[Symbol.dispose] === 'function') {
      disposer = () => { off[Symbol.dispose]() }
    } else if (typeof ctx.off === 'function') {
      disposer = () => { ctx.off('session/event', onSessionEvent) }
    }
  } catch (error) {
    attached = false
    stats.attached = false
    counters.errors += 1
    stats.lastError = errorMessage(error)
  }

  /**
   * Remove the subscription and stop booking. Idempotent, and safe when the
   * host returned no disposer (the handler also checks `attached`).
   * @returns {object} The meter, for chaining.
   */
  function detach() {
    const dispose = disposer
    disposer = null
    attached = false
    stats.attached = false
    if (dispose !== null) {
      try {
        dispose()
      } catch (error) {
        stats.lastError = errorMessage(error)
      }
    }
    return meter
  }

  const meter = { detach, stats }
  return meter
}
