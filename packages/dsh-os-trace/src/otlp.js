/**
 * OTLP/JSON interoperability for dsh-os-trace.
 *
 * This is deliberately a small, dependency-free mapping between the stored
 * trace shape and the JSON encoding of OTLP trace data. It is not an OTLP
 * SDK, collector or gRPC/protobuf implementation: the importer accepts one
 * OTLP/JSON document and the exporter returns one OTLP/JSON document.
 *
 * Lossless round-trips of this package's own spans use a reserved
 * `dsh.span.*` attribute namespace for the fields OTLP has no equivalent for
 * (the original id, DSH kind/status and agent path). Foreign OTLP spans are
 * mapped with conservative defaults; see README.md for the field-loss list.
 */

import { createHash } from 'node:crypto'
import {
  SPAN_KINDS,
  SPAN_STATUSES,
  TraceError,
  normalizeSpan,
} from './core.js'

/** Scope name emitted in every exported OTLP document. */
export const OTLP_SCOPE_NAME = 'dsh-os-trace'
/** Default `service.name` resource attribute. */
export const OTLP_DEFAULT_SERVICE_NAME = 'dsh'
/** OTLP span kind emitted for every span. */
export const OTLP_SPAN_KIND = 'SPAN_KIND_INTERNAL'

/**
 * Reserved span attributes that preserve DSH-only fields across a round-trip.
 * They are stripped from `attrs` when importing so user attributes stay clean.
 */
export const OTLP_ATTR = Object.freeze({
  id: 'dsh.span.id',
  parentId: 'dsh.span.parent_id',
  sessionId: 'dsh.span.session_id',
  kind: 'dsh.span.kind',
  status: 'dsh.span.status',
  agentPath: 'dsh.span.agent_path',
})

const RESERVED_ATTR_KEYS = new Set(Object.values(OTLP_ATTR))

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {string} value
 * @returns {string}
 */
function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Derive a non-zero OTLP id from a stable seed.
 *
 * @param {string} seed
 * @param {number} bytes 8 for span ids, 16 for trace ids.
 * @returns {string}
 */
function deriveId(seed, bytes) {
  const width = bytes * 2
  const first = sha256Hex(seed).slice(0, width)
  if (!/^0+$/.test(first)) return first
  // OTLP requires non-zero trace/span ids. SHA-256 output can be all zeroes in
  // theory; re-hash with a domain prefix rather than emit an invalid id.
  return sha256Hex(`dsh-os-trace:${seed}`).slice(0, width)
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Normalize an id read from OTLP JSON. OTLP ids are lower-case hex strings;
 * all-zero ids are invalid. Non-hex values are tolerated because foreign
 * producers are inconsistent, but they are trimmed.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function otlpId(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0 || /^0+$/.test(text)) return undefined
  return text
}

/**
 * @param {number} ms Epoch milliseconds.
 * @returns {string} Nanoseconds since the Unix epoch, as a decimal string.
 */
function msToNanos(ms) {
  if (!Number.isFinite(ms)) {
    throw new TraceError('INVALID_OTLP_SPAN', 'span timestamps must be finite epoch milliseconds')
  }
  if (Number.isSafeInteger(ms)) return (BigInt(ms) * 1_000_000n).toString()
  const rounded = Math.round(ms * 1_000_000)
  if (!Number.isFinite(rounded)) {
    throw new TraceError('INVALID_OTLP_SPAN', 'span timestamp is outside the OTLP range')
  }
  return BigInt(rounded).toString()
}

/**
 * @param {unknown} value
 * @returns {number|undefined} Epoch milliseconds.
 */
function nanosToMs(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value / 1_000_000 : undefined
  }
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const text = value.trim()
  if (!/^[+-]?\d+$/.test(text)) {
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed / 1_000_000 : undefined
  }
  try {
    const nanos = BigInt(text)
    const millis = nanos / 1_000_000n
    const remainder = nanos % 1_000_000n
    return Number(millis) + Number(remainder) / 1_000_000
  } catch {
    return undefined
  }
}

/**
 * Encode one JSON value as an OTLP AnyValue.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>|undefined}
 */
