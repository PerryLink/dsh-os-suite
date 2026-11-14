import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GENESIS_PREV_HASH,
  canonicalJson,
  createTraceStore,
  verifyBundle,
} from '../src/core.js'

const T0 = 1_700_000_000_000

/**
 * @param {string} id
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function span(id, overrides = {}) {
  return {
    id,
    sessionId: 'session-1',
    kind: 'tool',
    name: 'read_file',
    startMs: T0,
    status: 'ok',
    ...overrides,
  }
}

/**
 * @param {...Record<string, unknown>} spans
 */
function makeStore(spans) {
  const store = createTraceStore({ now: () => T0 + 1_000 })
  for (const entry of spans) store.ingest(entry)
  return store
}

test('query returns detached spans and supports filters, ordering and limits', () => {
  const store = makeStore([
    span('root', { kind: 'workflow', name: 'run', startMs: T0, attrs: { level: 0 } }),
    span('tool-1', { parentId: 'root', startMs: T0 + 10 }),
    span('mcp-1', { parentId: 'root', kind: 'mcp', startMs: T0 + 15 }),
    span('sub-1', { parentId: 'tool-1', kind: 'subagent', startMs: T0 + 20 }),
  ])

  assert.deepEqual(
    store.query({ sessionId: 'session-1' }).map((entry) => entry.id),
    ['root', 'tool-1', 'mcp-1', 'sub-1'],
  )
  assert.deepEqual(
    store.query({ parentId: 'root' }).map((entry) => entry.id),
    ['tool-1', 'mcp-1'],
  )
  assert.deepEqual(
    store.query({ kind: 'tool' }).map((entry) => entry.id),
    ['tool-1'],
  )
  assert.deepEqual(
    store.query({ kind: ['tool', 'mcp'] }).map((entry) => entry.id),
    ['tool-1', 'mcp-1'],
  )
  assert.deepEqual(
    store.query({ since: T0 + 15 }).map((entry) => entry.id),
    ['mcp-1', 'sub-1'],
  )
  assert.deepEqual(
    store.query({ until: T0 + 10 }).map((entry) => entry.id),
    ['root', 'tool-1'],
  )
  assert.deepEqual(
    store.query({ limit: 2 }).map((entry) => entry.id),
    ['root', 'tool-1'],
  )
  assert.deepEqual(
    store.query({ order: 'desc', limit: 1 }).map((entry) => entry.id),
    ['sub-1'],
  )
  assert.deepEqual(
    store.query({ parentId: null }).map((entry) => entry.id),
    ['root'],
  )

  const returned = store.query({ id: 'root' })[0]
  assert.ok(returned)
  returned.attrs.level = 99
  returned.name = 'mutated'
  assert.deepEqual(store.query({ id: 'root' })[0].attrs, { level: 0 })
  assert.equal(store.query({ id: 'root' })[0].name, 'run')

  assert.throws(
    () => store.query({ nope: true }),
    (error) => error.code === 'INVALID_QUERY',
  )
})

test('why walks ancestors and descendants, reports edges and depth truncation', () => {
  const store = makeStore([
    span('root', { kind: 'workflow', startMs: T0 }),
    span('tool-1', { parentId: 'root', startMs: T0 + 10 }),
    span('sub-1', { parentId: 'tool-1', kind: 'subagent', startMs: T0 + 20 }),
    span('job-1', { parentId: 'sub-1', kind: 'job', startMs: T0 + 30 }),
    span('mcp-1', { parentId: 'job-1', kind: 'mcp', startMs: T0 + 40 }),
  ])

  const around = store.why('sub-1', 1)
  assert.equal(around.found, true)
  assert.deepEqual(
    around.spans.map((entry) => entry.id),
    ['tool-1', 'sub-1', 'job-1'],
  )
  assert.deepEqual(around.edges, [
    { parentId: 'tool-1', childId: 'sub-1' },
    { parentId: 'sub-1', childId: 'job-1' },
  ])
  assert.deepEqual(around.missing, [])
  assert.equal(around.truncated, true)
  assert.equal(around.target.id, 'sub-1')

  const targetOnly = store.why('sub-1', 0)
  assert.deepEqual(
    targetOnly.spans.map((entry) => entry.id),
    ['sub-1'],
  )
  assert.equal(targetOnly.truncated, true)
  assert.equal(targetOnly.target.id, 'sub-1')

  const whole = store.why('root', 10)
  assert.deepEqual(
    whole.spans.map((entry) => entry.id),
    ['root', 'tool-1', 'sub-1', 'job-1', 'mcp-1'],
  )
  assert.equal(whole.truncated, false)
  assert.equal(whole.edges.length, 4)

  assert.throws(
    () => store.why('root', 65),
    (error) => error.code === 'INVALID_DEPTH',
  )
})

