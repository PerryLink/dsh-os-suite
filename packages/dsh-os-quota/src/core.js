/**
 * Pure ledger and admission-control core for dsh-os-quota.
 *
 * This module deliberately imports nothing from DSH packages: it can be
 * unit-tested offline with `node --test`, embedded in another host, or driven
 * from a script. All time comes from an injectable clock.
 *
 * Semantics in one paragraph:
 * - A scope owns three independent budgets: tokens, jobs and diskMb.
 * - `admit()` is a read-only projection ("may I spend this?") and never
 *   mutates the ledger. It reports `ok`, `soft` (allowed, but degraded) or
 *   `hard` (denied).
 * - `consume()` books actual usage. It always accumulates, even past a hard
 *   limit, because actual usage already happened; it reports the overage in
 *   `overBy` and returns `allowed: false`.
 * - Limits are inclusive: spending exactly up to the limit is allowed.
 *   `Infinity` (or `null` in snapshots/config input) means unlimited.
 * - `windowStartedAt` is an epoch-millisecond timestamp. `resetWindow()`
 *   zeroes usage; an optional `windowMs` rolls windows lazily on access.
 */

/** @typedef {'tokens' | 'jobs' | 'diskMb'} Dimension */

/**
 * Per-dimension amounts. `Infinity` encodes "unlimited" (serialized as `null`
 * by the tool layer, because JSON has no Infinity).
 * @typedef {{ tokens: number, jobs: number, diskMb: number }} Usage
 */

/**
 * @typedef {object} Scope
 * @property {string} id
 * @property {Usage} limits
 * @property {Usage} used
 * @property {number} windowStartedAt Epoch milliseconds.
 */

/**
 * @typedef {object} Request
 * @property {string | Scope} [scope] Scope id (or a Scope-shaped object); defaults to `"default"`.
 * @property {number} [tokens]
 * @property {number} [jobs]
 * @property {number} [diskMb]
 */

/**
 * @typedef {object} Status
 * @property {string} scope
 * @property {Usage} limits
 * @property {Usage} used
 * @property {Usage} remaining Never negative; `Infinity` when unlimited.
 * @property {Usage} overBy Used amount above each limit (0 when under).
 * @property {{ tokens: number | null, jobs: number | null, diskMb: number | null }} utilization
 *   Fraction used, `null` when unlimited, `Infinity` when limit is 0 but usage is not.
 * @property {'ok' | 'soft' | 'hard'} level
 * @property {boolean} allowed False only at `hard`.
 * @property {boolean} degrade True only at `soft` (allowed but degraded).
 * @property {string[]} exceeded Dimensions above their hard limit.
 * @property {string[]} degraded Dimensions above their soft threshold.
 * @property {number} softRatio
 * @property {number} windowStartedAt Epoch milliseconds.
 * @property {string | null} windowStartedAtIso
 * @property {number} windowAgeMs
 */

/**
 * Result of an admission projection or a consumption booking.
 * @typedef {object} Decision
 * @property {string} scope
 * @property {boolean} allowed
 * @property {'ok' | 'soft' | 'hard'} level
 * @property {'ok' | 'soft-limit' | 'hard-limit'} reason
 * @property {boolean} degrade True only for an allowed `soft` decision.
 * @property {Usage} remaining After the requested amount (admit) or after booking (consume).
 * @property {Usage} overBy
 * @property {Usage} used Usage before the request (admit) / after booking (consume).
 * @property {Usage} projected Proposed usage (admit) / booked usage (consume).
 * @property {Usage} request Normalized non-negative request.
 * @property {Usage} limits
 * @property {string[]} exceeded
 * @property {string[]} degraded
 * @property {number} softRatio
 * @property {number} windowStartedAt
 * @property {number} timestamp Epoch milliseconds from the injected clock.
 */