function anyValue(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { stringValue: String(value) }
    if (Number.isSafeInteger(value)) return { intValue: String(value) }
    return { doubleValue: value }
  }
  if (Array.isArray(value)) {
    /** @type {Record<string, unknown>[]} */
    const values = []
    for (const entry of value) {
      const encoded = anyValue(entry)
      if (encoded !== undefined) values.push(encoded)
    }
    return { arrayValue: { values } }
  }
  if (isRecord(value)) {
    /** @type {{ key: string, value: Record<string, unknown> }[]} */
    const values = []
    for (const [key, entry] of Object.entries(value)) {
      if (key.length === 0) continue
      const encoded = anyValue(entry)
      if (encoded !== undefined) values.push({ key, value: encoded })
    }
    return { kvlistValue: { values } }
  }
  return { stringValue: String(value) }
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function decodeAnyValue(value) {
  if (!isRecord(value)) return value
  if ('stringValue' in value) {
    return typeof value.stringValue === 'string' ? value.stringValue : String(value.stringValue)
  }
  if ('boolValue' in value) {
    if (typeof value.boolValue === 'boolean') return value.boolValue
    if (value.boolValue === 'true') return true
    if (value.boolValue === 'false') return false
    return value.boolValue
  }
  if ('intValue' in value) {
    const raw = value.intValue
    if (typeof raw === 'number') return raw
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) return parsed
    }
    return raw
  }
  if ('doubleValue' in value) {
    const raw = value.doubleValue
    if (typeof raw === 'number') return raw
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) return parsed
    }
    return raw
  }
  if ('arrayValue' in value) {
    const arrayValue = value.arrayValue
    if (!isRecord(arrayValue) || !Array.isArray(arrayValue.values)) return []
    /** @type {unknown[]} */
    const decoded = []
    for (const entry of arrayValue.values) {
      const item = decodeAnyValue(entry)
      if (item !== undefined) decoded.push(item)
    }
    return decoded
  }
  if ('kvlistValue' in value) {
    const kvlistValue = value.kvlistValue
    if (!isRecord(kvlistValue) || !Array.isArray(kvlistValue.values)) return {}
    /** @type {Record<string, unknown>} */
    const decoded = Object.create(null)
    for (const item of kvlistValue.values) {
      if (!isRecord(item) || typeof item.key !== 'string' || item.key.length === 0) continue
      const entry = decodeAnyValue(item.value)
      if (entry !== undefined) decoded[item.key] = entry
    }
    return decoded
  }
  if ('bytesValue' in value) {
    // Keep the base64 text: decoding to a Buffer would not be JSON-serializable
    // in the existing span shape.
    return value.bytesValue
  }
  // Unknown AnyValue oneof: preserve the raw JSON rather than silently dropping
  // a foreign attribute.
  return value
}

/**
 * @param {unknown} attributes OTLP KeyValue[] (or a plain key/value object).
 * @returns {Record<string, unknown>}
 */
function attributesToObject(attributes) {
  // Null-prototype map so a hostile attribute key such as "__proto__" is a
  // normal own property and cannot mutate the prototype chain.
  /** @type {Record<string, unknown>} */
  const attrs = Object.create(null)
  if (Array.isArray(attributes)) {
    for (const item of attributes) {
      if (!isRecord(item)) continue
      if (typeof item.key !== 'string' || item.key.length === 0) continue
      const decoded = decodeAnyValue(item.value)
      if (decoded !== undefined) attrs[item.key] = decoded
    }
    return attrs
  }
  if (isRecord(attributes)) {
    for (const [key, value] of Object.entries(attributes)) {
      if (key.length === 0) continue
      const decoded = decodeAnyValue(value)
      if (decoded !== undefined) attrs[key] = decoded
    }
  }
  return attrs
}

/**
 * @param {Record<string, unknown>} attrs
 * @param {string} key
 * @returns {string|undefined}
 */
function stringAttr(attrs, key) {
  return optionalString(attrs[key])
}

/**
 * @param {Record<string, unknown>} status
 * @returns {number}
 */
function statusCodeOf(status) {
  if (typeof status === 'number' && Number.isFinite(status)) return status
  if (!isRecord(status)) return 0
  const code = status.code
  if (typeof code === 'number' && Number.isFinite(code)) return code
  if (typeof code === 'string') {
    if (code === 'STATUS_CODE_OK') return 1
    if (code === 'STATUS_CODE_ERROR') return 2
    if (code === 'STATUS_CODE_UNSET') return 0
    const parsed = Number(code)
    if (Number.isInteger(parsed)) return parsed
  }
  return 0
}