test('why keeps an explicit missing parent instead of inventing a root', () => {
  const store = makeStore([
    span('orphan', { parentId: 'ghost', startMs: T0 }),
    span('child', { parentId: 'orphan', startMs: T0 + 10 }),
  ])

  const result = store.why('orphan')
  assert.equal(result.found, true)
  assert.equal(result.target.id, 'orphan')
  assert.deepEqual(
    result.spans.map((entry) => entry.id),
    ['orphan', 'child'],
  )
  assert.deepEqual(result.missing, ['ghost'])
  assert.deepEqual(result.edges, [{ parentId: 'orphan', childId: 'child' }])
  assert.equal(result.truncated, false)

  const absent = store.why('does-not-exist')
  assert.equal(absent.found, false)
  assert.equal(absent.target, null)
  assert.deepEqual(absent.spans, [])
  assert.deepEqual(absent.edges, [])
  assert.deepEqual(absent.missing, ['does-not-exist'])
  assert.equal(absent.truncated, false)
})

test('hash chain is deterministic and verifies', () => {
  const first = makeStore([
    span('a', { attrs: { z: 1, nested: { b: 2, a: 1 } } }),
    span('b', { parentId: 'a', kind: 'approval', startMs: T0 + 10 }),
    span('c', { parentId: 'b', kind: 'job', startMs: T0 + 20, status: 'error' }),
  ])
  const second = makeStore([
    span('a', { attrs: { nested: { a: 1, b: 2 }, z: 1 } }),
    span('b', { parentId: 'a', kind: 'approval', startMs: T0 + 10 }),
    span('c', { parentId: 'b', kind: 'job', startMs: T0 + 20, status: 'error' }),
  ])

  const bundle = first.exportBundle()
  assert.equal(bundle.spanCount, 3)
  assert.equal(bundle.format, 'dsh-os-trace/bundle')
  assert.equal(bundle.spans[0].prevHash, GENESIS_PREV_HASH)
  for (let index = 1; index < bundle.spans.length; index += 1) {
    assert.equal(bundle.spans[index].prevHash, bundle.spans[index - 1].hash)
  }
  for (const entry of bundle.spans) assert.match(entry.hash, /^[0-9a-f]{64}$/)
  assert.equal(bundle.rootHash, bundle.spans[2].hash)
  assert.equal(bundle.sourceRootHash, bundle.spans[2].hash)

  assert.deepEqual(
    second.exportBundle().spans.map((entry) => entry.hash),
    bundle.spans.map((entry) => entry.hash),
  )

  const verified = first.verifyBundle(bundle)
  assert.equal(verified.ok, true)
  assert.equal(verified.count, 3)
  assert.equal(verified.checked, 3)
  assert.equal(verified.rootHash, bundle.rootHash)
  assert.equal(verified.firstBad, null)
  assert.equal(verifyBundle(bundle).ok, true)

  // The canonical form is sorted and whitespace-free.
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')

  const empty = createTraceStore({ now: () => T0 }).exportBundle()
  assert.equal(empty.spanCount, 0)
  assert.equal(empty.rootHash, GENESIS_PREV_HASH)
  assert.equal(first.verifyBundle(empty).ok, true)
})

