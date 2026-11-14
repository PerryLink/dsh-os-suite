/**
 * Pure core logic for dsh-os-trace.
 *
 * No `@deepseek-ai/*` imports live here, so the whole audit store is testable
 * offline with `node --test`. The store is an in-memory append-only chain; all
 * state is closure-local to one `createTraceStore()` call.
 */

import { createHash } from 'node:crypto'

/** Bundle format marker written by `exportBundle` and checked by `verifyBundle`. */
export const TRACE_FORMAT = 'dsh-os-trace/bundle'
/** Bundle schema version. Bumped when the on-disk shape changes. */
export const TRACE_VERSION = 1
/** Hash algorithm used for the per-span chain. */
export const HASH_ALGO = 'sha256'
/** `prevHash` of the first span in a chain. */
export const GENESIS_PREV_HASH = '0'.repeat(64)
/** Placeholder written by the field-name redactor. */
export const REDACTED = '[redacted]'
/** Default ancestor/descendant hop limit for `why`. */
export const DEFAULT_WHY_DEPTH = 4
/** Hard cap for `why` to keep one call bounded. */
export const MAX_WHY_DEPTH = 64

/** All span kinds understood by this MVP. */
export const SPAN_KINDS = Object.freeze([
  'tool',
  'subagent',
  'job',
  'approval',
  'mcp',
  'workflow',
])

/** All lifecycle states understood by this MVP. */
export const SPAN_STATUSES = Object.freeze(['ok', 'error', 'running'])

/**
 * @typedef {'tool'|'subagent'|'job'|'approval'|'mcp'|'workflow'} SpanKind
 * @typedef {'ok'|'error'|'running'} SpanStatus
 */

/**
 * One recorded causal event.
 *
 * The stored/exported shape always carries `hash` and `prevHash`. Callers pass
 * a span without those two fields (or with stale values); `ingest` recomputes
 * both so the store owns the chain.
 *
 * @typedef {object} Span
 * @property {string} id Stable event id, unique within one store.
 * @property {string} [parentId] Causal parent event id.
 * @property {string} sessionId DSH session that produced the event.
 * @property {string} [agentPath] Agent path, for example `lead/researcher`.
 * @property {SpanKind} kind Event category.
 * @property {string} name Human-readable operation name.
 * @property {number} startMs Epoch milliseconds.
 * @property {number} [endMs] Epoch milliseconds; absent while running.
 * @property {SpanStatus} status Lifecycle state.
 * @property {Record<string, unknown>} [attrs] Free-form, JSON-serializable attributes.
 * @property {string} hash sha256 chain hash.
 * @property {string} prevHash Hash of the previous span, or the genesis hash.
 */

/**
 * Input accepted by `ingest`; `hash` and `prevHash` are ignored and recomputed.
 *
 * @typedef {Omit<Span, 'hash' | 'prevHash'> & {
 *   hash?: string,
 *   prevHash?: string,
 * }} SpanInput
 */

/**
 * @typedef {object} TraceFilter
 * @property {string} [id] Exact event id.
 * @property {string} [sessionId] Exact session id.
 * @property {string|null} [parentId] Exact parent id; `null` selects roots.
 * @property {string} [agentPath] Exact agent path.
 * @property {SpanKind|SpanKind[]} [kind] One kind or a list of kinds.
 * @property {SpanStatus|SpanStatus[]} [status] One status or a list of statuses.
 * @property {string} [name] Exact operation name.
 * @property {number} [since] Keep spans with `startMs >= since`.
 * @property {number} [until] Keep spans with `startMs <= until`.
 * @property {number} [limit] Maximum number of results after sorting.
 * @property {'asc'|'desc'} [order] Start-time order, default `asc`.
 */

/**
 * @typedef {object} CausalEdge
 * @property {string} parentId
 * @property {string} childId
 */

/**
 * @typedef {object} WhyResult
 * @property {string} eventId
 * @property {boolean} found
 * @property {Span|null} target
 * @property {number} depth
 * @property {Span[]} spans Chronological path, including target.
 * @property {CausalEdge[]} edges Parent-to-child links inside the path.
 * @property {string[]} missing Referenced ids that could not be resolved.
 * @property {boolean} truncated Whether a hop limit stopped a longer chain.
 */