/**
 * Find the top-most ancestor of a span inside one export batch. Unknown
 * parents are returned as the anchor so orphaned children remain grouped with
 * the id they point at rather than silently becoming their own root.
 *
 * @param {Record<string, unknown>} span
 * @param {Map<string, Record<string, unknown>>} byId
 * @returns {string}
 */
function rootAnchor(span, byId) {
  let current = span
  /** @type {Set<string>} */
  const seen = new Set()
  while (typeof current.parentId === 'string' && current.parentId.length > 0) {
    const currentId = optionalString(current.id)
    if (currentId === undefined) return current.parentId
    if (seen.has(currentId)) return currentId
    seen.add(currentId)
    const parent = byId.get(current.parentId)
    if (parent === undefined) return current.parentId
    current = parent
  }
  return optionalString(current.id) ?? 'unknown-root'
}

/**
 * @param {Record<string, unknown>} span
 * @param {Map<string, Record<string, unknown>>} byId
 * @returns {string}
 */
function traceIdOf(span, byId) {
  const sessionId = optionalString(span.sessionId)
  if (sessionId !== undefined) return deriveId(sessionId, 16)
  return deriveId(rootAnchor(span, byId), 16)
}

/**
 * @param {Record<string, unknown>} span
 * @param {string} id
 * @returns {{ key: string, value: { stringValue: string } }[]}
 */
function metadataAttributes(span, id) {
  /** @type {{ key: string, value: { stringValue: string } }[]} */
  const attributes = [{ key: OTLP_ATTR.id, value: { stringValue: id } }]
  const parentId = optionalString(span.parentId)
  if (parentId !== undefined) {
    attributes.push({ key: OTLP_ATTR.parentId, value: { stringValue: parentId } })
  }
  const sessionId = optionalString(span.sessionId)
  if (sessionId !== undefined) {
    attributes.push({ key: OTLP_ATTR.sessionId, value: { stringValue: sessionId } })
  }
  const kind = optionalString(span.kind)
  if (kind !== undefined) {
    attributes.push({ key: OTLP_ATTR.kind, value: { stringValue: kind } })
  }
  const status = optionalString(span.status)
  if (status !== undefined) {
    attributes.push({ key: OTLP_ATTR.status, value: { stringValue: status } })
  }
  if (typeof span.agentPath === 'string') {
    attributes.push({ key: OTLP_ATTR.agentPath, value: { stringValue: span.agentPath } })
  }
  return attributes
}

/**
 * @param {Record<string, unknown>} span
 * @param {string} id
 * @returns {{ key: string, value: Record<string, unknown> }[]}
 */
function spanAttributes(span, id) {
  /** @type {{ key: string, value: Record<string, unknown> }[]} */
  const attributes = []
  if (isRecord(span.attrs)) {
    for (const [key, value] of Object.entries(span.attrs)) {
      if (key.length === 0) continue
      const encoded = anyValue(value)
      if (encoded !== undefined) attributes.push({ key, value: encoded })
    }
  }
  attributes.push(...metadataAttributes(span, id))
  return attributes
}

/**
 * @param {Record<string, unknown>} span
 * @param {string} id
 * @param {Map<string, Record<string, unknown>>} byId
 * @returns {Record<string, unknown>}
 */
function toOtlpSpan(span, id, byId) {
  const startMs = typeof span.startMs === 'number' && Number.isFinite(span.startMs) ? span.startMs : 0
  const parentId = optionalString(span.parentId)
  const status = span.status === 'error' ? 2 : 1
  const otlpSpan = {
    traceId: traceIdOf(span, byId),
    spanId: deriveId(id, 8),
    name: optionalString(span.name) ?? id,
    kind: OTLP_SPAN_KIND,
    startTimeUnixNano: msToNanos(startMs),
    status: { code: status },
    attributes: spanAttributes(span, id),
  }
  if (parentId !== undefined) otlpSpan.parentSpanId = deriveId(parentId, 8)
  const endMs = typeof span.endMs === 'number' && Number.isFinite(span.endMs) ? span.endMs : undefined
  if (endMs !== undefined && endMs >= startMs) {
    otlpSpan.endTimeUnixNano = msToNanos(endMs)
  }
  return otlpSpan
}

