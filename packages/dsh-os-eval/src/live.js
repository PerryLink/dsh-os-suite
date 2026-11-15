/**
 * Read one live or persisted DSH session through the optional session-query
 * service and grade it with the same store as the exported-JSONL adapter.
 *
 * The integration is deliberately exact-read only. `attach()` probes
 * `ctx.sessionQuery` for `readSession` without subscribing to any event stream,
 * and every `readLiveSession()` call performs one detached, caller-owned read.
 * The returned `SessionLogSnapshot` is converted back to the plain JSONL shape
 * `parseSessionJsonl` already understands, so recorded-file and live-session
 * grading cannot drift apart.
 *
 * No model, network, filesystem, or session write is performed here. When the
 * host has no session-query service, callers get a stable
 * `SESSION_QUERY_UNAVAILABLE` error and can keep using `sessionFile`.
 */

import { EvalError } from './core.js'
import { evaluate, parseSessionJsonl, trajectoryOf } from './session.js'

const SERVICE_NAME = 'sessionQuery'
const SESSION_QUERY_CODE = /^SESSION_QUERY_[A-Z0-9_]+$/

/**
 * Probe the optional `ctx.sessionQuery` exact-read seam.
 *
 * This only reads the service reference. It never calls `ctx.on`, `ctx.effect`,
 * or any other subscription API, so probing has no lifecycle side effect and
 * may be repeated per call. Availability is not cached: a service registered
 * after the plugin activates is visible on the next probe.
 *
 * @param {object} ctx Cordis context, or a test double with `sessionQuery`.
 * @returns {{
 *   available: boolean,
 *   service: object|null,
 *   readSession: ((sessionId: string) => Promise<object>)|null,
 *   reason: string|null,
 * }} Availability plus a convenience reader bound to the service.
 */
export function attach(ctx) {
  const service = resolveSessionQuery(ctx)
  const available = service !== null && typeof service.readSession === 'function'
  if (!available) {
    return {
      available: false,
      service: null,
      readSession: null,
      reason: 'ctx.sessionQuery.readSession is unavailable; enable the session-query service or use sessionFile instead',
    }
  }
  return {
    available: true,
    service,
    readSession: (sessionId) => service.readSession(sessionId),
    reason: null,
  }
}

/**
 * Read one session through `ctx.sessionQuery.readSession()` and parse it into
 * the same shape `parseSessionJsonl` returns.
 *
 * The snapshot is detached and replay-validated by session-query; this module
 * only serializes `snapshot.session` as a header line and each
 * `snapshot.events` entry as one JSONL event line. No subscription is created
 * and nothing is retained after the call returns.
 *
 * @param {object} ctx Cordis context carrying the optional `sessionQuery` service.
 * @param {string} sessionId Live or persisted DSH session id to read.
 * @returns {Promise<ReturnType<typeof parseSessionJsonl>>} Parsed session.
 * @throws {EvalError} `INVALID_SESSION_ID`, `SESSION_QUERY_UNAVAILABLE`,
 *   `SESSION_QUERY_READ_FAILED` (or the service's own stable
 *   `SESSION_QUERY_*` code), or `INVALID_SESSION_SNAPSHOT`.
 */
export async function readLiveSession(ctx, sessionId) {
  const id = requireSessionId(sessionId)
  const capability = attach(ctx)
  if (!capability.available) {
    throw new EvalError(
      'SESSION_QUERY_UNAVAILABLE',
      `cannot read live session "${id}": ctx.sessionQuery.readSession is unavailable; `
      + 'enable the session-query service or pass sessionFile instead',
    )
  }

  /** @type {object} */
  let snapshot
  try {
    snapshot = await capability.service.readSession(id)
  } catch (error) {
    throw wrapReadFailure(id, error)
  }

  return parseSessionJsonl(snapshotToJsonl(snapshot))
}

/**
 * Serialize one `SessionLogSnapshot` to the plain JSONL text accepted by
 * `parseSessionJsonl`.
 *
 * The header line is `{ ...snapshot.session, type: "session" }`; each event is
 * emitted unchanged. Session-query returns cloned, JSON-safe events, so this
 * conversion loses no field the parser understands (including `seq`, `time`,
 * `data`, `surfaceOp`, and `sourceEventSeqs`).
 *
 * @param {object} snapshot `SessionLogSnapshot` from `sessionQuery.readSession`.
 * @returns {string} Newline-joined session header and event lines.
 * @throws {EvalError} `INVALID_SESSION_SNAPSHOT` when the snapshot shape is not usable.
 */