test('verifyBundle detects edited, reordered, relinked and malformed bundles', () => {
  const store = makeStore([
    span('a', { attrs: { value: 'one' } }),
    span('b', { parentId: 'a', startMs: T0 + 10, attrs: { value: 'two' } }),
    span('c', { parentId: 'b', startMs: T0 + 20, attrs: { value: 'three' } }),
  ])
  const bundle = store.exportBundle()

  const edited = structuredClone(bundle)
  edited.spans[1].name = 'tampered'
  const editedResult = verifyBundle(edited)
  assert.equal(editedResult.ok, false)
  assert.equal(editedResult.checked, 1)
  assert.equal(editedResult.firstBad.index, 1)
  assert.equal(editedResult.firstBad.id, 'b')
  assert.equal(editedResult.firstBad.reason, 'hash mismatch')

  const reordered = structuredClone(bundle)
  reordered.spans = [reordered.spans[1], reordered.spans[0], reordered.spans[2]]
  const reorderedResult = verifyBundle(reordered)
  assert.equal(reorderedResult.ok, false)
  assert.equal(reorderedResult.firstBad.index, 0)
  assert.equal(reorderedResult.firstBad.reason, 'prevHash does not match the previous span hash')

  const relinked = structuredClone(bundle)
  relinked.spans.pop()
  relinked.rootHash = relinked.spans[1].hash
  const relinkedResult = verifyBundle(relinked)
  assert.equal(relinkedResult.ok, false)
  assert.equal(relinkedResult.firstBad.reason, 'spanCount does not match bundle.spans.length')

  const badRoot = structuredClone(bundle)
  badRoot.rootHash = 'f'.repeat(64)
  const badRootResult = verifyBundle(badRoot)
  assert.equal(badRootResult.ok, false)
  assert.equal(badRootResult.firstBad.index, 2)
  assert.equal(badRootResult.firstBad.reason, 'rootHash does not match the final span hash')

  const malformed = verifyBundle({ spans: 'not-an-array' })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.firstBad.index, -1)

  const wrongVersion = verifyBundle({ ...structuredClone(bundle), version: 99 })
  assert.equal(wrongVersion.ok, false)
  assert.equal(wrongVersion.firstBad.reason, 'unsupported bundle version')
})

test('redaction is recursive, case-insensitive and re-seals the exported chain', () => {
  const store = makeStore([
    span('a', {
      attrs: {
        apiKey: 'sk-live-123',
        nested: { token: 'tok-456', safe: 'visible' },
        list: [{ Token: 'tok-789' }, 'plain'],
      },
    }),
    span('b', { parentId: 'a', startMs: T0 + 10, attrs: { apiKey: 'sk-live-999' } }),
  ])

  const original = store.exportBundle()
  const redacted = store.exportBundle({ redact: ['apiKey', 'token'] })
  const serialized = JSON.stringify(redacted)
  assert.equal(serialized.includes('sk-live-123'), false)
  assert.equal(serialized.includes('tok-456'), false)
  assert.equal(serialized.includes('tok-789'), false)
  assert.equal(serialized.includes('[redacted]'), true)
  assert.deepEqual(redacted.redaction, { fields: ['apiKey', 'token'], applied: true })
  assert.equal(redacted.sourceRootHash, original.rootHash)
  assert.notEqual(redacted.spans[0].hash, original.spans[0].hash)
  assert.equal(store.verifyBundle(redacted).ok, true)

  // The store itself is untouched.
  assert.equal(store.query({ id: 'a' })[0].attrs.apiKey, 'sk-live-123')
  assert.equal(JSON.stringify(original).includes('sk-live-123'), true)
  assert.equal(store.verifyBundle(original).ok, true)

  // No requested fields means no re-seal: the original hashes are retained.
  const noop = store.exportBundle({ redact: [] })
  assert.deepEqual(
    noop.spans.map((entry) => entry.hash),
    original.spans.map((entry) => entry.hash),
  )

  assert.throws(
    () => store.exportBundle({ redact: 'apiKey' }),
    (error) => error.code === 'INVALID_REDACTION',
  )
})

test('ingest rejects malformed spans, duplicates and causal cycles', () => {
  const store = createTraceStore()

  assert.throws(
    () => store.ingest(span('a', { kind: 'unknown' })),
    (error) => error.code === 'INVALID_SPAN',
  )
  assert.throws(
    () => store.ingest(span('a', { parentId: 'a' })),
    (error) => error.code === 'CAUSAL_CYCLE',
  )
  assert.throws(
    () => store.ingest(span('a', { attrs: [] })),
    (error) => error.code === 'INVALID_SPAN',
  )
  assert.throws(
    () => store.ingest(span('a', { startMs: T0, endMs: T0 - 1 })),
    (error) => error.code === 'INVALID_SPAN',
  )
  assert.throws(
    () => store.ingest(span('a', { unexpected: true })),
    (error) => error.code === 'INVALID_SPAN',
  )

  store.ingest(span('a'))
  assert.throws(
    () => store.ingest(span('a')),
    (error) => error.code === 'DUPLICATE_SPAN',
  )

  store.ingest(span('b', { parentId: 'not-yet-ingested' }))
  assert.throws(
    () => store.ingest(span('not-yet-ingested', { parentId: 'b' })),
    (error) => error.code === 'CAUSAL_CYCLE',
  )

  // A stale caller-provided hash is ignored; the store owns the chain.
  const stored = store.ingest(span('c', { hash: 'stale', prevHash: 'stale' }))
  assert.notEqual(stored.hash, 'stale')
  assert.equal(store.verifyBundle(store.exportBundle()).ok, true)
})