/**
 * Governor instance returned by {@link createGovernor}.
 * @typedef {object} Governor
 * @property {(scope: string | Scope, limits: Partial<Usage> | null) => Status & { changed: Dimension[] }} setLimits
 * @property {(request?: Request) => Decision} admit
 * @property {(request?: Request) => Decision} consume
 * @property {(scope?: string | Scope) => Status} status
 * @property {(scope?: string | Scope) => Status & { reset: true, previousUsed: Usage, previousWindowStartedAt: number }} resetWindow
 * @property {() => Status[]} list
 * @property {number} softRatio
 * @property {number} windowMs Infinity when windows never roll automatically.
 */

/** @type {readonly Dimension[]} */
export const DIMENSIONS = Object.freeze(['tokens', 'jobs', 'diskMb'])

/** Soft threshold used when the caller does not override it. */
export const DEFAULT_SOFT_RATIO = 0.8

const UNLIMITED = Number.POSITIVE_INFINITY

/** @returns {Usage} */
function emptyUsage() {
  return { tokens: 0, jobs: 0, diskMb: 0 }
}

/** @returns {Usage} */
function unlimitedLimits() {
  return { tokens: UNLIMITED, jobs: UNLIMITED, diskMb: UNLIMITED }
}

/**
 * Clamp a limit to a usable value. `null`/`undefined` and `Infinity` mean
 * unlimited; negative, NaN and non-number values collapse to 0 (a closed
 * budget) instead of corrupting ledger arithmetic.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeLimit(value) {
  if (value === null || value === undefined) return UNLIMITED
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  if (value < 0) return 0
  return value
}

/**
 * Clamp a requested amount to a non-negative finite number. This is the
 * "usage can never go negative" invariant: bad input books 0, not a refund.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Merge a partial set of limits over a base object.
 * `null` explicitly means unlimited; `undefined` means "leave unchanged".
 * @param {Usage} base
 * @param {Partial<Usage> | null | undefined} patch
 * @returns {Usage}
 */
function mergeLimits(base, patch) {
  /** @type {Usage} */
  const out = { ...base }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return out
  for (const dim of DIMENSIONS) {
    if (!Object.hasOwn(patch, dim)) continue
    if (patch[dim] === undefined) continue
    out[dim] = normalizeLimit(patch[dim])
  }
  return out
}

/**
 * Normalize a partial usage object (seed data) into a full non-negative Usage.
 * @param {Partial<Usage> | null | undefined} input
 * @returns {Usage}
 */
function normalizeUsage(input) {
  /** @type {Usage} */
  const out = emptyUsage()
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out
  for (const dim of DIMENSIONS) {
    if (!Object.hasOwn(input, dim)) continue
    out[dim] = normalizeAmount(input[dim])
  }
  return out
}

/**
 * Normalize the three optional request dimensions.
 * @param {Request} request
 * @returns {Usage}
 */
function normalizeRequest(request) {
  return {
    tokens: normalizeAmount(request.tokens),
    jobs: normalizeAmount(request.jobs),
    diskMb: normalizeAmount(request.diskMb),
  }
}

/**
 * @param {Usage} left
 * @param {Usage} right
 * @returns {Usage}
 */
function addUsage(left, right) {
  return {
    tokens: left.tokens + right.tokens,
    jobs: left.jobs + right.jobs,
    diskMb: left.diskMb + right.diskMb,
  }
}

/**
 * Classify a usage vector against limits.
 * - hard: any dimension strictly above its limit.
 * - soft: no hard overage, but some dimension strictly above ratio * limit.
 * - ok: otherwise. Exact equality with a limit is not hard (spending up to the
 *   limit is allowed).
 * @param {Usage} used
 * @param {Usage} limits
 * @param {number} softRatio
 * @returns {{ level: 'ok' | 'soft' | 'hard', exceeded: Dimension[], degraded: Dimension[] }}
 */
function classify(used, limits, softRatio) {
  /** @type {Dimension[]} */
  const exceeded = []
  /** @type {Dimension[]} */
  const degraded = []
  /** @type {'ok' | 'soft' | 'hard'} */
  let level = 'ok'
  for (const dim of DIMENSIONS) {
    const limit = limits[dim]
    if (!Number.isFinite(limit)) continue
    const value = used[dim]
    if (value > limit) {
      exceeded.push(dim)
      level = 'hard'
    } else if (value > limit * softRatio) {
      degraded.push(dim)
      if (level === 'ok') level = 'soft'
    }
  }
  return { level, exceeded, degraded }
}