export function snapshotToJsonl(snapshot) {
  if (!isPlainObject(snapshot)) {
    throw new EvalError('INVALID_SESSION_SNAPSHOT', 'sessionQuery.readSession must return a SessionLogSnapshot object')
  }
  if (!isPlainObject(snapshot.session)
    || typeof snapshot.session.id !== 'string'
    || snapshot.session.id.trim() === '') {
    throw new EvalError(
      'INVALID_SESSION_SNAPSHOT',
      'SessionLogSnapshot.session must carry a non-empty session id',
    )
  }
  if (!Array.isArray(snapshot.events)) {
    throw new EvalError('INVALID_SESSION_SNAPSHOT', 'SessionLogSnapshot.events must be an array')
  }

  /** @type {string[]} */
  const lines = []
  try {
    lines.push(JSON.stringify({ ...snapshot.session, type: 'session' }))
    for (const event of snapshot.events) {
      if (!isPlainObject(event) || typeof event.type !== 'string' || event.type === '') {
        throw new EvalError(
          'INVALID_SESSION_SNAPSHOT',
          'SessionLogSnapshot.events must contain event objects with a non-empty type',
        )
      }
      lines.push(JSON.stringify(event))
    }
  } catch (error) {
    if (error instanceof EvalError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new EvalError(
      'INVALID_SESSION_SNAPSHOT',
      `SessionLogSnapshot is not JSON-serializable: ${message}`,
    )
  }

  return lines.join('\n')
}

/**
 * Read and grade one live or persisted session with the existing case scorer.
 *
 * The result is the ordinary `evaluate()` payload plus `source: "live"` and the
 * paired `trajectoryOf()` step array for programmatic callers. `eval_report`
 * never exposes that raw step array; tool results carry only the compact
 * trajectory summary.
 *
 * @param {object} ctx Cordis context carrying the optional `sessionQuery` service.
 * @param {string} sessionId Live or persisted DSH session id to read.
 * @param {import('./core.js').EvalCase[]} cases Cases to grade.
 * @returns {Promise<object>} Per-case grades, compact trajectory, source, and paired tool steps.
 */
export async function evaluateLive(ctx, sessionId, cases) {
  const session = await readLiveSession(ctx, sessionId)
  const evaluation = evaluate(session, cases)
  return {
    source: 'live',
    ...evaluation,
    trajectory: evaluation.trajectory,
    toolTrajectory: trajectoryOf(session),
  }
}

/**
 * Resolve the optional service without requiring it as a Cordis injection.
 *
 * `ctx.get()` is the documented way to read a service that a plugin does not
 * depend on. The property fallback keeps the helper usable with a plain test
 * context that has no Cordis `get` method.
 *
 * @param {unknown} ctx Candidate context.
 * @returns {object|null} Session-query service, or null.
 */
function resolveSessionQuery(ctx) {
  if (ctx === null || typeof ctx !== 'object') return null

  if (typeof ctx.get === 'function') {
    try {
      const service = ctx.get(SERVICE_NAME)
      if (service !== undefined) return service ?? null
    } catch {
      // Fall through to the property form for non-Cordis test doubles.
    }
  }

  try {
    return ctx.sessionQuery ?? null
  } catch {
    return null
  }
}

/**
 * @param {unknown} value Candidate session id.
 * @returns {string} The validated id.
 */
function requireSessionId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EvalError('INVALID_SESSION_ID', 'liveSessionId must be a non-empty string')
  }
  return value
}

/**
 * Wrap a failed `readSession()` in a stable EvalError while preserving the
 * service's own `SESSION_QUERY_*` taxonomy when it reports one.
 *
 * @param {string} sessionId Requested session id.
 * @param {unknown} error Original failure.
 * @returns {EvalError} Stable adapter failure.
 */
function wrapReadFailure(sessionId, error) {
  const detail = error instanceof Error ? error.message : String(error)
  const reported = error !== null && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : null
  const code = reported !== null && SESSION_QUERY_CODE.test(reported)
    ? reported
    : 'SESSION_QUERY_READ_FAILED'
  const suffix = code === reported && code !== 'SESSION_QUERY_READ_FAILED'
    ? ` (${code})`
    : ''
  const failure = new EvalError(
    code,
    `cannot read live session "${sessionId}" through ctx.sessionQuery.readSession${suffix}: ${detail}`,
  )
  failure.cause = error
  return failure
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
