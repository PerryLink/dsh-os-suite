/**
 * Opt-in live subscription to one DSH session's `session/event` feed.
 *
 * A watcher is explicit and caller-owned: it is created only when a caller asks
 * for it, it retains the raw events it observed in memory, and `detach()` stops
 * the subscription. It never calls a model, writes a session, or persists
 * anything. `trajectory()` converts the retained events to the same JSONL shape
 * the file adapter uses and reuses `trajectoryOf`, so a live trajectory pairs
 * tool calls and results by call id exactly like a recorded session.
 *
 * DSH publishes `session/event(session, event)` after each committed append.
 * Events from other sessions are ignored by id. Event types and fields this
 * module does not understand are retained in `snapshot()` and skipped by
 * `trajectory()`, which keeps the watcher forward-compatible with new session
 * events.
 */

import { EvalError } from './core.js'
import { parseSessionJsonl, trajectoryOf } from './session.js'

const EVENT_NAME = 'session/event'

/**
 * Create one watcher for a single session id.
 *
 * Creation registers no listener. Call `attach()` to subscribe; calling
 * `attach()` again while attached is a no-op. `detach()` removes the listener
 * but keeps already-observed events, so `snapshot()` and `trajectory()` remain
 * usable afterward. A later `attach()` appends to the same retained history.
 *
 * @param {{
 *   ctx: object,
 *   sessionId: string,
 * }} options Cordis context carrying `on(event, listener)` and the session id
 *   to observe.
 * @returns {{
 *   attach: () => { sessionId: string, attached: boolean, events: number },
 *   detach: () => { sessionId: string, attached: boolean, events: number },
 *   snapshot: () => unknown[],
 *   trajectory: () => ReturnType<typeof trajectoryOf>,
 * }} Watcher handle.
 * @throws {EvalError} `INVALID_SESSION_ID` when `sessionId` is not a non-empty
 *   string.
 */
export function createWatcher({ ctx, sessionId } = {}) {
  const id = requireSessionId(sessionId)
  const context = ctx ?? null

  /** @type {unknown[]} */
  const events = []
  /** @type {(() => void)|null} */
  let dispose = null
  let attached = false
  let generation = 0

  /**
   * Subscribe to `session/event` for the configured session id.
   *
   * @returns {{ sessionId: string, attached: boolean, events: number }} Current watcher state.
   * @throws {EvalError} `SESSION_EVENTS_UNAVAILABLE` when the context has no
   *   `on()` method, or `SESSION_EVENTS_SUBSCRIBE_FAILED` when subscription
   *   throws.
   */
  function attach() {
    if (attached) return state()
    if (context === null || typeof context.on !== 'function') {
      throw new EvalError(
        'SESSION_EVENTS_UNAVAILABLE',
        `cannot watch session "${id}": ctx.on('${EVENT_NAME}') is unavailable; `
        + 'live event subscription requires a Cordis context',
      )
    }

    attached = true
    const ticket = ++generation
    /** @type {unknown} */
    let subscription
    try {
      subscription = context.on(EVENT_NAME, (session, event) => {
        if (!attached || ticket !== generation) return
        if (session === null || typeof session !== 'object' || session.id !== id) return
        // Unknown event types and payloads are retained; trajectory() skips
        // whatever the session parser does not understand.
        events.push(event)
      })
    } catch (error) {
      attached = false
      generation += 1
      throw wrapSubscribeFailure(id, error)
    }

    dispose = typeof subscription === 'function' ? subscription : null
    return state()
  }

  /**
   * Stop receiving events. Already-retained events stay available.
   *
   * @returns {{ sessionId: string, attached: boolean, events: number }} Current watcher state.
   */
  function detach() {
    attached = false
    generation += 1
    const stop = dispose
    dispose = null
    if (stop !== null) {
      try {
        stop()
      } catch {
        // Observer cleanup is best effort; a broken disposer must not make
        // detaching (or a later tool call) fail.
      }
    }
    return state()
  }

  /**
   * Read the events observed so far.
   *
   * The returned array is a shallow copy: mutating its order or length does not
   * change the watcher. Events themselves are the host's recorded objects and
   * must be treated as read-only.
   *
   * @returns {unknown[]} Detached snapshot of observed events in append order.
   */
  function snapshot() {
    return events.slice()
  }

  /**
   * Pair the observed tool calls and results into trajectory steps.
   *
   * The events are serialized as plain JSONL with a synthetic session header and
   * parsed by the same `parseSessionJsonl` implementation used for recorded
   * files. Unknown events, malformed payloads, and results that arrive before
   * their call are handled by that parser.
   *
   * @returns {ReturnType<typeof trajectoryOf>} Tool steps in log order.
   */
  function trajectory() {
    return trajectoryOf(parsedSnapshot())
  }

  /**
   * @returns {object} Parsed live session, built from the retained events.
   */
  function parsedSnapshot() {
    /** @type {string[]} */
    const lines = [JSON.stringify({ type: 'session', id })]
    for (const event of events) {
      /** @type {string|undefined} */
      let line
      try {
        line = JSON.stringify(event)
      } catch {
        // A non-serializable payload cannot be graded; keep it in snapshot()
        // and omit it from the derived trajectory.
        continue
      }
      if (typeof line === 'string' && line !== '') lines.push(line)
    }
    return parseSessionJsonl(lines.join('\n'))
  }

  return { attach, detach, snapshot, trajectory }

  /**
   * @returns {{ sessionId: string, attached: boolean, events: number }} Current state summary.
   */
  function state() {
    return { sessionId: id, attached, events: events.length }
  }
}

/**
 * @param {unknown} value Candidate session id.
 * @returns {string} The validated id.
 */
function requireSessionId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EvalError('INVALID_SESSION_ID', 'watcher sessionId must be a non-empty string')
  }
  return value
}

/**
 * Wrap a failed subscription in a stable EvalError.
 *
 * @param {string} sessionId Requested session id.
 * @param {unknown} error Original failure.
 * @returns {EvalError} Stable watcher failure.
 */
function wrapSubscribeFailure(sessionId, error) {
  const detail = error instanceof Error ? error.message : String(error)
  const failure = new EvalError(
    'SESSION_EVENTS_SUBSCRIBE_FAILED',
    `cannot subscribe to '${EVENT_NAME}' for session "${sessionId}": ${detail}`,
  )
  failure.cause = error
  return failure
}