/**
 * @param {Usage} used
 * @param {Usage} limits
 * @returns {Usage}
 */
function remainingOf(used, limits) {
  /** @type {Usage} */
  const out = emptyUsage()
  for (const dim of DIMENSIONS) {
    const limit = limits[dim]
    out[dim] = Number.isFinite(limit) ? Math.max(0, limit - used[dim]) : UNLIMITED
  }
  return out
}

/**
 * @param {Usage} used
 * @param {Usage} limits
 * @returns {Usage}
 */
function overByOf(used, limits) {
  /** @type {Usage} */
  const out = emptyUsage()
  for (const dim of DIMENSIONS) {
    const limit = limits[dim]
    out[dim] = Number.isFinite(limit) ? Math.max(0, used[dim] - limit) : 0
  }
  return out
}

/**
 * @param {Usage} used
 * @param {Usage} limits
 * @returns {{ tokens: number | null, jobs: number | null, diskMb: number | null }}
 */
function utilizationOf(used, limits) {
  /** @type {{ tokens: number | null, jobs: number | null, diskMb: number | null }} */
  const out = { tokens: null, jobs: null, diskMb: null }
  for (const dim of DIMENSIONS) {
    const limit = limits[dim]
    if (!Number.isFinite(limit)) out[dim] = null
    else if (limit === 0) out[dim] = used[dim] === 0 ? 0 : UNLIMITED
    else out[dim] = used[dim] / limit
  }
  return out
}

/**
 * @param {number} timestamp
 * @returns {string | null}
 */
function isoOf(timestamp) {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * Resolve a scope id from a string or Scope-shaped object.
 * @param {unknown} scope
 * @returns {string}
 */
function scopeIdOf(scope) {
  if (scope === undefined || scope === null) return 'default'
  const id = typeof scope === 'string' ? scope : typeof scope === 'object' && scope !== null && 'id' in scope ? scope.id : undefined
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError('scope must be a non-empty string (or a Scope object with a non-empty id)')
  }
  return id.trim()
}

/**
 * Convert a clock return value (epoch ms or Date) to epoch milliseconds.
 * @param {unknown} value
 * @returns {number}
 */
