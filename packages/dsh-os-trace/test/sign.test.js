import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  SECRET_ENV,
  SIGN_ALG,
  signBundle,
  signaturePayload,
  verifySignedBundle,
} from '../src/sign.js'

const T0 = 1_700_000_000_000

/**
 * @param {Record<string, unknown>} [overrides]
 */
function bundle(overrides = {}) {
  return {
    format: 'dsh-os-trace/bundle',
    version: 1,
    hashAlgo: 'sha256',
    exportedAt: T0,
    spanCount: 1,
    rootHash: 'a'.repeat(64),
    sourceRootHash: 'a'.repeat(64),
    genesisPrevHash: '0'.repeat(64),
    redaction: { fields: [], applied: false },
    spans: [
      {
        id: 'tool-1',
        sessionId: 'session-1',
        kind: 'tool',
        name: 'read_file',
        startMs: T0,
        status: 'ok',
        hash: 'a'.repeat(64),
        prevHash: '0'.repeat(64),
      },
    ],
    ...overrides,
  }
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} secret
 */
function signed(value, secret) {
  return { ...value, signature: signBundle(value, secret) }
}

test('signBundle emits the testatum-attest v1 signature shape and HMAC payload', () => {
  const value = { b: 'x', a: 1 }
  const expected = createHmac('sha256', 'secret-1')
    .update('{"a":1,"b":"x"}', 'utf8')
    .digest('hex')
  assert.deepEqual(signBundle(value, 'secret-1'), {
    alg: SIGN_ALG,
    sig: expected,
  })
  assert.equal(SIGN_ALG, 'hmac-sha256')
  assert.equal(
    signaturePayload({ ...value, signature: { alg: SIGN_ALG, sig: 'f'.repeat(64) } }),
    '{"a":1,"b":"x"}',
  )
})

test('signBundle is deterministic, key-order independent and does not mutate the bundle', () => {
  const first = bundle()
  const second = bundle({
    spans: [
      {
        status: 'ok',
        name: 'read_file',
        kind: 'tool',
        id: 'tool-1',
        sessionId: 'session-1',
        startMs: T0,
        hash: 'a'.repeat(64),
        prevHash: '0'.repeat(64),
      },
    ],
  })
  const sigFirst = signBundle(first, 'secret-1')
  const sigSecond = signBundle(second, 'secret-1')
  assert.equal(sigFirst.sig, sigSecond.sig)
  assert.match(sigFirst.sig, /^[0-9a-f]{64}$/)
  assert.equal('signature' in first, false)
  assert.notEqual(signBundle(first, 'secret-2').sig, sigFirst.sig)
})

test('verifySignedBundle recomputes the HMAC and accepts object or JSON text', () => {
  const envelope = signed(bundle(), 'secret-1')
  const result = verifySignedBundle(envelope, 'secret-1')
  assert.deepEqual(result, {
    ok: true,
    checked: true,
    alg: 'hmac-sha256',
    reason: null,
  })
  assert.equal(verifySignedBundle(JSON.stringify(envelope), 'secret-1').ok, true)
})

test('verifySignedBundle fails closed for missing/invalid signatures and wrong secrets', () => {
  const envelope = signed(bundle(), 'secret-1')

  assert.equal(verifySignedBundle(bundle(), 'secret-1').reason, 'signature-missing')
  assert.equal(
    verifySignedBundle({ ...envelope, signature: 'nope' }, 'secret-1').reason,
    'signature-invalid',
  )
  assert.equal(
    verifySignedBundle(
      { ...envelope, signature: { alg: 'ed25519', sig: envelope.signature.sig } },
      'secret-1',
    ).reason,
    'signature-alg-unsupported',
  )
  assert.equal(
    verifySignedBundle(
      { ...envelope, signature: { alg: SIGN_ALG, sig: 'not-hex' } },
      'secret-1',
    ).reason,
    'signature-malformed',
  )
  assert.equal(verifySignedBundle(envelope, 'wrong-secret').reason, 'signature-mismatch')
  assert.equal(verifySignedBundle('{nope', 'secret-1').reason, 'bundle-invalid-json')
  assert.equal(verifySignedBundle(null, 'secret-1').reason, 'bundle-invalid')
})

test('any bundle field tamper fails signature verification', () => {
  const envelope = signed(bundle(), 'secret-1')

  const spanEdit = structuredClone(envelope)
  spanEdit.spans[0].name = 'write_file'
  assert.equal(verifySignedBundle(spanEdit, 'secret-1').reason, 'signature-mismatch')

  const rootEdit = structuredClone(envelope)
  rootEdit.rootHash = 'b'.repeat(64)
  assert.equal(verifySignedBundle(rootEdit, 'secret-1').reason, 'signature-mismatch')

  const metadataEdit = structuredClone(envelope)
  metadataEdit.exportedAt = T0 + 1
  assert.equal(verifySignedBundle(metadataEdit, 'secret-1').reason, 'signature-mismatch')

  const signatureEdit = structuredClone(envelope)
  signatureEdit.signature.sig = 'f'.repeat(64)
  assert.equal(verifySignedBundle(signatureEdit, 'secret-1').reason, 'signature-mismatch')
})

test('verifySignedBundle accepts schema testatum/v1 and a keyId option', () => {
  const card = {
    schema: 'testatum/v1',
    name: 'demo-plugin',
    version: '1.2.3',
    rootHash: 'c'.repeat(64),
    createdAt: '2026-01-02T03:04:05.000Z',
  }
  const signature = signBundle(card, { secret: 'secret-1', keyId: 'release-2026-11' })
  assert.deepEqual(signature, {
    alg: 'hmac-sha256',
    sig: signature.sig,
    keyId: 'release-2026-11',
  })
  assert.equal(verifySignedBundle({ ...card, signature }, 'secret-1').ok, true)

  // A testatum-shaped object is verified by the same payload recipe.
  const manual = createHmac('sha256', 'secret-1')
    .update(signaturePayload({ ...card, signature }), 'utf8')
    .digest('hex')
  assert.equal(manual, signature.sig)
})

test('TESTATUM_KEY is the one-argument verification fallback and is never returned', () => {
  const previous = process.env[SECRET_ENV]
  process.env[SECRET_ENV] = 'env-secret'
  try {
    const envelope = signed(bundle(), 'env-secret')
    assert.equal(verifySignedBundle(envelope).ok, true)
    assert.equal(JSON.stringify(envelope).includes('env-secret'), false)

    delete process.env[SECRET_ENV]
    const missing = verifySignedBundle(envelope)
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'secret-missing')
    assert.equal(missing.checked, false)
  } finally {
    if (previous === undefined) delete process.env[SECRET_ENV]
    else process.env[SECRET_ENV] = previous
  }
})

test('Uint8Array secrets are supported and bad secrets are rejected', () => {
  const key = new TextEncoder().encode('bytes-secret')
  const envelope = { ...bundle(), signature: signBundle(bundle(), key) }
  assert.equal(verifySignedBundle(envelope, key).ok, true)
  assert.throws(
    () => signBundle(bundle(), ''),
    (error) => error.code === 'INVALID_SECRET',
  )
  assert.throws(
    () => signBundle(bundle(), {}),
    (error) => error.code === 'INVALID_SECRET',
  )
  assert.throws(
    () => signBundle(null, 'secret'),
    (error) => error.code === 'INVALID_BUNDLE',
  )
})
