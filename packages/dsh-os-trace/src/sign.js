/**
 * HMAC-SHA256 signing for dsh-os-trace evidence bundles.
 *
 * The signed envelope is a normal trace bundle plus a top-level `signature`
 * object:
 *
 *   { ...bundle, signature: { alg: 'hmac-sha256', sig: '<64 hex chars>' } }
 *
 * The HMAC covers `canonicalJson(bundle without signature)` — the same
 * signature payload convention as `testatum-attest` v1 (`signaturePayload()`),
 * so a trace bundle can be signed/verified with the same primitive and a
 * `schema: "testatum/v1"` marker is accepted as an ordinary signed object.
 * This is a shared-secret MAC, not a public-key signature and not a
 * transparency log: anyone holding the secret can produce a valid envelope.
 *
 * The secret is supplied by the caller. `verifySignedBundle` may fall back to
 * `TESTATUM_KEY` when no explicit secret is given; `signBundle` never reads
 * the environment and never writes the secret into its return value.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { TraceError, canonicalJson } from './core.js'

/** The only signature algorithm implemented by this package. */
export const SIGN_ALG = 'hmac-sha256'
/** Top-level field carrying the signature on a signed bundle. */
export const SIGNATURE_FIELD = 'signature'
/** Environment variable used as the default verification secret. */
export const SECRET_ENV = 'TESTATUM_KEY'

const SHA256_HEX = /^[0-9a-f]{64}$/

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {string|Uint8Array}
 */
function requireSecret(value) {
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      throw new TraceError('INVALID_SECRET', 'secret must not be empty')
    }
    return value
  }
  if (value instanceof Uint8Array) {
    if (value.length === 0) {
      throw new TraceError('INVALID_SECRET', 'secret must not be empty')
    }
    return value
  }
  throw new TraceError(
    'INVALID_SECRET',
    'secret must be a non-empty string or Uint8Array',
  )
}

/**
 * Normalize the convenience forms `secret` and `{ secret, keyId }`.
 *
 * @param {unknown} input
 * @returns {{ secret: string|Uint8Array, keyId?: string }}
 */
function normalizeSecretOptions(input) {
  if (typeof input === 'string' || input instanceof Uint8Array) {
    return { secret: requireSecret(input) }
  }
  if (isRecord(input)) {
    if (input.secret === undefined) {
      throw new TraceError('INVALID_SECRET', 'secret option is required')
    }
    /** @type {{ secret: string|Uint8Array, keyId?: string }} */
    const out = { secret: requireSecret(input.secret) }
    if (input.keyId !== undefined) {
      if (typeof input.keyId !== 'string' || input.keyId.trim().length === 0) {
        throw new TraceError('INVALID_SECRET', 'keyId must be a non-empty string')
      }
      out.keyId = input.keyId
    }
    return out
  }
  throw new TraceError(
    'INVALID_SECRET',
    'secret must be a non-empty string, Uint8Array, or { secret, keyId }',
  )
}

/**
 * Resolve an explicit secret, else the TESTATUM_KEY environment variable.
 * Missing secrets are reported, never guessed.
 *
 * @param {unknown} [input]
 * @returns {string|Uint8Array|undefined}
 */
export function resolveSigningSecret(input) {
  if (input !== undefined && input !== null) {
    return normalizeSecretOptions(input).secret
  }
  const fromEnv =
    typeof process !== 'undefined' ? process.env?.[SECRET_ENV] : undefined
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv
  return undefined
}

/**
 * Canonical JSON bytes covered by the HMAC: the object without its top-level
 * `signature` field. Equivalent to testatum-attest v1 `signaturePayload()`.
 *
 * @param {Record<string, unknown>} signed
 * @returns {string}
 */
export function signaturePayload(signed) {
  if (!isRecord(signed)) {
    throw new TraceError('INVALID_BUNDLE', 'signed bundle must be an object')
  }
  /** @type {Record<string, unknown>} */
  const unsigned = {}
  for (const key of Object.keys(signed)) {
    if (key === SIGNATURE_FIELD) continue
    unsigned[key] = signed[key]
  }
  return canonicalJson(unsigned)
}

/**
 * Sign a bundle. The bundle itself is not mutated; only the signature object
 * is returned, so callers decide how to attach it.
 *
 * @param {Record<string, unknown>} bundle
 * @param {string|Uint8Array|{ secret: string|Uint8Array, keyId?: string }} secret
 * @returns {{ alg: 'hmac-sha256', sig: string, keyId?: string }}
 */
export function signBundle(bundle, secret) {
  if (!isRecord(bundle)) {
    throw new TraceError('INVALID_BUNDLE', 'bundle must be an object')
  }
  const options = normalizeSecretOptions(secret)
  const sig = createHmac('sha256', options.secret)
    .update(signaturePayload(bundle), 'utf8')
    .digest('hex')
  /** @type {{ alg: 'hmac-sha256', sig: string, keyId?: string }} */
  const signature = { alg: SIGN_ALG, sig }
  if (options.keyId !== undefined) signature.keyId = options.keyId
  return signature
}

/**
 * Verify a signed bundle by recomputing the HMAC over its canonical unsigned
 * payload. Returns a result rather than throwing for malformed input.
 *
 * `signed` may be the object or its JSON text. `secret` may be a string,
 * Uint8Array, `{ secret }`, or omitted to use `TESTATUM_KEY`.
 *
 * @param {unknown} signed
 * @param {string|Uint8Array|{ secret: string|Uint8Array }|undefined} [secret]
 * @returns {{
 *   ok: boolean,
 *   checked: boolean,
 *   alg: string|null,
 *   reason: string|null,
 * }}
 */
export function verifySignedBundle(signed, secret) {
  let value = signed
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { ok: false, checked: false, alg: null, reason: 'bundle-invalid-json' }
    }
  }
  if (!isRecord(value)) {
    return { ok: false, checked: false, alg: null, reason: 'bundle-invalid' }
  }
  const signature = value[SIGNATURE_FIELD]
  if (!isRecord(signature)) {
    return {
      ok: false,
      checked: false,
      alg: null,
      reason: signature === undefined ? 'signature-missing' : 'signature-invalid',
    }
  }
  const alg = typeof signature.alg === 'string' ? signature.alg : null
  if (signature.alg !== SIGN_ALG) {
    return {
      ok: false,
      checked: false,
      alg,
      reason: 'signature-alg-unsupported',
    }
  }
  if (typeof signature.sig !== 'string' || !SHA256_HEX.test(signature.sig)) {
    return {
      ok: false,
      checked: false,
      alg,
      reason: 'signature-malformed',
    }
  }
  let key
  try {
    key = resolveSigningSecret(secret)
  } catch {
    return { ok: false, checked: false, alg, reason: 'secret-invalid' }
  }
  if (key === undefined) {
    return { ok: false, checked: false, alg, reason: 'secret-missing' }
  }
  let expected
  try {
    expected = createHmac('sha256', key)
      .update(signaturePayload(value), 'utf8')
      .digest('hex')
  } catch {
    return {
      ok: false,
      checked: false,
      alg,
      reason: 'bundle-not-canonicalizable',
    }
  }
  const expectedBytes = Buffer.from(expected, 'hex')
  const actualBytes = Buffer.from(signature.sig, 'hex')
  const ok =
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  return {
    ok,
    checked: true,
    alg,
    reason: ok ? null : 'signature-mismatch',
  }
}
