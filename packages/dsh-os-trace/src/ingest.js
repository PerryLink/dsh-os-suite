/**
 * Live DSH event collector for dsh-os-trace.
 *
 * The collector observes the plugin-visible DSH event stream, maps recognized
 * events to the span shape owned by `core.js`, pairs lifecycle start/end
 * events by stable ids, and ingests only terminal spans into the append-only
 * hash chain. Pending spans stay in the collector's live view (`spans()`) with
 * `status: "running"` until their end event arrives.
 *
 * Invariants:
 * - Event handlers never throw into the host event bus. Bad shapes are counted
 *   as ignored/errors instead of breaking the agent loop.
 * - Waterfall listeners (`tools/pre-execute`, `tools/post-execute`,
 *   `approval/request`) always delegate with `next()`; observation must not
 *   veto or claim the decision.
 * - Duplicate deliveries are idempotent: lifecycle records are keyed by stable
 *   ids (callId, approval id, runId, jobId, ...), and a terminal record is
 *   never ingested twice.
 * - Only structural attributes are recorded. Tool arguments, message bodies
 *   and free-form reasons are deliberately not captured, so the evidence
 *   store does not silently become a secret sink.
 *
 * Cordis has no wildcard event dispatch: `approval/*` and friends below are
 * registered as opaque names for harnesses that do support wildcard routing,
 * while this collector also enumerates the concrete event names this DSH
 * build emits and uses `internal/dispatch` as a best-effort family catch-all.
 */

import { TraceError } from './core.js'

/** Event names subscribed for every attach. */
export const CORE_INGEST_EVENTS = Object.freeze([
  'session/event',
  'tools/pre-execute',
  'tools/post-execute',
  'tool/result',
  'tools/result',
])

/** Family shorthands from the integration contract. */
export const FAMILY_INGEST_EVENTS = Object.freeze([
  'approval/*',
  'agent/*',
  'subagent/*',
  'job/*',
  'mcp/*',
])

const FAMILY_EVENTS = Object.freeze({
  approval: Object.freeze([
    'approval/request',
    'approval/asked',
    'approval/decided',
    'approval/resolved',
  ]),
  agent: Object.freeze([
    'agent/created',
    'agent/disposed',
    'agent/status',
    'agent/error',
  ]),
  subagent: Object.freeze(['subagent/start', 'subagent/end']),
  job: Object.freeze([
    'job/registered',
    'job/settled',
    'job/start',
    'job/end',
  ]),
  mcp: Object.freeze([
    'mcp/connect',
    'mcp/connected',
    'mcp/disconnect',
    'mcp/disconnected',
    'mcp/start',
    'mcp/end',
    'mcp/request',
    'mcp/response',
    'mcp/call',
    'mcp/result',
    'mcp/error',
  ]),
})

const CONCRETE_FAMILY_EVENTS = Object.freeze(
  Object.values(FAMILY_EVENTS).flat(),
)
const CONCRETE_FAMILY_EVENT_SET = new Set(CONCRETE_FAMILY_EVENTS)
const CORE_EVENT_SET = new Set(CORE_INGEST_EVENTS)

const WATERFALL_EVENTS = new Set([
  'tools/pre-execute',
  'tools/post-execute',
  'approval/request',
])

const INTERNAL_DISPATCH = 'internal/dispatch'
const UNKNOWN_SESSION = 'unknown'
const UNKNOWN_NAME = 'event'

const START_ACTIONS = new Set([
  'start',
  'started',
  'begin',
  'began',
  'open',
  'opened',
  'create',
  'created',
  'register',
  'registered',
  'ask',
  'asked',
  'request',
  'requested',
  'connect',
  'connected',
  'invoke',
  'invoked',
  'call',
  'called',
  'run',
  'running',
])

const END_ACTIONS = new Set([
  'end',
  'ended',
  'finish',
  'finished',
  'settle',
  'settled',
  'decide',
  'decided',
  'decision',
  'resolve',
  'resolved',
  'disconnect',
  'disconnected',
  'granted',
  'approved',
  'accepted',
  'result',
  'response',
  'completed',
  'complete',
  'done',
  'close',
  'closed',
  'kill',
  'killed',
  'abort',
  'aborted',
])

const FAILURE_ACTIONS = new Set([
  'error',
  'failed',
  'failure',
  'rejected',
  'denied',
  'cancelled',
  'canceled',
  'unavailable',
])