/**
 * Export DSH spans as an OTLP/JSON trace document.
 *
 * @param {unknown[]} spans Span inputs or stored spans. `hash`/`prevHash` are ignored.
 * @param {{ serviceName?: string }} [options]
 * @returns {{
 *   resourceSpans: [{
 *     resource: { attributes: [{ key: 'service.name', value: { stringValue: string } }] },
 *     scopeSpans: [{
 *       scope: { name: string },
 *       spans: Record<string, unknown>[],
 *     }],
 *   }],
 * }}
 */
export function toOtlp(spans, options = {}) {
  if (!Array.isArray(spans)) {
    throw new TraceError('INVALID_OTLP', 'toOtlp spans must be an array')
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TraceError('INVALID_OTLP', 'toOtlp options must be an object')
  }
  const serviceName =
    options.serviceName === undefined ? OTLP_DEFAULT_SERVICE_NAME : options.serviceName
  if (typeof serviceName !== 'string' || serviceName.trim().length === 0) {
    throw new TraceError('INVALID_OTLP', 'toOtlp serviceName must be a non-empty string')
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const byId = new Map()
  /** @type {{ span: Record<string, unknown>, id: string }[]} */
  const entries = []
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]
    if (!isRecord(span)) {
      throw new TraceError('INVALID_OTLP_SPAN', `spans[${index}] must be an object`)
    }
    const id = optionalString(span.id)
    if (id === undefined) {
      throw new TraceError('INVALID_OTLP_SPAN', `spans[${index}].id must be a non-empty string`)
    }
    if (typeof span.startMs !== 'number' || !Number.isFinite(span.startMs)) {
      throw new TraceError(
        'INVALID_OTLP_SPAN',
        `spans[${index}].startMs must be a finite epoch-millisecond number`,
      )
    }
    entries.push({ span, id })
    byId.set(id, span)
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: serviceName } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: OTLP_SCOPE_NAME },
            spans: entries.map((entry) => toOtlpSpan(entry.span, entry.id, byId)),
          },
        ],
      },
    ],
  }
}

/**
 * Decode one OTLP span into an intermediate record.
 *
 * @param {Record<string, unknown>} span
 * @param {number} index
 * @returns {{
 *   id: string,
 *   otlpSpanId?: string,
 *   parentId?: string,
 *   parentSpanId?: string,
 *   sessionId: string,
 *   kind: string,
 *   name: string,
 *   startMs: number,
 *   endMs?: number,
 *   status: string,
 *   agentPath?: string,
 *   attrs: Record<string, unknown>,
 * }}
 */
function decodeOtlpSpan(span, index) {
  const attrs = attributesToObject(span.attributes)
  const metaId = stringAttr(attrs, OTLP_ATTR.id)
  const metaParentId = stringAttr(attrs, OTLP_ATTR.parentId)
  const metaSessionId = stringAttr(attrs, OTLP_ATTR.sessionId)
  const metaKind = stringAttr(attrs, OTLP_ATTR.kind)
  const metaStatus = stringAttr(attrs, OTLP_ATTR.status)
  const metaAgentPath = attrs[OTLP_ATTR.agentPath]

  for (const key of RESERVED_ATTR_KEYS) delete attrs[key]

  const otlpSpanId = otlpId(span.spanId)
  const traceId = otlpId(span.traceId)
  const parentSpanId = otlpId(span.parentSpanId)
  const id = metaId ?? otlpSpanId ?? `otlp-${index + 1}`
  const sessionId = metaSessionId ?? traceId ?? 'otlp'
  const startMs = nanosToMs(span.startTimeUnixNano) ?? 0
  const rawEndMs = nanosToMs(span.endTimeUnixNano)
  const endMs = rawEndMs !== undefined && rawEndMs >= startMs ? rawEndMs : undefined
  const code = statusCodeOf(span.status)

  let status
  if (metaStatus !== undefined && SPAN_STATUSES.includes(metaStatus)) {
    status = metaStatus
  } else if (code === 2) {
    status = 'error'
  } else if (code === 0 && endMs === undefined) {
    // OTLP has no explicit "running" state. A span without an end time and
    // without an OK/ERROR status is the closest thing to an in-flight span.
    status = 'running'
  } else {
    status = 'ok'
  }

  const kind =
    metaKind !== undefined && SPAN_KINDS.includes(metaKind) ? metaKind : 'workflow'
  const name = typeof span.name === 'string' && span.name.length > 0 ? span.name : 'unnamed'
  const agentPath = typeof metaAgentPath === 'string' ? metaAgentPath : undefined

  return {
    id,
    ...(otlpSpanId !== undefined ? { otlpSpanId } : {}),
    ...(metaParentId !== undefined ? { parentId: metaParentId } : {}),
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    sessionId,
    kind,
    name,
    startMs,
    ...(endMs !== undefined ? { endMs } : {}),
    status,
    ...(agentPath !== undefined ? { agentPath } : {}),
    attrs,
  }
}

