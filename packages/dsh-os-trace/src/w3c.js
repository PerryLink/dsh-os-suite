/**
 * W3C Trace Context `traceparent` string helpers.
 *
 * Only the header value layout is implemented:
 *
 *   version "-" trace-id "-" parent-id "-" trace-flags
 *   "00-<32 hex>-<16 hex>-<2 hex>"
 *
 * This module does not propagate trace context: there is no `tracestate`,
 * no instrumented HTTP injection/extraction and no sampling decision. It is a
 * small, dependency-free codec that lets callers carry W3C trace/span ids as
 * plain strings next to DSH spans.
 *
 * Rules enforced for version `00` (the only version this module writes):
 * - exactly four `-` separated fields, 55 characters total;
 * - version, trace-id, parent-id/span-id and trace-flags are lower-case hex;
 * - version `ff` is invalid;
 * - trace-id and span-id must not be all zeroes.
 *
 * Future versions (`01`..`fe`) are accepted when they have the four mandatory
 * fields; extra dash-separated lower-case hex fields are ignored. `flags` is
 * the numeric byte (0-255), `traceFlags` is an alias for OTel terminology.
 */

import { TraceError } from './core.js'

/** Header version written by {@link formatTraceparent}. */
export const TRACEPARENT_VERSION = '00'
/** Trace-flags value used when the caller does not pass `flags` (sampled). */
export const TRACEPARENT_DEFAULT_FLAGS = 1

const VERSION_RE = /^[0-9a-f]{2}$/
const TRACE_ID_RE = /^[0-9a-f]{32}$/
const SPAN_ID_RE = /^[0-9a-f]{16}$/
const FLAGS_RE = /^[0-9a-f]{2}$/
const EXTRA_FIELD_RE = /^[0-9a-f]+$/
const ALL_ZERO_RE = /^0+$/

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {unknown} value
 * @returns {number|undefined}
 */
function optionalFlags(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
    ? value
    : undefined
}

/**
 * Format a W3C `traceparent` header value.
 *
 * Ids must be lower-case hex and non-zero; `flags` is a byte (0-255) and
 * defaults to 1 (sampled). Throws `TraceError` with code
 * `INVALID_TRACEPARENT` instead of emitting a malformed header.
 *
 * @param {{ traceId: string, spanId: string, flags?: number }} input
 * @returns {string}
 */