const PLACEHOLDER_NAMES = new Set([
  'tool',
  'mcp',
  'approval',
  'job',
  'subagent',
  'agent',
  'session',
  UNKNOWN_NAME,
])

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value */
function isFunction(value) {
  return typeof value === 'function'
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function idText(value) {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string|undefined}
 */
function clipText(value, max = 240) {
  const text = idText(value)
  if (text === undefined) return undefined
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * First defined, non-null value.
 *
 * @template T
 * @param {...(T|undefined|null)} values
 * @returns {T|undefined}
 */
function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/**
 * @param {...unknown} values
 * @returns {string|undefined}
 */
function firstText(...values) {
  for (const value of values) {
    const text = idText(value)
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * Flatten the common DSH wrappers (`event`, `data`, `message`, `result`,
 * `payload`, `source`, `agent`, `info`) so field lookups tolerate shape drift.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>[]}
 */
function payloads(value) {
  /** @type {Record<string, unknown>[]} */
  const out = []
  const seen = new Set()
  /**
   * @param {unknown} entry
   * @param {number} depth
   */
  function add(entry, depth) {
    if (!isRecord(entry) || seen.has(entry) || depth > 4) return
    seen.add(entry)
    out.push(entry)
    add(entry.event, depth + 1)
    add(entry.data, depth + 1)
    add(entry.message, depth + 1)
    add(entry.payload, depth + 1)
    add(entry.result, depth + 1)
    add(entry.info, depth + 1)
    add(entry.detail, depth + 1)
    add(entry.source, depth + 1)
    add(entry.agent, depth + 1)
    add(entry.exec, depth + 1)
    add(entry.job, depth + 1)
    add(entry.request, depth + 1)
    add(entry.subagent, depth + 1)
    add(entry.toolCall, depth + 1)
  }
  add(value, 0)
  return out
}

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {unknown}
 */
function field(value, keys) {
  for (const payload of payloads(value)) {
    for (const key of keys) {
      if (payload[key] !== undefined) return payload[key]
    }
  }
  return undefined
}

/**
 * Read a string from the value itself (and its `data` wrapper) without
 * traversing nested identities such as `agent.id`. Used where an `id` must
 * not be confused with the owning session/agent id.
 *
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {string|undefined}
 */
function directTextField(value, keys) {
  if (!isRecord(value)) return undefined
  for (const key of keys) {
    const text = idText(value[key])
    if (text !== undefined) return text
  }
  if (isRecord(value.data)) {
    for (const key of keys) {
      const text = idText(value.data[key])
      if (text !== undefined) return text
    }
  }
  return undefined
}

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {string|undefined}
 */
function textField(value, keys) {
  for (const payload of payloads(value)) {
    for (const key of keys) {
      const text = idText(payload[key])
      if (text !== undefined) return text
    }
  }
  return undefined
}

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {number|undefined}
 */
function numberField(value, keys) {
  for (const payload of payloads(value)) {
    for (const key of keys) {
      const number = payload[key]
      if (typeof number === 'number' && Number.isFinite(number)) return number
    }
  }
  return undefined
}

/**
 * @param {unknown} value
 * @returns {number|undefined}
 */
function timeOf(value) {
  const numeric = numberField(value, [
    'time',
    'timestamp',
    'at',
    'startedAt',
    'started_at',
    'startMs',
  ])
  if (numeric !== undefined) return numeric
  const iso = textField(value, ['time', 'timestamp', 'at'])
  if (iso === undefined) return undefined
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function callIdOf(value) {
  return textField(value, [
    'callId',
    'call_id',
    'toolCallId',
    'tool_call_id',
    'subCallId',
    'requestId',
  ])
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function toolNameOf(value) {
  return textField(value, ['toolName', 'tool_name', 'tool', 'name', 'label'])
}

/**
 * Tool/MCP call id. `id` is accepted as a last-resort alias because event
 * producers differ on whether the execution identity is called `callId` or
 * `id`; session events use `message.toolCallId`.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function toolCallIdOf(value) {
  return callIdOf(value) ?? textField(value, ['id'])
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function agentPathOf(value) {
  const direct = textField(value, ['agentPath'])
  if (direct !== undefined) return direct
  const agent = field(value, ['agent'])
  if (isRecord(agent)) return firstText(agent.name, agent.path)
  return undefined
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function sessionIdOf(value) {
  for (const payload of payloads(value)) {
    const direct = firstText(
      payload.sessionId,
      payload.session_id,
      payload.sessionID,
      payload.owner,
      payload.ownerId,
      payload.parentSessionId,
      payload.parent_session_id,
    )
    if (direct !== undefined) return direct
    if (isRecord(payload.session)) {
      const id = firstText(payload.session.id, payload.session.sessionId)
      if (id !== undefined) return id
    }
    if (isRecord(payload.agent)) {
      const id = firstText(
        payload.agent.id,
        payload.agent.sessionId,
        isRecord(payload.agent.session) ? payload.agent.session.id : undefined,
      )
      if (id !== undefined) return id
    }
  }
  return undefined
}

/**
 * @param {unknown} session
 * @returns {string|undefined}
 */
function sessionIdOfSession(session) {
  if (typeof session === 'string') return idText(session)
  if (!isRecord(session)) return undefined
  return firstText(session.id, session.sessionId, sessionIdOf(session))
}

/**
 * @param {string|undefined} name
 * @returns {boolean}
 */
function isMcpToolName(name) {
  if (typeof name !== 'string') return false
  return name.startsWith('mcp__') || /^mcp[.:/]/.test(name)
}

/**
 * @param {string|undefined} name
 * @returns {string|undefined}
 */
function mcpServerOf(name) {
  if (typeof name !== 'string') return undefined
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    if (parts.length >= 3 && parts[1].length > 0) return parts[1]
  }
  const match = /^mcp[.:/]([^.:/]+)/.exec(name)
  return match?.[1]
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sanitizeAttribute(value, depth = 0, seen = new Set()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string') return clipText(value, 300)
  if (type === 'number') return Number.isFinite(value) ? value : undefined
  if (type === 'boolean') return value
  if (type !== 'object') return undefined
  if (depth >= 3) return undefined
  if (seen.has(value)) return undefined
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, 20)
        .map((entry) => sanitizeAttribute(entry, depth + 1, seen))
        .filter((entry) => entry !== undefined)
    }
    if (!isRecord(value)) return undefined
    /** @type {Record<string, unknown>} */
    const out = {}
    let count = 0
    for (const [key, entry] of Object.entries(value)) {
      if (count >= 20) break
      if (/^(secret|token|password|passwd|authorization|cookie|api[-_]?key|credential|private[-_]?key)$/i.test(key)) {
        continue
      }
      const safe = sanitizeAttribute(entry, depth + 1, seen)
      if (safe !== undefined) {
        out[key] = safe
        count += 1
      }
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {Record<string, unknown>|undefined}
 */
function attrsOf(input) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    const safe = sanitizeAttribute(value)
    if (safe !== undefined) out[key] = safe
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function stableKey(value) {
  const seen = new Set()
  /**
   * @param {unknown} entry
   * @param {number} depth
   * @returns {unknown}
   */
  function walk(entry, depth) {
    if (entry === null) return null
    const type = typeof entry
    if (type === 'string') return clipText(entry, 120)
    if (type === 'number') return Number.isFinite(entry) ? entry : null
    if (type === 'boolean') return entry
    if (type !== 'object' || depth > 3 || seen.has(entry)) return undefined
    seen.add(entry)
    try {
      if (Array.isArray(entry)) {
        return entry.slice(0, 12).map((item) => walk(item, depth + 1))
      }
      if (!isRecord(entry)) return undefined
      /** @type {Record<string, unknown>} */
      const out = {}
      for (const key of Object.keys(entry).sort()) {
        if (key === 'time' || key === 'timestamp' || key === 'seq') continue
        const encoded = walk(entry[key], depth + 1)
        if (encoded !== undefined) out[key] = encoded
      }
      return out
    } finally {
      seen.delete(entry)
    }
  }
  try {
    const text = JSON.stringify(walk(value, 0))
    return text === undefined ? undefined : clipText(text, 400)
  } catch {
    return undefined
  }
}

/**
 * @param {unknown} value
 * @returns {'ok'|'error'|undefined}
 */
function statusText(value) {
  const status = field(value, ['status', 'outcome', 'stopReason', 'result'])
  if (typeof status === 'string') {
    const normalized = status.toLowerCase()
    if (FAILURE_ACTIONS.has(normalized)) return 'error'
    if (['ok', 'success', 'succeeded', 'completed', 'complete', 'completed', 'allowed-once', 'allow', 'allowed'].includes(normalized)) {
      return 'ok'
    }
  }
  if (isRecord(status)) {
    const kind = firstText(status.kind, status.status, status.outcome)
    if (kind !== undefined) return statusText({ status: kind })
  }
  if (field(value, ['isError']) === true || field(value, ['error']) !== undefined) return 'error'
  return undefined
}

/**
 * @param {unknown} result
 * @returns {'ok'|'error'}
 */
function toolResultStatus(result) {
  const direct = statusText(result)
  if (direct !== undefined) return direct
  if (field(result, ['isError', 'is_error']) === true) return 'error'
  if (field(result, ['ok']) === false) return 'error'
  return 'ok'
}

/**
 * @param {unknown} error
 * @returns {string|undefined}
 */
function errorCodeOf(error) {
  if (!isRecord(error)) return undefined
  return firstText(
    isRecord(error.info) ? error.info.code : undefined,
    error.code,
    isRecord(error.error) ? error.error.code : undefined,
  )
}

/**
 * Read a lifecycle label without collapsing it to ok/error.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function stateLabelOf(value) {
  const raw = field(value, ['status', 'state', 'outcome', 'stopReason'])
  if (typeof raw === 'string') return raw
  if (isRecord(raw)) return firstText(raw.kind, raw.status, raw.state, raw.outcome)
  return undefined
}

/**
 * @param {unknown} reason
 * @returns {'ok'|'error'}
 */
function turnEndStatus(reason) {
  const kind = isRecord(reason) ? firstText(reason.kind, reason.reason) : idText(reason)
  if (kind === undefined) return 'ok'
  if (['error', 'aborted', 'interrupted', 'forked', 'failed'].includes(kind)) {
    return 'error'
  }
  return 'ok'
}

/**
 * @param {string} type
 * @returns {boolean}
 */
function isFamilyEventName(type) {
  return FAMILY_EVENTS[type] !== undefined || type.includes('/')
}

/**
 * @param {string} type
 * @returns {string|undefined}
 */
function familyOf(type) {
  if (typeof type !== 'string') return undefined
  const index = type.indexOf('/')
  if (index <= 0) return undefined
  const family = type.slice(0, index)
  return FAMILY_EVENTS[family] === undefined ? undefined : family
}

/**
 * @param {string} type
 * @returns {'start'|'end'|'update'|'point'|'failure'}
 */
function actionOf(type) {
  const last = type.slice(type.lastIndexOf('/') + 1).toLowerCase()
  if (FAILURE_ACTIONS.has(last)) return 'failure'
  if (START_ACTIONS.has(last) || /(?:^|-)(?:start|started|begin|began|open|opened|create|created|register|registered|ask|asked|request|requested|connect|connected|invoke|invoked|call|called|run|running)$/.test(last)) {
    return 'start'
  }
  if (END_ACTIONS.has(last) || /(?:^|-)(?:end|ended|finish|finished|settle|settled|decide|decided|decision|resolve|resolved|disconnect|disconnected|result|response|completed|complete|done|close|closed|kill|killed|abort|aborted)$/.test(last)) {
    return 'end'
  }
  if (last === 'status') return 'update'
  return 'point'
}

/**
 * Only clear lifecycle suffixes may reach the generic family fallback. This
 * keeps high-frequency events such as `agent/assistant-stream` out of the
 * store entirely instead of turning every frame into a point span.
 *
 * @param {string} type
 * @returns {boolean}
 */
function isLifecycleEventName(type) {
  // Agent's frequent non-lifecycle events (`agent/request`, `agent/pre-step`,
  // `agent/assistant-stream`, inbox splices, ...) must never enter the store.
  // The four lifecycle events this build knows are subscribed explicitly.
  if (type.startsWith('agent/')) return false
  const action = actionOf(type)
  return action === 'start' || action === 'end' || action === 'failure'
}

/**
 * @param {string} type
 * @returns {string|undefined}
 */
function familySpanKind(type) {
  const family = familyOf(type)
  if (family === undefined) return undefined
  return family === 'agent' ? 'session' : family
}

/**
 * Create a live event collector bound to one trace store.
 *
 * @param {{ store: ReturnType<import('./core.js').createTraceStore>, now?: () => number }} options
 * @returns {{
 *   attach: (ctx: unknown) => boolean,
 *   detach: () => void,
 *   spans: () => object[],
 *   status: () => Record<string, unknown>,
 * }}
 */
export function createIngest(options) {
  if (!isRecord(options)) {
    throw new TraceError('INVALID_OPTIONS', 'createIngest options must be an object')
  }
  const store = options.store
  if (!isRecord(store) || !isFunction(store.ingest)) {
    throw new TraceError(
      'INVALID_OPTIONS',
      'createIngest requires a trace store with ingest()',
    )
  }
  const clock = options.now ?? Date.now
  if (!isFunction(clock)) {
    throw new TraceError('INVALID_OPTIONS', 'createIngest now must be a function')
  }

  /** @type {{ name: string, dispose: unknown }[]} */
  let hooks = []
  let attached = false
  let events = 0
  let mappedEvents = 0
  let ignored = 0
  let errors = 0
  /** @type {number|null} */
  let lastEventAt = null
  /** @type {string|null} */
  let lastError = null
  let nextOrder = 0

  /** @type {Map<string, Record<string, any>>} */
  const records = new Map()
  /** @type {Map<string, Record<string, any>>} */
  const aliases = new Map()
  /** @type {Map<string, number>} */
  const eventsByName = new Map()

  /**
   * @returns {number}
   */
  function nowMs() {
    try {
      const value = clock()
      return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  /**
   * @param {unknown} error
   */
  function recordError(error) {
    errors += 1
    lastError = clipText(error instanceof Error ? error.message : String(error), 240) ?? null
  }

  /**
   * @param {Record<string, any>} record
   * @param {string[]} names
   */
  function addAliases(record, names) {
    for (const name of names) {
      if (typeof name !== 'string' || name.length === 0) continue
      record.aliases.add(name)
      if (!aliases.has(name)) aliases.set(name, record)
    }
  }

  /**
   * @param {string[]} names
   * @returns {Record<string, any>|undefined}
   */
  function findRecord(names) {
    for (const name of names) {
      if (typeof name !== 'string' || name.length === 0) continue
      const found = aliases.get(name) ?? records.get(name)
      if (found !== undefined) return found
    }
    return undefined
  }

  /**
   * @param {string[]} names
   * @param {Record<string, any>} span
   * @param {string[]} [moreAliases]
   * @returns {Record<string, any>}
   */
  function ensureRecord(names, span, moreAliases = []) {
    const existing = findRecord(names)
    if (existing !== undefined) {
      updateRecord(existing, span)
      addAliases(existing, [...names, ...moreAliases, existing.span.id])
      return existing
    }
    const key = names[0] ?? span.id
    /** @type {Record<string, any>} */
    const record = {
      key,
      span: { ...span },
      order: nextOrder,
      done: false,
      failed: false,
      stored: null,
      aliases: new Set(),
    }
    nextOrder += 1
    records.set(key, record)
    addAliases(record, [key, ...names, ...moreAliases, span.id])
    return record
  }

  /**
   * Merge a later observation into a pending span. Terminal records are never
   * mutated by duplicate or late events.
   *
   * @param {Record<string, any>} record
   * @param {Record<string, any>} patch
   */
  function updateRecord(record, patch) {
    if (record.done) return
    const span = record.span
    if (typeof patch.kind === 'string' && patch.kind !== span.kind) {
      span.kind = patch.kind
      if (typeof patch.id === 'string' && patch.id.length > 0) span.id = patch.id
      record.aliases.add(span.id)
      if (!aliases.has(span.id)) aliases.set(span.id, record)
    }
    if (typeof patch.name === 'string' && patch.name.length > 0) {
      if (!span.name || PLACEHOLDER_NAMES.has(span.name)) span.name = patch.name
    }
    if (typeof patch.sessionId === 'string' && patch.sessionId.length > 0) {
      if (!span.sessionId || span.sessionId === UNKNOWN_SESSION) {
        span.sessionId = patch.sessionId
      }
    }
    if (
      typeof patch.startMs === 'number' &&
      Number.isFinite(patch.startMs) &&
      patch.startMs < span.startMs
    ) {
      span.startMs = patch.startMs
    }
    if (
      typeof patch.parentId === 'string' &&
      patch.parentId.length > 0 &&
      span.parentId === undefined
    ) {
      span.parentId = patch.parentId
    }
    if (isRecord(patch.attrs)) {
      span.attrs = { ...(span.attrs ?? {}), ...patch.attrs }
    }
    if (patch.status === 'running') span.status = 'running'
  }

  /**
   * Ingest a terminal span exactly once. Store failures are counted and never
   * propagate to the event bus.
   *
   * @param {Record<string, any>} record
   * @param {{ status?: 'ok'|'error', endMs?: number, attrs?: Record<string, unknown> }} [terminal]
   * @returns {boolean}
   */
  function finalizeRecord(record, terminal = {}) {
    if (record.done) return true
    const span = record.span
    span.status = terminal.status === 'error' ? 'error' : 'ok'
    const candidateEnd =
      typeof terminal.endMs === 'number' && Number.isFinite(terminal.endMs)
        ? terminal.endMs
        : nowMs()
    span.endMs = Math.max(candidateEnd, span.startMs)
    if (isRecord(terminal.attrs)) {
      span.attrs = { ...(span.attrs ?? {}), ...terminal.attrs }
    }
    record.done = true
    try {
      record.stored = store.ingest(span)
      record.failed = false
    } catch (error) {
      if (isRecord(error) && error.code === 'DUPLICATE_SPAN') {
        try {
          const existing = isFunction(store.query) ? store.query({ id: span.id }) : []
          record.stored = Array.isArray(existing) && existing.length > 0 ? existing[0] : null
        } catch {
          record.stored = null
        }
        record.failed = false
        return true
      }
      record.failed = true
      recordError(error)
    }
    return true
  }

  /**
   * @param {string} callId
   * @param {Record<string, any>} span
   * @returns {Record<string, any>}
   */
  function ensureCallRecord(callId, span) {
    return ensureRecord(
      [`call:${callId}`, `tool:${callId}`, `mcp:${callId}`],
      span,
      [span.id],
    )
  }

  /**
   * Start (or merge) a tool/MCP call span.
   *
   * @param {unknown} payload
   * @param {{ source: string, sessionId?: string, startMs?: number, parentId?: string, turn?: number, step?: number }} meta
   * @returns {boolean}
   */
  function startTool(payload, meta) {
    const callId = toolCallIdOf(payload)
    if (callId === undefined) return false
    const name = toolNameOf(payload) ?? 'tool'
    const kind = isMcpToolName(name) ? 'mcp' : 'tool'
    const sessionId = firstText(sessionIdOf(payload), meta.sessionId) ?? UNKNOWN_SESSION
    const startMs = firstValue(timeOf(payload), meta.startMs, nowMs()) ?? nowMs()
    const attrs = attrsOf({
      source: meta.source,
      callId,
      rootCallId: textField(payload, ['rootCallId']),
      agentId: isRecord(payload) && isRecord(payload.agent) ? idText(payload.agent.id) : undefined,
      turn: meta.turn,
      step: meta.step,
      mcpServer: mcpServerOf(name),
    })
    const agentPath = agentPathOf(payload)
    ensureCallRecord(callId, {
      id: `${kind}:${callId}`,
      sessionId,
      kind,
      name,
      startMs,
      status: 'running',
      ...(meta.parentId !== undefined ? { parentId: meta.parentId } : {}),
      ...(agentPath !== undefined ? { agentPath } : {}),
      ...(attrs !== undefined ? { attrs } : {}),
    })
    return true
  }

  /**
   * Finish (or create a terminal) tool/MCP call span.
   *
   * @param {unknown} payload
   * @param {unknown} result
   * @param {{ source: string, sessionId?: string, endMs?: number, name?: string }} meta
   * @returns {boolean}
   */
  function finishTool(payload, result, meta) {
    const callId = toolCallIdOf(payload) ?? toolCallIdOf(result)
    if (callId === undefined) return false
    let record = findRecord([`call:${callId}`, `tool:${callId}`, `mcp:${callId}`])
    if (record === undefined) {
      const name = firstText(toolNameOf(payload), toolNameOf(result), meta.name) ?? 'tool'
      const kind = isMcpToolName(name) ? 'mcp' : 'tool'
      const sessionId = firstText(sessionIdOf(payload), sessionIdOf(result), meta.sessionId) ?? UNKNOWN_SESSION
      const startMs = firstValue(timeOf(payload), timeOf(result), meta.endMs, nowMs()) ?? nowMs()
      record = ensureCallRecord(callId, {
        id: `${kind}:${callId}`,
        sessionId,
        kind,
        name,
        startMs,
        status: 'running',
      })
    } else {
      const name = firstText(toolNameOf(payload), toolNameOf(result), meta.name)
      if (name !== undefined) {
        updateRecord(record, {
          name,
          kind: isMcpToolName(name) ? 'mcp' : 'tool',
          id: `${isMcpToolName(name) ? 'mcp' : 'tool'}:${callId}`,
        })
      }
    }
    const attrs = attrsOf({
      source: meta.source,
      callId,
      isError: field(result, ['isError', 'is_error']) === true,
      errorCode: errorCodeOf(field(payload, ['error']) ?? field(result, ['error'])),
    })
    return finalizeRecord(record, {
      status: toolResultStatus(result ?? payload),
      endMs: firstValue(timeOf(result), meta.endMs, nowMs()) ?? nowMs(),
      attrs,
    })
  }

  /**
   * @param {unknown} payload
   * @param {{ source: string, sessionId?: string, time?: number }} meta
   * @returns {boolean}
   */
  function startApproval(payload, meta) {
    const approvalId = directTextField(payload, ['approvalId', 'requestId', 'id'])
    const callId = callIdOf(payload)
    const toolName = toolNameOf(payload)
    if (approvalId === undefined && callId === undefined && toolName === undefined) {
      return false
    }
    const primary = []
    if (approvalId !== undefined) primary.push(`approval:id:${approvalId}`)
    if (callId !== undefined) primary.push(`approval:call:${callId}`)
    const toolAlias = toolName !== undefined ? `approval:tool:${toolName}` : undefined
    const key =
      primary[0] ??
      toolAlias ??
      `approval:event:${stableKey(payload) ?? nowMs()}`
    const sessionId = firstText(sessionIdOf(payload), meta.sessionId) ?? UNKNOWN_SESSION
    const startMs = firstValue(timeOf(payload), meta.time, nowMs()) ?? nowMs()
    const name = toolName !== undefined ? `approval:${toolName}` : 'approval'
    const attrs = attrsOf({
      source: meta.source,
      approvalId,
      callId,
      toolName,
    })
    const agentPath = agentPathOf(payload)
    const record = ensureRecord([key, ...primary], {
      id: `approval:${approvalId ?? callId ?? toolName ?? stableKey(payload) ?? 'event'}`,
      sessionId,
      kind: 'approval',
      name,
      startMs,
      status: 'running',
      ...(agentPath !== undefined ? { agentPath } : {}),
      ...(attrs !== undefined ? { attrs } : {}),
    })
    // `toolName` is ambiguous when two approvals for the same tool overlap,
    // so it is only a secondary alias. It never decides a merge on its own.
    if (toolAlias !== undefined) addAliases(record, [toolAlias])
    return true
  }

  /**
   * @param {unknown} payload
   * @param {{ source: string, sessionId?: string, time?: number }} meta
   * @returns {boolean}
   */
  function decideApproval(payload, meta) {
    const approvalId = directTextField(payload, ['approvalId', 'requestId', 'id'])
    const callId = callIdOf(payload)
    const toolName = toolNameOf(payload)
    if (approvalId === undefined && callId === undefined && toolName === undefined) {
      return false
    }
    const primary = []
    if (approvalId !== undefined) primary.push(`approval:id:${approvalId}`)
    if (callId !== undefined) primary.push(`approval:call:${callId}`)
    const toolAlias = toolName !== undefined ? `approval:tool:${toolName}` : undefined
    let record = findRecord(primary)
    const toolRecord = toolAlias !== undefined ? aliases.get(toolAlias) : undefined
    if (record === undefined && toolRecord !== undefined && !toolRecord.done) {
      record = toolRecord
    }
    const endMs = firstValue(timeOf(payload), meta.time, nowMs()) ?? nowMs()
    if (record === undefined) {
      const key =
        primary[0] ??
        (toolRecord === undefined && toolAlias !== undefined
          ? toolAlias
          : `approval:event:${stableKey(payload) ?? endMs}`)
      record = ensureRecord([key, ...primary], {
        id: `approval:${approvalId ?? callId ?? toolName ?? endMs}`,
        sessionId: firstText(sessionIdOf(payload), meta.sessionId) ?? UNKNOWN_SESSION,
        kind: 'approval',
        name: toolName !== undefined ? `approval:${toolName}` : 'approval',
        startMs: endMs,
        status: 'running',
      })
    }
    const outcome = textField(payload, ['outcome', 'decision', 'status'])
    const attrs = attrsOf({
      source: meta.source,
      approvalId,
      callId,
      toolName,
      outcome,
    })
    return finalizeRecord(record, {
      status: statusText(payload) ?? 'ok',
      endMs,
      attrs,
    })
  }

  /**
   * @param {unknown} payload
   * @param {{ source: string, sessionId?: string, time?: number }} meta
   * @returns {boolean}
   */
  function startSubagent(payload, meta) {
    const runId = textField(payload, ['runId', 'id'])
    if (runId === undefined) return false
    const childId = textField(payload, ['childId', 'id'])
    const sessionId =
      firstText(textField(payload, ['parentSessionId']), meta.sessionId, sessionIdOf(payload), childId) ??
      UNKNOWN_SESSION
    const startMs = firstValue(timeOf(payload), meta.time, nowMs()) ?? nowMs()
    const attrs = attrsOf({
      source: meta.source,
      runId,
      childId,
      provider: textField(payload, ['provider']),
      local: field(payload, ['local']),
    })
    const agentPath = agentPathOf(payload)
    ensureRecord([`subagent:${runId}`, `subagent:${childId ?? runId}`], {
      id: `subagent:${runId}`,
      sessionId,
      kind: 'subagent',
      name: 'subagent',
      startMs,
      status: 'running',
      ...(agentPath !== undefined ? { agentPath } : {}),
      ...(attrs !== undefined ? { attrs } : {}),
    })
    return true
  }

  /**
   * @param {unknown} payload
   * @param {{ source: string, sessionId?: string, time?: number }} meta
   * @returns {boolean}
   */
  function endSubagent(payload, meta) {
    const runId = textField(payload, ['runId', 'id'])
    if (runId === undefined) return false
    const endMs = firstValue(timeOf(payload), meta.time, nowMs()) ?? nowMs()
    let record = findRecord([`subagent:${runId}`])
    if (record === undefined) {
      record = ensureRecord(
        [`subagent:${runId}`],
        {
          id: `subagent:${runId}`,
          sessionId:
            firstText(textField(payload, ['parentSessionId']), sessionIdOf(payload), meta.sessionId) ??
            UNKNOWN_SESSION,
          kind: 'subagent',
          name: 'subagent',
          startMs: endMs,
          status: 'running',
        },
      )
    }
    const stopReason = textField(payload, ['stopReason', 'status'])
    const attrs = attrsOf({
      source: meta.source,
      runId,
      stopReason,
      childId: textField(payload, ['childId', 'id']),
    })
    return finalizeRecord(record, {
      status: stopReason === 'completed' || stopReason === undefined ? 'ok' : 'error',
      endMs,
      attrs,
    })
  }

  /**
   * @param {unknown} payload
   * @param {{ source: string, sessionId?: string, time?: number }} meta
   * @returns {boolean}
   */
  function startJob(payload, meta) {
    const jobId = textField(payload, ['jobId', 'id'])
    if (jobId === undefined) return false
    const startedAt = numberField(payload, ['startedAt', 'started_at', 'startMs', 'time', 'timestamp'])
    const startMs = firstValue(startedAt, meta.time, nowMs()) ?? nowMs()
    const label = textField(payload, ['label', 'name'])
    const kind = textField(payload, ['kind'])
    const attrs = attrsOf({
      source: meta.source,
      jobId,
      kind,
      owner: textField(payload, ['owner']),
      toolCallId: isRecord(field(payload, ['toolCall'])) ? textField(field(payload, ['toolCall']), ['callId']) : undefined,
      rootCallId: isRecord(field(payload, ['toolCall'])) ? textField(field(payload, ['toolCall']), ['rootCallId']) : undefined,
    })
    const agentPath = agentPathOf(payload)
    ensureRecord([`job:${jobId}`], {
      id: `job:${jobId}`,
      sessionId: firstText(textField(payload, ['owner']), sessionIdOf(payload), meta.sessionId) ?? UNKNOWN_SESSION,
      kind: 'job',
      name: label ?? kind ?? 'job',
      startMs,
      status: 'running',
      ...(agentPath !== undefined ? { agentPath } : {}),
      ...(attrs !== undefined ? { attrs } : {}),
    })
    return true
  }

  /**
   * @param {unknown} payload
   * @param {{ source: string, sessionId?: string, time?: number }} meta
   * @returns {boolean}
   */
  function endJob(payload, meta) {
    const jobId = textField(payload, ['jobId', 'id'])
    if (jobId === undefined) return false
    const finishedAt = numberField(payload, ['finishedAt', 'finished_at', 'endMs', 'time', 'timestamp'])
    const endMs = firstValue(finishedAt, meta.time, nowMs()) ?? nowMs()
    let record = findRecord([`job:${jobId}`])
    if (record === undefined) {
      const startedAt = numberField(payload, ['startedAt', 'started_at', 'startMs'])
      record = ensureRecord([`job:${jobId}`], {
        id: `job:${jobId}`,
        sessionId: firstText(textField(payload, ['owner']), sessionIdOf(payload), meta.sessionId) ?? UNKNOWN_SESSION,
        kind: 'job',
        name: textField(payload, ['label', 'name', 'kind']) ?? 'job',
        startMs: firstValue(startedAt, endMs) ?? endMs,
        status: 'running',
      })
    }
    const status = textField(payload, ['status', 'outcome'])
    const attrs = attrsOf({
      source: meta.source,
      jobId,
      status,
      cause: textField(payload, ['cause']),
      producerReported: field(payload, ['producerReported']),
    })
    return finalizeRecord(record, {
      status: status === undefined || status === 'completed' ? 'ok' : 'error',
      endMs,
      attrs,
    })
  }

  /**
   * @param {unknown} payload
   * @param {string} eventName
   * @returns {string|undefined}
   */
  function familyIdOf(payload, eventName) {
    const direct = textField(payload, [
      'id',
      'runId',
      'jobId',
      'callId',
      'toolCallId',
      'requestId',
      'approvalId',
      'agentId',
      'serverName',
      'server',
      'name',
      'toolName',
    ])
    if (direct !== undefined) return direct
    return stableKey({ event: eventName, payload })
  }

  /**
   * Generic family mapper used for events without a dedicated handler. It is
   * intentionally permissive: an unrecognized lifecycle suffix becomes a
   * point-in-time span instead of a dropped audit record.
   *
   * @param {string} eventName
   * @param {unknown} payload
   * @param {string} source
   * @returns {boolean}
   */
  function observeFamily(eventName, payload, source) {
    const kind = familySpanKind(eventName)
    if (kind === undefined) return false
    const action = actionOf(eventName)
    const family = familyOf(eventName)
    if (family === undefined) return false
    const id = familyIdOf(payload, eventName)
    const key = `${family}:event:${id ?? eventName}`
    const sessionId = sessionIdOf(payload) ?? UNKNOWN_SESSION
    const at = firstValue(timeOf(payload), nowMs()) ?? nowMs()
    const label = firstText(
      toolNameOf(payload),
      textField(payload, ['label', 'name']),
      eventName,
    ) ?? eventName
    const attrs = attrsOf({
      source,
      event: eventName,
      id,
      status: stateLabelOf(payload),
    })
    if (action === 'start') {
      ensureRecord([key], {
        id: key,
        sessionId,
        kind,
        name: label,
        startMs: at,
        status: 'running',
        ...(attrs !== undefined ? { attrs } : {}),
      })
      return true
    }
    if (action === 'end' || action === 'failure') {
      let record = findRecord([key])
      if (record === undefined) {
        record = ensureRecord([key], {
          id: key,
          sessionId,
          kind,
          name: label,
          startMs: at,
          status: 'running',
        })
      }
      return finalizeRecord(record, {
        status: action === 'failure' ? 'error' : (statusText(payload) ?? 'ok'),
        endMs: at,
        attrs,
      })
    }
    // Unknown suffix inside a covered family (stream frames, catalogs,
    // policies, ...) is not a lifecycle event: ignore it.
    return false
  }

  /**
   * @param {unknown} value
   * @returns {Record<string, unknown>|undefined}
   */
  function outerPayload(value) {
    if (!isRecord(value)) return undefined
    if (isRecord(value.exec)) return value.exec
    if (isRecord(value.event)) return value.event
    if (isRecord(value.info)) return value.info
    if (isRecord(value.request)) return value.request
    if (isRecord(value.job)) return value.job
    if (isRecord(value.subagent)) return value.subagent
    return value
  }

  /**
   * @param {unknown[]} args
   * @returns {unknown}
   */
  function firstPayload(args) {
    for (const arg of args) {
      if (isRecord(arg)) return outerPayload(arg) ?? arg
    }
    return undefined
  }

  /**
   * @param {unknown[]} args
   * @returns {boolean}
   */
  function onSessionEvent(args) {
    let session = args[0]
    let event = args[1]
    if (event === undefined && isRecord(session) && (session.type !== undefined || session.data !== undefined)) {
      event = session
      session = undefined
    }
    if (!isRecord(event)) return false
    const type = firstText(
      event.type,
      event.event,
      typeof event.name === 'string' && event.name.includes('/') ? event.name : undefined,
      event.kind,
    )
    if (type === undefined) return false
    const sessionId =
      firstText(sessionIdOfSession(session), sessionIdOf(event)) ?? UNKNOWN_SESSION
    const data = isRecord(event.data) ? event.data : event
    const at = firstValue(numberField(event, ['time', 'timestamp', 'at']), nowMs()) ?? nowMs()
    const turn = numberField(data, ['turn'])
    const step = numberField(data, ['step'])
    const stepId =
      turn !== undefined && step !== undefined
        ? `step:${sessionId}:${turn}:${step}`
        : undefined

    switch (type) {
      case 'tool/call':
        return startTool(data, {
          source: 'session/event',
          sessionId,
          startMs: at,
          parentId: stepId,
          turn,
          step,
        })
      case 'tool/result':
        return finishTool(data, data, {
          source: 'session/event',
          sessionId,
          endMs: at,
        })
      case 'approval/asked':
        return startApproval(data, {
          source: 'session/event',
          sessionId,
          time: at,
        })
      case 'approval/decided':
        return decideApproval(data, {
          source: 'session/event',
          sessionId,
          time: at,
        })
      case 'job/registered':
        return startJob(data, {
          source: 'session/event',
          sessionId,
          time: at,
        })
      case 'job/settled':
        return endJob(data, {
          source: 'session/event',
          sessionId,
          time: at,
        })
      case 'turn/start': {
        if (turn === undefined) return false
        const id = `turn:${sessionId}:${turn}`
        ensureRecord([id], {
          id,
          sessionId,
          kind: 'session',
          name: `turn:${turn}`,
          startMs: at,
          status: 'running',
          attrs: attrsOf({ source: 'session/event', turn }),
        })
        return true
      }
      case 'turn/end': {
        if (turn === undefined) return false
        const id = `turn:${sessionId}:${turn}`
        let record = findRecord([id])
        if (record === undefined) {
          record = ensureRecord([id], {
            id,
            sessionId,
            kind: 'session',
            name: `turn:${turn}`,
            startMs: at,
            status: 'running',
          })
        }
        return finalizeRecord(record, {
          status: turnEndStatus(field(data, ['reason'])),
          endMs: at,
          attrs: attrsOf({ source: 'session/event', turn, reason: textField(field(data, ['reason']), ['kind']) }),
        })
      }
      case 'step/start': {
        if (turn === undefined || step === undefined) return false
        const id = `step:${sessionId}:${turn}:${step}`
        ensureRecord([id], {
          id,
          sessionId,
          kind: 'session',
          name: `step:${step}`,
          startMs: at,
          status: 'running',
          ...(stepId !== undefined ? { parentId: `turn:${sessionId}:${turn}` } : {}),
          attrs: attrsOf({ source: 'session/event', turn, step }),
        })
        return true
      }
      case 'step/end': {
        if (turn === undefined || step === undefined) return false
        const id = `step:${sessionId}:${turn}:${step}`
        let record = findRecord([id])
        if (record === undefined) {
          record = ensureRecord([id], {
            id,
            sessionId,
            kind: 'session',
            name: `step:${step}`,
            startMs: at,
            status: 'running',
            parentId: `turn:${sessionId}:${turn}`,
            attrs: attrsOf({ source: 'session/event', turn, step }),
          })
        }
        return finalizeRecord(record, {
          status: 'ok',
          endMs: at,
          attrs: attrsOf({ source: 'session/event', turn, step }),
        })
      }
      default:
        return false
    }
  }

  /**
   * @param {unknown[]} args
   * @returns {boolean}
   */
  function onPreExecute(args) {
    const exec = outerPayload(args[0])
    if (exec === undefined) return false
    return startTool(exec, {
      source: 'tools/pre-execute',
      sessionId: sessionIdOf(exec),
      startMs: nowMs(),
    })
  }

  /**
   * @param {unknown[]} args
   * @returns {boolean}
   */
  function onPostExecute(args) {
    const exec = outerPayload(args[0])
    const result =
      args[1] ?? (isRecord(args[0]) && isRecord(args[0].result) ? args[0].result : undefined)
    if (exec === undefined) return false
    return finishTool(exec, result, {
      source: 'tools/post-execute',
      sessionId: sessionIdOf(exec),
      endMs: nowMs(),
    })
  }

  /**
   * @param {unknown[]} args
   * @returns {boolean}
   */
  function onToolResult(args) {
    let callId
    let result
    let payload
    for (const arg of args) {
      if (typeof arg === 'string' && callId === undefined) {
        callId = arg
        continue
      }
      if (isRecord(arg)) {
        payload ??= arg
        if (isRecord(arg.result)) result = arg.result
        else if (result === undefined && (arg.isError !== undefined || arg.content !== undefined)) {
          result = arg
        }
        if (callId === undefined) callId = toolCallIdOf(arg)
      }
    }
    if (callId === undefined) callId = toolCallIdOf(payload) ?? toolCallIdOf(result)
    if (callId === undefined) return false
    return finishTool(payload, result ?? payload, {
      source: 'tool/result',
      sessionId: sessionIdOf(payload) ?? sessionIdOf(result),
      endMs: nowMs(),
    })
  }

  /**
   * @param {unknown[]} args
   * @param {string} source
   * @returns {boolean}
   */
  function onApprovalStart(args, source) {
    const payload = firstPayload(args)
    if (payload === undefined) return false
    return startApproval(payload, {
      source,
      sessionId: sessionIdOf(payload),
      time: nowMs(),
    })
  }

  /**
   * @param {unknown[]} args
   * @param {string} source
   * @returns {boolean}
   */
  function onApprovalDecision(args, source) {
    const payload = firstPayload(args)
    if (payload === undefined) return false
    return decideApproval(payload, {
      source,
      sessionId: sessionIdOf(payload),
      time: nowMs(),
    })
  }

  /**
   * @param {unknown[]} args
   * @param {string} source
   * @returns {boolean}
   */
  function onSubagentStart(args, source) {
    const payload = firstPayload(args)
    if (payload === undefined) return false
    return startSubagent(payload, {
      source,
      sessionId: sessionIdOf(payload),
      time: nowMs(),
    })
  }

  /**
   * @param {unknown[]} args
   * @param {string} source
   * @returns {boolean}
   */
  function onSubagentEnd(args, source) {
    const payload = firstPayload(args)
    if (payload === undefined) return false
    return endSubagent(payload, {
      source,
      sessionId: sessionIdOf(payload),
      time: nowMs(),
    })
  }

  /**
   * @param {unknown[]} args
   * @param {string} source
   * @returns {boolean}
   */
  function onJobStart(args, source) {
    const payload = firstPayload(args)
    if (payload === undefined) return false
    return startJob(payload, {
      source,
      sessionId: sessionIdOf(payload),
      time: nowMs(),
    })
  }

  /**
   * @param {unknown[]} args
   * @param {string} source
   * @returns {boolean}
   */
  function onJobEnd(args, source) {
    const payload = firstPayload(args)
    if (payload === undefined) return false
    return endJob(payload, {
      source,
      sessionId: sessionIdOf(payload),
      time: nowMs(),
    })
  }

  /**
   * @param {unknown[]} args
   * @param {string} source
   * @returns {boolean}
   */
  function onAgentStart(args, source) {
    const payload = firstPayload(args)
    if (payload === undefined) return false
    const agent = isRecord(payload) && isRecord(payload.agent) ? payload.agent : payload
    const agentId = firstText(
      isRecord(agent) ? agent.id : undefined,
      textField(payload, ['agentId']),
      sessionIdOf(payload),
    )
    if (agentId === undefined) return false
    const startMs = nowMs()
    const attrs = attrsOf({
      source,
      agentId,
      origin: isRecord(payload) && isRecord(payload.source) ? textField(payload.source, ['kind']) : textField(payload, ['source']),
    })
    const agentPath = agentPathOf(payload)
    ensureRecord([`agent:${agentId}`], {
      id: `agent:${agentId}`,
      sessionId: agentId,
      kind: 'session',
      name: 'agent',
      startMs,
      status: 'running',
      ...(agentPath !== undefined ? { agentPath } : {}),
      ...(attrs !== undefined ? { attrs } : {}),
    })
    return true
  }

  /**
   * @param {unknown[]} args
   * @param {string} source
   * @returns {boolean}
   */
  function onAgentStatus(args, source) {
    const payload = firstPayload(args)
    if (payload === undefined) return false
    const agent = isRecord(payload) && isRecord(payload.agent) ? payload.agent : payload
    const agentId = firstText(
      isRecord(agent) ? agent.id : undefined,
      textField(payload, ['agentId']),
      sessionIdOf(payload),
    )
    if (agentId === undefined) return false
    const status = stateLabelOf(payload)
    const agentPath = agentPathOf(payload)
    const record = ensureRecord([`agent:${agentId}`], {
      id: `agent:${agentId}`,
      sessionId: agentId,
      kind: 'session',
      name: 'agent',
      startMs: nowMs(),
      status: 'running',
      ...(agentPath !== undefined ? { agentPath } : {}),
    })
    updateRecord(record, {
      attrs: attrsOf({ source, status }),
    })
    return true
  }

  /**
   * @param {unknown[]} args
   * @param {string} source
   * @returns {boolean}
   */
  function onAgentEnd(args, source, status = 'ok') {
    const payload = firstPayload(args)
    if (payload === undefined) return false
    const agent = isRecord(payload) && isRecord(payload.agent) ? payload.agent : payload
    const agentId = firstText(
      isRecord(agent) ? agent.id : undefined,
      textField(payload, ['agentId']),
      sessionIdOf(payload),
    )
    if (agentId === undefined) return false
    const endMs = nowMs()
    let record = findRecord([`agent:${agentId}`])
    if (record === undefined) {
      record = ensureRecord([`agent:${agentId}`], {
        id: `agent:${agentId}`,
        sessionId: agentId,
        kind: 'session',
        name: 'agent',
        startMs: endMs,
        status: 'running',
      })
    }
    return finalizeRecord(record, {
      status,
      endMs,
      attrs: attrsOf({
        source,
        agentId,
        errorCode: errorCodeOf(field(payload, ['error'])),
      }),
    })
  }

  /**
   * @param {string} name
   * @param {unknown[]} args
   * @returns {boolean}
   */
  function dispatch(name, args) {
    switch (name) {
      case 'session/event':
        return onSessionEvent(args)
      case 'tools/pre-execute':
        return onPreExecute(args)
      case 'tools/post-execute':
        return onPostExecute(args)
      case 'tool/result':
      case 'tools/result':
        return onToolResult(args)
      case 'approval/request':
      case 'approval/asked':
        return onApprovalStart(args, name)
      case 'approval/decided':
      case 'approval/resolved':
        return onApprovalDecision(args, name)
      case 'agent/created':
        return onAgentStart(args, name)
      case 'agent/status':
        return onAgentStatus(args, name)
      case 'agent/error':
        return onAgentEnd(args, name, 'error')
      case 'agent/disposed':
        return onAgentEnd(args, name, 'ok')
      case 'subagent/start':
        return onSubagentStart(args, name)
      case 'subagent/end':
        return onSubagentEnd(args, name)
      case 'job/registered':
      case 'job/start':
        return onJobStart(args, name)
      case 'job/settled':
      case 'job/end':
        return onJobEnd(args, name)
      default:
        if (isFamilyEventName(name) && isLifecycleEventName(name)) {
          return observeFamily(name, firstPayload(args), name)
        }
        return false
    }
  }

  /**
   * @param {string} name
   * @param {unknown[]} args
   */
  function observe(name, args) {
    events += 1
    eventsByName.set(name, (eventsByName.get(name) ?? 0) + 1)
    lastEventAt = nowMs()
    let didMap = false
    try {
      didMap = dispatch(name, args)
    } catch (error) {
      recordError(error)
    }
    if (didMap) mappedEvents += 1
    else ignored += 1
  }

  /**
   * @param {string} name
   * @returns {(...args: unknown[]) => unknown}
   */
  function makeHandler(name) {
    if (WATERFALL_EVENTS.has(name)) {
      return (...args) => {
        try {
          observe(name, args)
        } catch (error) {
          recordError(error)
        }
        const next = args.length > 0 ? args[args.length - 1] : undefined
        return isFunction(next) ? next() : undefined
      }
    }
    return (...args) => {
      try {
        observe(name, args)
      } catch (error) {
        recordError(error)
      }
      return undefined
    }
  }

  /**
   * Wildcard patterns are opaque names in Cordis. If a host supports wildcard
   * routing, recover the concrete event name from either the first argument
   * (some routers prepend it) or a `type`/`event`/`name` field on the payload.
   * The concrete subscriptions above cover this build's known events anyway.
   *
   * @param {unknown[]} args
   * @param {string} family
   * @returns {boolean}
   */
  function wildcardObserve(args, family) {
    const first = args[0]
    if (typeof first === 'string' && first.includes('/')) {
      observe(first, args.slice(1))
      return true
    }
    if (!isRecord(first)) return false
    const named = firstText(first.type, first.event, first.name)
    if (named === undefined || !named.startsWith(`${family}/`)) return false
    observe(named, args)
    return true
  }

  /**
   * @returns {void}
   */
  function detach() {
    const current = hooks
    hooks = []
    attached = false
    for (const hook of current) {
      try {
        if (isFunction(hook.dispose)) hook.dispose()
      } catch {
        // A host disposer failure cannot roll back already-removed hooks.
      }
    }
  }

  /**
   * @param {unknown} ctx
   * @returns {boolean}
   */
  function attach(ctx) {
    if (attached) return true
    if (!isRecord(ctx) || !isFunction(ctx.on)) {
      lastError = 'ctx.on is not available; live ingest is disabled'
      return false
    }
    const add = (eventName, handler) => {
      try {
        const dispose = ctx.on(eventName, handler)
        hooks.push({ name: eventName, dispose })
      } catch (error) {
        recordError(error)
      }
    }

    for (const eventName of CORE_INGEST_EVENTS) {
      add(eventName, makeHandler(eventName))
    }
    for (const pattern of FAMILY_INGEST_EVENTS) {
      const family = pattern.slice(0, -2)
      add(pattern, (...args) => {
        try {
          wildcardObserve(args, family)
        } catch (error) {
          recordError(error)
        }
      })
    }
    for (const eventName of CONCRETE_FAMILY_EVENTS) {
      add(eventName, makeHandler(eventName))
    }
    add(INTERNAL_DISPATCH, (...args) => {
      // internal/dispatch args: (mode, concreteName, originalArgs, thisArg).
      const concreteName = args[1]
      const originalArgs = args[2]
      if (typeof concreteName !== 'string' || !Array.isArray(originalArgs)) return
      if (CONCRETE_FAMILY_EVENT_SET.has(concreteName)) return
      if (CORE_EVENT_SET.has(concreteName)) return
      if (!isFamilyEventName(concreteName)) return
      if (!isLifecycleEventName(concreteName)) return
      try {
        observe(concreteName, originalArgs)
      } catch (error) {
        recordError(error)
      }
    })

    attached = hooks.length > 0
    return attached
  }

  /**
   * @returns {object[]}
   */
  function spans() {
    return [...records.values()]
      .sort((left, right) => {
        const byTime = left.span.startMs - right.span.startMs
        return byTime !== 0 ? byTime : left.order - right.order
      })
      .map((record) => cloneJson(record.stored ?? record.span))
  }

  /**
   * @returns {Record<string, unknown>}
   */
  function status() {
    let finalized = 0
    let running = 0
    let failed = 0
    for (const record of records.values()) {
      if (!record.done) running += 1
      else if (record.failed) failed += 1
      else finalized += 1
    }
    return {
      attached,
      subscriptions: hooks.length,
      subscribed: hooks.map((hook) => hook.name),
      wildcard: hooks.some((hook) => hook.name === INTERNAL_DISPATCH),
      events,
      mapped: mappedEvents,
      ignored,
      errors,
      finalized,
      running,
      failed,
      lastEventAt,
      lastError,
      eventsByName: [...eventsByName.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }
  }

  const api = { attach, detach, spans }
  // `status` is used by the trace_live_status tool but is not part of the
  // three-function collector contract, so keep it non-enumerable.
  Object.defineProperty(api, 'status', {
    value: status,
    enumerable: false,
    configurable: true,
    writable: false,
  })
  return api
}