/**
 * Import an OTLP/JSON trace document into DSH span inputs.
 *
 * Accepts the full `{ resourceSpans: [...] }` document or a raw OTLP span
 * array. Missing fields are defaulted rather than rejected, and unknown span
 * attributes are kept in `attrs`. The returned spans have no `hash`/`prevHash`;
 * `createTraceStore().ingest()` seals them into this package's chain.
 *
 * @param {unknown} json OTLP object or JSON text.
 * @returns {import('./core.js').SpanInput[]}
 */
export function fromOtlp(json) {
  let input = json
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input.replace(/^\uFEFF/, ''))
    } catch (error) {
      throw new TraceError('INVALID_OTLP', `OTLP JSON is not valid JSON: ${messageOf(error)}`)
    }
  }
  if (!isRecord(input) && !Array.isArray(input)) {
    throw new TraceError('INVALID_OTLP', 'OTLP JSON must be an object or an array of spans')
  }

  /** @type {unknown[]} */
  const rawSpans = []
  if (Array.isArray(input)) {
    rawSpans.push(...input)
  } else if (Array.isArray(input.resourceSpans)) {
    for (const resourceSpan of input.resourceSpans) {
      if (!isRecord(resourceSpan) || !Array.isArray(resourceSpan.scopeSpans)) continue
      for (const scopeSpan of resourceSpan.scopeSpans) {
        if (!isRecord(scopeSpan) || !Array.isArray(scopeSpan.spans)) continue
        rawSpans.push(...scopeSpan.spans)
      }
    }
  } else if (Array.isArray(input.scopeSpans)) {
    for (const scopeSpan of input.scopeSpans) {
      if (!isRecord(scopeSpan) || !Array.isArray(scopeSpan.spans)) continue
      rawSpans.push(...scopeSpan.spans)
    }
  } else {
    throw new TraceError('INVALID_OTLP', 'OTLP JSON must contain a resourceSpans array')
  }

  /** @type {ReturnType<typeof decodeOtlpSpan>[]} */
  const decoded = []
  for (let index = 0; index < rawSpans.length; index += 1) {
    const span = rawSpans[index]
    if (!isRecord(span)) continue
    decoded.push(decodeOtlpSpan(span, index))
  }

  /** @type {Map<string, string>} */
  const byOtlpSpanId = new Map()
  for (const entry of decoded) {
    if (entry.otlpSpanId !== undefined && !byOtlpSpanId.has(entry.otlpSpanId)) {
      byOtlpSpanId.set(entry.otlpSpanId, entry.id)
    }
  }

  /** @type {import('./core.js').SpanInput[]} */
  const spans = []
  for (const entry of decoded) {
    let parentId = entry.parentId
    if (parentId === undefined && entry.parentSpanId !== undefined) {
      parentId = byOtlpSpanId.get(entry.parentSpanId) ?? entry.parentSpanId
    }
    if (parentId === entry.id) parentId = undefined

    /** @type {Record<string, unknown>} */
    const candidate = {
      id: entry.id,
      sessionId: entry.sessionId,
      kind: entry.kind,
      name: entry.name,
      startMs: entry.startMs,
      status: entry.status,
    }
    if (parentId !== undefined) candidate.parentId = parentId
    if (entry.agentPath !== undefined) candidate.agentPath = entry.agentPath
    if (entry.endMs !== undefined) candidate.endMs = entry.endMs
    if (Object.keys(entry.attrs).length > 0) candidate.attrs = entry.attrs

    try {
      spans.push(normalizeSpan(candidate))
    } catch (error) {
      throw new TraceError(
        'INVALID_OTLP',
        `OTLP span ${entry.id} cannot be mapped: ${messageOf(error)}`,
      )
    }
  }
  return spans
}