export function formatTraceparent(input) {
  if (!isRecord(input)) {
    throw new TraceError('INVALID_TRACEPARENT', 'formatTraceparent input must be an object')
  }
  const { traceId, spanId } = input
  const flags = input.flags === undefined ? TRACEPARENT_DEFAULT_FLAGS : input.flags
  if (typeof traceId !== 'string' || !TRACE_ID_RE.test(traceId) || ALL_ZERO_RE.test(traceId)) {
    throw new TraceError(
      'INVALID_TRACEPARENT',
      'traceId must be 32 lower-case hex characters and not all zeroes',
    )
  }
  if (typeof spanId !== 'string' || !SPAN_ID_RE.test(spanId) || ALL_ZERO_RE.test(spanId)) {
    throw new TraceError(
      'INVALID_TRACEPARENT',
      'spanId must be 16 lower-case hex characters and not all zeroes',
    )
  }
  if (optionalFlags(flags) === undefined) {
    throw new TraceError('INVALID_TRACEPARENT', 'flags must be an integer between 0 and 255')
  }
  return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${flags.toString(16).padStart(2, '0')}`
}

/**
 * Parse and validate a W3C `traceparent` header value.
 *
 * Surrounding whitespace is trimmed (HTTP frameworks commonly strip optional
 * whitespace) but the value itself must be lower-case hex. Returns `null` for
 * anything invalid instead of throwing, so callers can treat an attribute as
 * opaque data.
 *
 * @param {unknown} header
 * @returns {{
 *   traceId: string,
 *   spanId: string,
 *   flags: number,
 *   traceFlags: number,
 * } | null}
 */
export function parseTraceparent(header) {
  if (typeof header !== 'string') return null
  const value = header.trim()
  if (value.length === 0) return null

  const parts = value.split('-')
  if (parts.length < 4) return null
  const version = parts[0]
  const traceId = parts[1]
  const spanId = parts[2]
  const flagsText = parts[3]
  const extra = parts.slice(4)

  if (!VERSION_RE.test(version) || version === 'ff') return null
  if (version === TRACEPARENT_VERSION) {
    // Version 00 is fixed length: extra fields would change the semantics.
    if (extra.length > 0) return null
  } else if (extra.length > 0 && !extra.every((field) => EXTRA_FIELD_RE.test(field))) {
    // Future versions may append fields; accept only well-formed hex fields.
    return null
  }
  if (!TRACE_ID_RE.test(traceId) || ALL_ZERO_RE.test(traceId)) return null
  if (!SPAN_ID_RE.test(spanId) || ALL_ZERO_RE.test(spanId)) return null
  if (!FLAGS_RE.test(flagsText)) return null

  const flags = Number.parseInt(flagsText, 16)
  return { traceId, spanId, flags, traceFlags: flags }
}

/**
 * Best-effort `traceparent` for a span-like object.
 *
 * Accepted shapes, in order:
 * 1. a W3C/OTLP span with `traceId` and `spanId` (and optionally `flags`);
 * 2. a recorded `traceparent` field or `attrs.traceparent` string.
 *
 * Returns the canonical header, or `null` when the object carries no usable
 * W3C context. Invalid ids never throw here; they yield `null`.
 *
 * @param {unknown} span
 * @returns {string|null}
 */
export function toTraceparent(span) {
  if (!isRecord(span)) return null
  const attrs = isRecord(span.attrs) ? span.attrs : undefined
  /** @type {ReturnType<typeof parseTraceparent>} */
  let parsed = null
  for (const candidate of [span.traceparent, attrs?.traceparent]) {
    const text = optionalString(candidate)
    if (text === undefined) continue
    parsed = parseTraceparent(text)
    if (parsed !== null) break
  }

  const flags = optionalFlags(span.flags) ?? optionalFlags(span.traceFlags) ?? parsed?.flags ?? 1
  const traceId = optionalString(span.traceId)
  const spanId = optionalString(span.spanId)
  if (traceId !== undefined && spanId !== undefined) {
    try {
      return formatTraceparent({ traceId, spanId, flags })
    } catch {
      // Fall through to a recorded header, which may still be usable.
    }
  }
  if (parsed !== null) {
    return formatTraceparent({ traceId: parsed.traceId, spanId: parsed.spanId, flags })
  }
  return null
}

/**
 * Build a span-like record from a `traceparent` header.
 *
 * The returned object has exactly the W3C fields plus the caller-supplied
 * `name`, which makes `toTraceparent(fromTraceparent(header, { name }))`
 * round-trip. It does not contain a parent id: `traceparent` identifies the
 * current span only. Returns `null` for an invalid header.
 *
 * @param {unknown} header
 * @param {{ name?: string }} [options]
 * @returns {{
 *   name: string,
 *   traceId: string,
 *   spanId: string,
 *   flags: number,
 *   traceFlags: number,
 * } | null}
 */
export function fromTraceparent(header, options = {}) {
  if (options === undefined) options = {}
  if (!isRecord(options)) {
    throw new TraceError('INVALID_TRACEPARENT', 'fromTraceparent options must be an object')
  }
  const name = options.name === undefined ? 'w3c-span' : options.name
  if (typeof name !== 'string' || name.length === 0) {
    throw new TraceError('INVALID_TRACEPARENT', 'fromTraceparent name must be a non-empty string')
  }
  const parsed = parseTraceparent(header)
  if (parsed === null) return null
  return {
    name,
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    flags: parsed.flags,
    traceFlags: parsed.traceFlags,
  }
}