function timestampOf(value) {
  if (value instanceof Date) {
    const time = value.getTime()
    if (!Number.isFinite(time)) throw new TypeError('now() returned an invalid Date')
    return time
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new TypeError('now() must return epoch milliseconds or a Date')
}

/**
 * @param {(() => number | Date) | number | Date | undefined} now
 * @returns {() => number}
 */
function createClock(now) {
  if (now === undefined) return () => Date.now()
  if (typeof now === 'function') return () => timestampOf(now())
  const fixed = timestampOf(now)
  return () => fixed
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeWindowMs(value) {
  if (value === undefined || value === null || value === UNLIMITED) return UNLIMITED
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError('windowMs must be a positive finite number of milliseconds')
  }
  return value
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeSoftRatio(value) {
  if (value === undefined || value === null) return DEFAULT_SOFT_RATIO
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new RangeError('softRatio must be a finite number in (0, 1]')
  }
  return value
}

/**
 * Build a detached status snapshot. Every caller mutating the returned object
 * must not be able to corrupt the ledger.
 * @param {Scope} record
 * @param {number} timestamp
 * @param {number} softRatio
 * @param {number} windowMs
 * @returns {Status}
 */
function snapshotOf(record, timestamp, softRatio, windowMs) {
  const { level, exceeded, degraded } = classify(record.used, record.limits, softRatio)
  return {
    scope: record.id,
    limits: { ...record.limits },
    used: { ...record.used },
    remaining: remainingOf(record.used, record.limits),
    overBy: overByOf(record.used, record.limits),
    utilization: utilizationOf(record.used, record.limits),
    level,
    allowed: level !== 'hard',
    degrade: level === 'soft',
    exceeded,
    degraded,
    softRatio,
    windowStartedAt: record.windowStartedAt,
    windowStartedAtIso: isoOf(record.windowStartedAt),
    windowAgeMs: timestamp - record.windowStartedAt,
    ...(Number.isFinite(windowMs) ? { windowMs } : {}),
  }
}

/**
 * Create an isolated ledger with admission-control helpers.
 *
 * @param {object} [options]
 * @param {(() => number | Date) | number | Date} [options.now] Injectable clock.
 * @param {Partial<Usage> | null} [options.limits] Default limits for new scopes.
 *   Omitted dimensions are unlimited.
 * @param {number} [options.softRatio=0.8] Soft threshold in (0, 1].
 * @param {number} [options.windowMs] Optional automatic window length. When
 *   set, access after the window elapses resets `used` lazily.
 * @param {Scope[]} [options.scopes] Optional seed scopes.
 * @returns {Governor}
 */
export function createGovernor(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createGovernor options must be an object')
  }
  const clock = createClock(options.now)
  const softRatio = normalizeSoftRatio(options.softRatio)
  const windowMs = normalizeWindowMs(options.windowMs)
  const defaultLimits = mergeLimits(unlimitedLimits(), options.limits)

  /** @type {Map<string, Scope>} */
  const ledger = new Map()

  /**
   * Lazily roll a scope's window when an automatic window length is active.
   * Aligns `windowStartedAt` to whole elapsed windows, so it does not drift.
   * @param {Scope} record
   * @param {number} timestamp
   * @returns {boolean} Whether usage was reset.
   */
  function rollWindow(record, timestamp) {
    if (!Number.isFinite(windowMs)) return false
    const elapsed = timestamp - record.windowStartedAt
    if (elapsed < windowMs) return false
    const periods = Math.floor(elapsed / windowMs)
    record.used = emptyUsage()
    record.windowStartedAt += periods * windowMs
    return true
  }

  /**
   * @param {string} id
   * @param {number} timestamp
   * @returns {Scope}
   */
  function ensureScope(id, timestamp) {
    let record = ledger.get(id)
    if (record === undefined) {
      record = {
        id,
        limits: { ...defaultLimits },
        used: emptyUsage(),
        windowStartedAt: timestamp,
      }
      ledger.set(id, record)
      return record
    }
    rollWindow(record, timestamp)
    return record
  }

  /**
   * @param {unknown} scope
   * @param {number} timestamp
   * @returns {Scope}
   */
  function resolve(scope, timestamp) {
    return ensureScope(scopeIdOf(scope), timestamp)
  }

  if (options.scopes !== undefined) {
    if (!Array.isArray(options.scopes)) throw new TypeError('scopes must be an array of Scope objects')
    for (const seed of options.scopes) {
      if (seed === null || typeof seed !== 'object') throw new TypeError('each seed scope must be an object')
      const id = scopeIdOf(seed)
      const timestamp = clock()
      ledger.set(id, {
        id,
        limits: mergeLimits(defaultLimits, seed.limits),
        used: normalizeUsage(seed.used),
        windowStartedAt: seed.windowStartedAt === undefined ? timestamp : timestampOf(seed.windowStartedAt),
      })
    }
  }

  /**
   * Merge limits into an existing scope (creating it if necessary) and return
   * the resulting status.
   * @param {string | Scope} scope
   * @param {Partial<Usage> | null} limits
   * @returns {Status & { changed: Dimension[] }}
   */
  function setLimits(scope, limits) {
    const timestamp = clock()
    const record = resolve(scope, timestamp)
    /** @type {Dimension[]} */
    const changed = []
    if (limits !== null && typeof limits === 'object' && !Array.isArray(limits)) {
      for (const dim of DIMENSIONS) {
        if (!Object.hasOwn(limits, dim) || limits[dim] === undefined) continue
        const next = normalizeLimit(limits[dim])
        if (!Object.is(next, record.limits[dim])) {
          record.limits[dim] = next
          changed.push(dim)
        }
      }
    }
    return { ...snapshotOf(record, timestamp, softRatio, windowMs), changed }
  }

  /**
   * Project a request against the current ledger without booking anything.
   * @param {Request} [request]
   * @returns {Decision}
   */
  function admit(request = {}) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('request must be an object like { scope, tokens, jobs, diskMb }')
    }
    const timestamp = clock()
    const record = resolve(request.scope, timestamp)
    const amount = normalizeRequest(request)
    const projected = addUsage(record.used, amount)
    const { level, exceeded, degraded } = classify(projected, record.limits, softRatio)
    const hard = level === 'hard'
    return {
      scope: record.id,
      allowed: !hard,
      level,
      reason: hard ? 'hard-limit' : level === 'soft' ? 'soft-limit' : 'ok',
      degrade: level === 'soft',
      remaining: remainingOf(projected, record.limits),
      overBy: overByOf(projected, record.limits),
      used: { ...record.used },
      projected,
      request: amount,
      limits: { ...record.limits },
      exceeded,
      degraded,
      softRatio,
      windowStartedAt: record.windowStartedAt,
      timestamp,
    }
  }

  /**
   * Book actual usage. Booking is unconditional (reality already happened):
   * over-limit usage is recorded and reported rather than rejected.
   * @param {Request} [request]
   * @returns {Decision}
   */
  function consume(request = {}) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('request must be an object like { scope, tokens, jobs, diskMb }')
    }
    const timestamp = clock()
    const record = resolve(request.scope, timestamp)
    const amount = normalizeRequest(request)
    record.used = addUsage(record.used, amount)
    const { level, exceeded, degraded } = classify(record.used, record.limits, softRatio)
    const hard = level === 'hard'
    return {
      scope: record.id,
      allowed: !hard,
      level,
      reason: hard ? 'hard-limit' : level === 'soft' ? 'soft-limit' : 'ok',
      degrade: level === 'soft',
      remaining: remainingOf(record.used, record.limits),
      overBy: overByOf(record.used, record.limits),
      used: { ...record.used },
      projected: { ...record.used },
      request: amount,
      limits: { ...record.limits },
      exceeded,
      degraded,
      softRatio,
      windowStartedAt: record.windowStartedAt,
      timestamp,
    }
  }

  /**
   * Snapshot a scope without creating it. Unknown scopes return a detached
   * default snapshot; a read-only `quota_status` call must not mutate the ledger.
   * @param {string | Scope} [scope]
   * @returns {Status}
   */
  function status(scope) {
    const timestamp = clock()
    const id = scopeIdOf(scope)
    const existing = ledger.get(id)
    if (existing !== undefined) {
      rollWindow(existing, timestamp)
      return snapshotOf(existing, timestamp, softRatio, windowMs)
    }
    const detached = {
      id,
      limits: { ...defaultLimits },
      used: emptyUsage(),
      windowStartedAt: timestamp,
    }
    return snapshotOf(detached, timestamp, softRatio, windowMs)
  }

  /**
   * Zero a scope's usage and restart its window at "now".
   * @param {string | Scope} [scope]
   * @returns {Status & { reset: true, previousUsed: Usage, previousWindowStartedAt: number }}
   */
  function resetWindow(scope) {
    const timestamp = clock()
    const record = resolve(scope, timestamp)
    const previousUsed = { ...record.used }
    const previousWindowStartedAt = record.windowStartedAt
    record.used = emptyUsage()
    record.windowStartedAt = timestamp
    return {
      ...snapshotOf(record, timestamp, softRatio, windowMs),
      reset: true,
      previousUsed,
      previousWindowStartedAt,
    }
  }

  /**
   * Snapshot every known scope, sorted by id. Does not create scopes.
   * @returns {Status[]}
   */
  function list() {
    const timestamp = clock()
    return [...ledger.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((record) => {
        rollWindow(record, timestamp)
        return snapshotOf(record, timestamp, softRatio, windowMs)
      })
  }

  return { setLimits, admit, consume, status, resetWindow, list, softRatio, windowMs }
}