/**
 * @typedef {object} TraceBundle
 * @property {string} format
 * @property {number} version
 * @property {string} hashAlgo
 * @property {number} exportedAt
 * @property {number} spanCount
 * @property {string} rootHash
 * @property {string} sourceRootHash Root hash before redaction/re-sealing.
 * @property {string} genesisPrevHash
 * @property {{ fields: string[], applied: boolean }} redaction
 * @property {Span[]} spans
 */

/**
 * @typedef {object} BadSpan
 * @property {number} index Zero-based span index, or -1 for bundle-level problems.
 * @property {string|null} id Span id when readable.
 * @property {string} reason Machine-readable-ish explanation.
 * @property {unknown} [expected]
 * @property {unknown} [actual]
 */

/**
 * @typedef {object} VerifyResult
 * @property {boolean} ok
 * @property {number} count
 * @property {number} checked Number of spans fully verified before a failure.
 * @property {string|null} rootHash Computed final hash, or bundle value when unreadable.
 * @property {BadSpan|null} firstBad
 */

/**
 * Error with a stable code so plugin wrappers can report failures consistently.
 */
export class TraceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'TraceError'
    this.code = code
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TraceError('INVALID_SPAN', `${label} must be a non-empty string`)
  }
  return value
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireString(value, label) {
  if (typeof value !== 'string') {
    throw new TraceError('INVALID_SPAN', `${label} must be a string`)
  }
  return value
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} label
 * @returns {string}
 */
function requireEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TraceError(
      'INVALID_SPAN',
      `${label} must be one of: ${allowed.join(', ')}`,
    )
  }
  return value
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function requireFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TraceError('INVALID_SPAN', `${label} must be a finite number`)
  }
  return value
}

/**
 * Deep-copy a JSON value. Used to keep returned spans detached from the store.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Canonical JSON: object keys sorted recursively, no insignificant whitespace.
 * This is deliberately small and stable; it is not RFC 8785.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  /**
   * @param {unknown} input
   * @param {Set<object>} stack
   * @returns {unknown}
   */
  function walk(input, stack) {
    if (input === null) return null
    const type = typeof input
    if (type === 'string' || type === 'boolean') return input
    if (type === 'number') {
      if (!Number.isFinite(input)) {
        throw new TraceError('INVALID_SPAN', 'canonical JSON cannot encode a non-finite number')
      }
      return input
    }
    if (type === 'undefined') return undefined
    if (type === 'bigint') {
      throw new TraceError('INVALID_SPAN', 'canonical JSON cannot encode a bigint')
    }
    if (type !== 'object') {
      throw new TraceError('INVALID_SPAN', `canonical JSON cannot encode a ${type}`)
    }
    if (stack.has(/** @type {object} */ (input))) {
      throw new TraceError('INVALID_SPAN', 'canonical JSON cannot encode a cycle')
    }
    stack.add(/** @type {object} */ (input))
    try {
      if (Array.isArray(input)) {
        return input.map((entry) => {
          const encoded = walk(entry, stack)
          return encoded === undefined ? null : encoded
        })
      }
      /** @type {Record<string, unknown>} */
      const out = {}
      for (const key of Object.keys(input).sort()) {
        const encoded = walk(/** @type {Record<string, unknown>} */ (input)[key], stack)
        if (encoded !== undefined) {
          Object.defineProperty(out, key, {
            value: encoded,
            enumerable: true,
            configurable: true,
            writable: true,
          })
        }
      }
      return out
    } finally {
      stack.delete(/** @type {object} */ (input))
    }
  }

  const text = JSON.stringify(walk(value, new Set()))
  if (text === undefined) {
    throw new TraceError('INVALID_SPAN', 'value is not representable as JSON')
  }
  return text
}

/**
 * Hash recipe:
 *   payload = canonicalJson(span without `hash`, still including `prevHash`)
 *   hash    = sha256(prevHash + payload)
 *
 * @param {Span} span
 * @returns {string}
 */
export function computeSpanHash(span) {
  if (typeof span.prevHash !== 'string') {
    throw new TraceError('INVALID_SPAN', 'span.prevHash must be a string before hashing')
  }
  const payload = { ...span }
  delete payload.hash
  return createHash(HASH_ALGO).update(span.prevHash + canonicalJson(payload), 'utf8').digest('hex')
}

/**
 * Validate and normalize a caller-supplied span. Unknown top-level fields are
 * rejected so a typo cannot silently become an unhashed field.
 *
 * @param {SpanInput} input
 * @returns {Omit<Span, 'hash' | 'prevHash'>}
 */
export function normalizeSpan(input) {
  if (!isRecord(input)) {
    throw new TraceError('INVALID_SPAN', 'span must be an object')
  }
  const allowed = new Set([
    'id',
    'parentId',
    'sessionId',
    'agentPath',
    'kind',
    'name',
    'startMs',
    'endMs',
    'status',
    'attrs',
    'hash',
    'prevHash',
  ])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new TraceError('INVALID_SPAN', `span.${key} is not a supported field`)
    }
  }

  const id = requireNonEmptyString(input.id, 'span.id')
  const sessionId = requireNonEmptyString(input.sessionId, 'span.sessionId')
  const kind = /** @type {SpanKind} */ (requireEnum(input.kind, SPAN_KINDS, 'span.kind'))
  const name = requireNonEmptyString(input.name, 'span.name')
  const startMs = requireFiniteNumber(input.startMs, 'span.startMs')
  const status = /** @type {SpanStatus} */ (
    requireEnum(input.status, SPAN_STATUSES, 'span.status')
  )

  /** @type {Omit<Span, 'hash' | 'prevHash'>} */
  const span = { id }
  if (input.parentId !== undefined) {
    const parentId = requireNonEmptyString(input.parentId, 'span.parentId')
    if (parentId === id) {
      throw new TraceError('CAUSAL_CYCLE', `span "${id}" cannot be its own parent`)
    }
    span.parentId = parentId
  }
  span.sessionId = sessionId
  if (input.agentPath !== undefined) {
    span.agentPath = requireString(input.agentPath, 'span.agentPath')
  }
  span.kind = kind
  span.name = name
  span.startMs = startMs
  if (input.endMs !== undefined) {
    const endMs = requireFiniteNumber(input.endMs, 'span.endMs')
    if (endMs < startMs) {
      throw new TraceError('INVALID_SPAN', 'span.endMs must be greater than or equal to span.startMs')
    }
    span.endMs = endMs
  }
  span.status = status
  if (input.attrs !== undefined) {
    if (!isRecord(input.attrs)) {
      throw new TraceError('INVALID_SPAN', 'span.attrs must be an object')
    }
    let attrs
    try {
      attrs = cloneJson(input.attrs)
    } catch (error) {
      throw new TraceError(
        'INVALID_SPAN',
        `span.attrs must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!isRecord(attrs)) {
      throw new TraceError('INVALID_SPAN', 'span.attrs must serialize to an object')
    }
    span.attrs = attrs
  }
  return span
}

/**
 * @param {readonly Span[]} spans
 * @param {Map<string, number>} ingestOrder
 * @returns {Span[]}
 */
function sortChronologically(spans, ingestOrder) {
  return [...spans].sort((left, right) => {
    if (left.startMs !== right.startMs) return left.startMs - right.startMs
    return (ingestOrder.get(left.id) ?? 0) - (ingestOrder.get(right.id) ?? 0)
  })
}

/**
 * @param {object} state
 * @param {Span[]} state.spans
 * @param {Map<string, Span>} state.byId
 * @param {Map<string, Span[]>} state.childrenByParent
 * @param {Map<string, number>} state.ingestOrder
 * @param {string} eventId
 * @param {number} depth
 * @returns {WhyResult}
 */
function buildWhy(state, eventId, depth) {
  const target = state.byId.get(eventId)
  if (target === undefined) {
    return {
      eventId,
      found: false,
      target: null,
      depth,
      spans: [],
      edges: [],
      missing: [eventId],
      truncated: false,
    }
  }

  /** @type {Map<string, Span>} */
  const included = new Map([[target.id, target]])
  /** @type {string[]} */
  const missing = []
  let truncated = false

  // Upward: follow at most `depth` parent links.
  let current = target
  for (let hop = 0; hop < depth; hop += 1) {
    if (current.parentId === undefined) break
    const parent = state.byId.get(current.parentId)
    if (parent === undefined) {
      missing.push(current.parentId)
      break
    }
    if (included.has(parent.id)) break // defensive; ingest rejects cycles
    included.set(parent.id, parent)
    current = parent
  }
  if (
    current.parentId !== undefined &&
    !included.has(current.parentId) &&
    state.byId.has(current.parentId)
  ) {
    truncated = true
  }

  // Downward: breadth-first through children, capped at `depth` hops.
  /** @type {{ span: Span, hop: number }[]} */
  const queue = [{ span: target, hop: 0 }]
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index]
    const children = state.childrenByParent.get(item.span.id) ?? []
    if (children.length === 0) continue
    if (item.hop === depth) {
      truncated = true
      continue
    }
    for (const child of children) {
      if (included.has(child.id)) continue
      included.set(child.id, child)
      const childHop = item.hop + 1
      if (childHop < depth) {
        queue.push({ span: child, hop: childHop })
      } else if ((state.childrenByParent.get(child.id)?.length ?? 0) > 0) {
        truncated = true
      }
    }
  }

  const spans = sortChronologically([...included.values()], state.ingestOrder)
  /** @type {CausalEdge[]} */
  const edges = []
  for (const span of spans) {
    if (span.parentId !== undefined && included.has(span.parentId)) {
      edges.push({ parentId: span.parentId, childId: span.id })
    }
  }

  return {
    eventId,
    found: true,
    target: cloneJson(target),
    depth,
    spans: spans.map((span) => cloneJson(span)),
    edges,
    missing,
    truncated,
  }
}

/**
 * Recursively replace values whose object key matches one of `fields`
 * (case-insensitive). Only key names are matched; string contents are untouched.
 *
 * @param {unknown} value
 * @param {Set<string>} keys Lower-cased field names.
 * @returns {unknown}
 */
function redactValue(value, keys) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, keys))
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        keys.has(key.toLowerCase()) ? REDACTED : redactValue(entry, keys),
      ]),
    )
  }
  return value
}

/**
 * Recompute prevHash/hash for every span in order. Used after redaction, when
 * the old hashes no longer describe the exported bytes.
 *
 * @param {Span[]} spans
 * @returns {Span[]}
 */
function sealSpans(spans) {
  let prevHash = GENESIS_PREV_HASH
  return spans.map((span) => {
    /** @type {Span} */
    const next = { ...span, prevHash, hash: '' }
    next.hash = computeSpanHash(next)
    prevHash = next.hash
    return next
  })
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeRedactFields(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new TraceError('INVALID_REDACTION', 'redact must be an array of field names')
  }
  /** @type {string[]} */
  const fields = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new TraceError('INVALID_REDACTION', 'redact entries must be non-empty strings')
    }
    const field = entry.trim()
    const key = field.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      fields.push(field)
    }
  }
  return fields
}

/**
 * @param {object} state
 * @param {string[]} fields
 * @returns {TraceBundle}
 */
function buildBundle(state, fields) {
  const sourceRootHash =
    state.spans.length === 0 ? GENESIS_PREV_HASH : state.spans[state.spans.length - 1].hash
  /** @type {Span[]} */
  let spans = state.spans.map((span) => cloneJson(span))
  if (fields.length > 0) {
    const keys = new Set(fields.map((field) => field.toLowerCase()))
    spans = sealSpans(spans.map((span) => /** @type {Span} */ (redactValue(span, keys))))
  }
  const rootHash = spans.length === 0 ? GENESIS_PREV_HASH : spans[spans.length - 1].hash
  return {
    format: TRACE_FORMAT,
    version: TRACE_VERSION,
    hashAlgo: HASH_ALGO,
    exportedAt: 0, // replaced by the store after clock validation
    spanCount: spans.length,
    rootHash,
    sourceRootHash,
    genesisPrevHash: GENESIS_PREV_HASH,
    redaction: { fields, applied: fields.length > 0 },
    spans,
  }
}

/**
 * Create an isolated in-memory trace store.
 *
 * @param {{ now?: () => number }} [options]
 * @returns {{
 *   ingest: (span: SpanInput) => Span,
 *   query: (filter?: TraceFilter) => Span[],
 *   why: (eventId: string, depth?: number) => WhyResult,
 *   exportBundle: (options?: { redact?: string[] }) => TraceBundle,
 *   verifyBundle: (bundle: unknown) => VerifyResult,
 * }}
 */
export function createTraceStore(options = {}) {
  if (!isRecord(options)) {
    throw new TraceError('INVALID_OPTIONS', 'createTraceStore options must be an object')
  }
  const clock = options.now ?? Date.now
  if (typeof clock !== 'function') {
    throw new TraceError('INVALID_OPTIONS', 'createTraceStore now must be a function')
  }

  /** @type {Span[]} */
  const spans = []
  /** @type {Map<string, Span>} */
  const byId = new Map()
  /** @type {Map<string, Span[]>} */
  const childrenByParent = new Map()
  /** @type {Map<string, number>} */
  const ingestOrder = new Map()
  const state = { spans, byId, childrenByParent, ingestOrder }

  /**
   * @param {string} id
   * @param {string} parentId
   */
  function assertNoCycle(id, parentId) {
    const seen = new Set()
    let cursor = parentId
    while (cursor !== undefined) {
      if (cursor === id) {
        throw new TraceError('CAUSAL_CYCLE', `ingesting span "${id}" would create a causal cycle`)
      }
      if (seen.has(cursor)) return // an existing cycle is not ours; why() guards reads
      seen.add(cursor)
      const parent = byId.get(cursor)
      if (parent === undefined) return
      cursor = parent.parentId
    }
  }

  /**
   * @param {SpanInput} input
   * @returns {Span}
   */
  function ingest(input) {
    const normalized = normalizeSpan(input)
    if (byId.has(normalized.id)) {
      throw new TraceError('DUPLICATE_SPAN', `span "${normalized.id}" was already ingested`)
    }
    if (normalized.parentId !== undefined) {
      assertNoCycle(normalized.id, normalized.parentId)
    }
    const prevHash = spans.length === 0 ? GENESIS_PREV_HASH : spans[spans.length - 1].hash
    /** @type {Span} */
    const span = { ...normalized, prevHash, hash: '' }
    span.hash = computeSpanHash(span)
    spans.push(span)
    byId.set(span.id, span)
    ingestOrder.set(span.id, spans.length - 1)
    if (span.parentId !== undefined) {
      const siblings = childrenByParent.get(span.parentId) ?? []
      siblings.push(span)
      childrenByParent.set(span.parentId, siblings)
    }
    return cloneJson(span)
  }

  /**
   * @param {TraceFilter} [filter]
   * @returns {Span[]}
   */
  function query(filter = {}) {
    if (!isRecord(filter)) {
      throw new TraceError('INVALID_QUERY', 'query filter must be an object')
    }
    const known = new Set([
      'id',
      'sessionId',
      'parentId',
      'agentPath',
      'kind',
      'status',
      'name',
      'since',
      'until',
      'limit',
      'order',
    ])
    for (const key of Object.keys(filter)) {
      if (!known.has(key)) {
        throw new TraceError('INVALID_QUERY', `query.${key} is not a supported filter`)
      }
    }
    if (filter.id !== undefined && typeof filter.id !== 'string') {
      throw new TraceError('INVALID_QUERY', 'query.id must be a string')
    }
    if (filter.sessionId !== undefined && typeof filter.sessionId !== 'string') {
      throw new TraceError('INVALID_QUERY', 'query.sessionId must be a string')
    }
    if (
      filter.parentId !== undefined &&
      filter.parentId !== null &&
      typeof filter.parentId !== 'string'
    ) {
      throw new TraceError('INVALID_QUERY', 'query.parentId must be a string or null')
    }
    if (filter.agentPath !== undefined && typeof filter.agentPath !== 'string') {
      throw new TraceError('INVALID_QUERY', 'query.agentPath must be a string')
    }
    if (filter.name !== undefined && typeof filter.name !== 'string') {
      throw new TraceError('INVALID_QUERY', 'query.name must be a string')
    }
    /** @type {Set<string>|null} */
    let kinds = null
    if (filter.kind !== undefined) {
      const list = Array.isArray(filter.kind) ? filter.kind : [filter.kind]
      if (list.length === 0) {
        throw new TraceError('INVALID_QUERY', 'query.kind must not be empty')
      }
      for (const kind of list) {
        if (typeof kind !== 'string' || !SPAN_KINDS.includes(kind)) {
          throw new TraceError('INVALID_QUERY', `query.kind contains an unknown kind`)
        }
      }
      kinds = new Set(list)
    }
    /** @type {Set<string>|null} */
    let statuses = null
    if (filter.status !== undefined) {
      const list = Array.isArray(filter.status) ? filter.status : [filter.status]
      if (list.length === 0) {
        throw new TraceError('INVALID_QUERY', 'query.status must not be empty')
      }
      for (const status of list) {
        if (typeof status !== 'string' || !SPAN_STATUSES.includes(status)) {
          throw new TraceError('INVALID_QUERY', 'query.status contains an unknown status')
        }
      }
      statuses = new Set(list)
    }
    for (const key of /** @type {const} */ (['since', 'until'])) {
      const value = filter[key]
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new TraceError('INVALID_QUERY', `query.${key} must be a finite number`)
      }
    }
    if (
      filter.limit !== undefined &&
      (typeof filter.limit !== 'number' || !Number.isInteger(filter.limit) || filter.limit < 0)
    ) {
      throw new TraceError('INVALID_QUERY', 'query.limit must be a non-negative integer')
    }
    if (filter.order !== undefined && filter.order !== 'asc' && filter.order !== 'desc') {
      throw new TraceError('INVALID_QUERY', 'query.order must be "asc" or "desc"')
    }

    const matches = spans.filter((span) => {
      if (filter.id !== undefined && span.id !== filter.id) return false
      if (filter.sessionId !== undefined && span.sessionId !== filter.sessionId) return false
      if (filter.parentId !== undefined) {
        if (filter.parentId === null) {
          if (span.parentId !== undefined) return false
        } else if (span.parentId !== filter.parentId) {
          return false
        }
      }
      if (filter.agentPath !== undefined && span.agentPath !== filter.agentPath) return false
      if (kinds !== null && !kinds.has(span.kind)) return false
      if (statuses !== null && !statuses.has(span.status)) return false
      if (filter.name !== undefined && span.name !== filter.name) return false
      if (filter.since !== undefined && span.startMs < filter.since) return false
      if (filter.until !== undefined && span.startMs > filter.until) return false
      return true
    })

    const ordered = sortChronologically(matches, ingestOrder)
    if (filter.order === 'desc') ordered.reverse()
    const limited = filter.limit === undefined ? ordered : ordered.slice(0, filter.limit)
    return limited.map((span) => cloneJson(span))
  }

  /**
   * @param {string} eventId
   * @param {number} [depth]
   * @returns {WhyResult}
   */
  function why(eventId, depth = DEFAULT_WHY_DEPTH) {
    if (typeof eventId !== 'string' || eventId.length === 0) {
      throw new TraceError('INVALID_QUERY', 'why eventId must be a non-empty string')
    }
    if (
      typeof depth !== 'number' ||
      !Number.isInteger(depth) ||
      depth < 0 ||
      depth > MAX_WHY_DEPTH
    ) {
      throw new TraceError(
        'INVALID_DEPTH',
        `why depth must be an integer between 0 and ${MAX_WHY_DEPTH}`,
      )
    }
    return buildWhy(state, eventId, depth)
  }

  /**
   * @param {{ redact?: string[] }} [exportOptions]
   * @returns {TraceBundle}
   */
  function exportBundle(exportOptions = {}) {
    if (!isRecord(exportOptions)) {
      throw new TraceError('INVALID_REDACTION', 'exportBundle options must be an object')
    }
    const fields = normalizeRedactFields(exportOptions.redact)
    const exportedAt = clock()
    if (typeof exportedAt !== 'number' || !Number.isFinite(exportedAt)) {
      throw new TraceError('INVALID_CLOCK', 'now() must return a finite epoch-millisecond number')
    }
    const bundle = buildBundle(state, fields)
    bundle.exportedAt = exportedAt
    return bundle
  }

  return {
    ingest,
    query,
    why,
    exportBundle,
    verifyBundle,
  }
}

/**
 * Verify a bundle's hash chain without trusting its label.
 *
 * The chain is always anchored at `GENESIS_PREV_HASH`. A verification failure
 * is returned, not thrown, so tool callers always get `firstBad`.
 *
 * @param {unknown} bundle
 * @returns {VerifyResult}
 */
export function verifyBundle(bundle) {
  if (!isRecord(bundle)) {
    return {
      ok: false,
      count: 0,
      checked: 0,
      rootHash: null,
      firstBad: { index: -1, id: null, reason: 'bundle must be an object' },
    }
  }
  if (bundle.format !== undefined && bundle.format !== TRACE_FORMAT) {
    return {
      ok: false,
      count: 0,
      checked: 0,
      rootHash: null,
      firstBad: {
        index: -1,
        id: null,
        reason: 'unsupported bundle format',
        expected: TRACE_FORMAT,
        actual: bundle.format,
      },
    }
  }
  if (bundle.version !== undefined && bundle.version !== TRACE_VERSION) {
    return {
      ok: false,
      count: 0,
      checked: 0,
      rootHash: null,
      firstBad: {
        index: -1,
        id: null,
        reason: 'unsupported bundle version',
        expected: TRACE_VERSION,
        actual: bundle.version,
      },
    }
  }
  if (!Array.isArray(bundle.spans)) {
    return {
      ok: false,
      count: 0,
      checked: 0,
      rootHash: null,
      firstBad: { index: -1, id: null, reason: 'bundle.spans must be an array' },
    }
  }
  if (
    bundle.genesisPrevHash !== undefined &&
    bundle.genesisPrevHash !== GENESIS_PREV_HASH
  ) {
    return {
      ok: false,
      count: bundle.spans.length,
      checked: 0,
      rootHash: null,
      firstBad: {
        index: -1,
        id: null,
        reason: 'genesisPrevHash does not match this verifier',
        expected: GENESIS_PREV_HASH,
        actual: bundle.genesisPrevHash,
      },
    }
  }

  const spans = bundle.spans
  const count = spans.length
  let checked = 0
  let rootHash = null

  /**
   * @param {string} reason
   * @param {number} index
   * @param {string|null} id
   * @param {{ expected?: unknown, actual?: unknown }} [extra]
   * @returns {VerifyResult}
   */
  function fail(reason, index, id, extra = {}) {
    return {
      ok: false,
      count,
      checked,
      rootHash,
      firstBad: { index, id, reason, ...extra },
    }
  }

  if (bundle.spanCount !== undefined && bundle.spanCount !== count) {
    return fail('spanCount does not match bundle.spans.length', -1, null, {
      expected: count,
      actual: bundle.spanCount,
    })
  }

  let expectedPrev = GENESIS_PREV_HASH
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]
    if (!isRecord(span)) {
      return fail('span must be an object', index, null)
    }
    const id = typeof span.id === 'string' && span.id.length > 0 ? span.id : null
    if (id === null) {
      return fail('span.id must be a non-empty string', index, null)
    }
    if (span.prevHash !== expectedPrev) {
      return fail('prevHash does not match the previous span hash', index, id, {
        expected: expectedPrev,
        actual: span.prevHash ?? null,
      })
    }
    let expectedHash
    try {
      expectedHash = computeSpanHash(/** @type {Span} */ (span))
    } catch (error) {
      return fail(
        `span is not hashable: ${error instanceof Error ? error.message : String(error)}`,
        index,
        id,
      )
    }
    if (span.hash !== expectedHash) {
      return fail('hash mismatch', index, id, {
        expected: expectedHash,
        actual: span.hash ?? null,
      })
    }
    expectedPrev = expectedHash
    checked = index + 1
  }

  if (bundle.rootHash !== undefined) {
    if (typeof bundle.rootHash !== 'string') {
      return fail('rootHash must be a string', count - 1, null)
    }
    if (bundle.rootHash !== expectedPrev) {
      const lastId = count === 0 ? null : /** @type {string|null} */ (spans[count - 1].id ?? null)
      return fail('rootHash does not match the final span hash', count - 1, lastId, {
        expected: expectedPrev,
        actual: bundle.rootHash,
      })
    }
  }

  rootHash = expectedPrev
  return { ok: true, count, checked, rootHash, firstBad: null }
}
