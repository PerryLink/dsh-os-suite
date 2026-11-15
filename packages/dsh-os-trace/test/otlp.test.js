import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createTraceStore, verifyBundle } from '../src/core.js'
import {
  OTLP_ATTR,
  OTLP_SCOPE_NAME,
  fromOtlp,
  toOtlp,
} from '../src/otlp.js'

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
 * @param {string} value
 * @returns {string}
 */
function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * @param {Record<string, unknown>[]} attributes
 * @returns {Record<string, unknown>}
 */
function attributeMap(attributes) {
  return Object.fromEntries(attributes.map((entry) => [entry.key, entry.value]))
}

test('toOtlp emits the OTLP/JSON envelope, ids, nanos and status codes', () => {
  const document = toOtlp(
    [
      span('root', { kind: 'workflow', name: 'run', attrs: { label: 'root' } }),
      span('tool-1', {
        parentId: 'root',
        startMs: T0 + 10,
        endMs: T0 + 20,
        status: 'error',
        attrs: { attempt: 2, ratio: 1.5, enabled: true },
      }),
    ],
    { serviceName: 'my-service' },
  )

  const resourceSpan = document.resourceSpans[0]
  assert.deepEqual(resourceSpan.resource.attributes, [
    { key: 'service.name', value: { stringValue: 'my-service' } },
  ])
  assert.equal(resourceSpan.scopeSpans[0].scope.name, OTLP_SCOPE_NAME)

  const [root, child] = resourceSpan.scopeSpans[0].spans
  assert.match(root.traceId, /^[0-9a-f]{32}$/)
  assert.equal(root.traceId, sha256('session-1').slice(0, 32))
  assert.match(root.spanId, /^[0-9a-f]{16}$/)
  assert.equal(root.spanId, sha256('root').slice(0, 16))
  assert.equal(Object.hasOwn(root, 'parentSpanId'), false)
  assert.equal(root.kind, 'SPAN_KIND_INTERNAL')
  assert.equal(root.startTimeUnixNano, '1700000000000000000')
  assert.equal(root.status.code, 1)
  assert.equal(child.parentSpanId, root.spanId)
  assert.equal(child.endTimeUnixNano, '1700000000020000000')
  assert.equal(child.status.code, 2)
  assert.equal(child.traceId, root.traceId)

  const rootAttrs = attributeMap(root.attributes)
  assert.deepEqual(rootAttrs.label, { stringValue: 'root' })
  assert.deepEqual(rootAttrs[OTLP_ATTR.id], { stringValue: 'root' })

  const childAttrs = attributeMap(child.attributes)
  assert.deepEqual(childAttrs.attempt, { intValue: '2' })
  assert.deepEqual(childAttrs.ratio, { doubleValue: 1.5 })
  assert.deepEqual(childAttrs.enabled, { boolValue: true })
  assert.deepEqual(childAttrs[OTLP_ATTR.parentId], { stringValue: 'root' })
})

test('trace ids use sessionId and fall back to the root span for session-less spans', () => {
  const sessionDocument = toOtlp([span('root'), span('child', { parentId: 'root' })])
  const [root, child] = sessionDocument.resourceSpans[0].scopeSpans[0].spans
  assert.equal(root.traceId, sha256('session-1').slice(0, 32))
  assert.equal(child.traceId, root.traceId)

  const orphanDocument = toOtlp([
    { id: 'root', kind: 'workflow', name: 'run', startMs: T0, status: 'ok' },
    { id: 'child', parentId: 'root', kind: 'tool', name: 'read', startMs: T0 + 1, status: 'ok' },
  ])
  const [orphanRoot, orphanChild] =
    orphanDocument.resourceSpans[0].scopeSpans[0].spans
  assert.equal(orphanRoot.traceId, sha256('root').slice(0, 32))
  assert.equal(orphanChild.traceId, orphanRoot.traceId)
  assert.equal(orphanRoot.spanId, sha256('root').slice(0, 16))
  assert.equal(orphanChild.parentSpanId, orphanRoot.spanId)
})

test('fromOtlp(toOtlp(spans)) round-trips DSH spans without losing causal data', () => {
  const spans = [
    span('root', {
      kind: 'workflow',
      name: 'run',
      agentPath: 'lead',
      attrs: {
        label: 'root',
        count: 3,
        ratio: 0.25,
        enabled: false,
        zero: 0,
        empty: '',
      },
    }),
    span('tool-1', {
      parentId: 'root',
      startMs: T0 + 10,
      endMs: T0 + 20,
      status: 'error',
      attrs: { nested: { nested: [1, 'two', true] } },
    }),
    span('sub-1', {
      parentId: 'tool-1',
      kind: 'subagent',
      startMs: T0 + 30,
      status: 'running',
      agentPath: 'lead/researcher',
    }),
  ]

  const imported = fromOtlp(toOtlp(spans))
  assert.deepEqual(imported, spans)
  assert.deepEqual(fromOtlp(JSON.stringify(toOtlp(spans))), spans)

  const store = createTraceStore()
  for (const importedSpan of imported) store.ingest(importedSpan)
  const bundle = store.exportBundle()
  assert.equal(verifyBundle(bundle).ok, true)
  assert.deepEqual(
    store.query({ order: 'asc' }).map((entry) => entry.id),
    ['root', 'tool-1', 'sub-1'],
  )
  assert.deepEqual(store.why('sub-1', 3).edges, [
    { parentId: 'root', childId: 'tool-1' },
    { parentId: 'tool-1', childId: 'sub-1' },
  ])
})

test('fromOtlp keeps unknown attributes and tolerates missing fields', () => {
  const imported = fromOtlp({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'foreign' } }] },
        scopeSpans: [
          {
            scope: { name: 'other-instrumentation' },
            spans: [
              {
                traceId: 'a'.repeat(32),
                spanId: 'b'.repeat(16),
                name: 'GET /health',
                startTimeUnixNano: '1700000000000000000',
                status: { code: 2 },
                attributes: [
                  { key: 'http.method', value: { stringValue: 'GET' } },
                  { key: 'http.status_code', value: { intValue: '500' } },
                  { key: 'retry', value: { boolValue: true } },
                  {
                    key: 'custom.nested',
                    value: { kvlistValue: { values: [{ key: 'x', value: { doubleValue: 1.5 } }] } },
                  },
                  { key: 'bytes', value: { bytesValue: 'AQID' } },
                ],
              },
              {
                traceId: 'a'.repeat(32),
                spanId: 'c'.repeat(16),
                parentSpanId: 'b'.repeat(16),
                startTimeUnixNano: '1700000000010000000',
                endTimeUnixNano: '1700000000020000000',
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  })

  assert.equal(imported.length, 2)
  assert.equal(imported[0].id, 'b'.repeat(16))
  assert.equal(imported[0].sessionId, 'a'.repeat(32))
  assert.equal(imported[0].kind, 'workflow')
  assert.equal(imported[0].name, 'GET /health')
  assert.equal(imported[0].startMs, T0)
  assert.equal(imported[0].status, 'error')
  assert.deepEqual(imported[0].attrs, {
    'http.method': 'GET',
    'http.status_code': 500,
    retry: true,
    'custom.nested': { x: 1.5 },
    bytes: 'AQID',
  })

  assert.equal(imported[1].id, 'c'.repeat(16))
  assert.equal(imported[1].parentId, 'b'.repeat(16))
  assert.equal(imported[1].name, 'unnamed')
  assert.equal(imported[1].status, 'ok')
  assert.equal(imported[1].endMs, T0 + 20)

  const partial = fromOtlp({
    resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'partial' }] }] }],
  })
  assert.equal(partial.length, 1)
  assert.equal(partial[0].id, 'otlp-1')
  assert.equal(partial[0].sessionId, 'otlp')
  assert.equal(partial[0].startMs, 0)
  assert.equal(partial[0].status, 'running')
  assert.equal(partial[0].kind, 'workflow')
  const store = createTraceStore()
  store.ingest(partial[0])
  assert.equal(store.query().length, 1)
})

test('status maps between DSH states and OTLP codes', () => {
  const document = toOtlp([
    span('ok', { status: 'ok' }),
    span('error', { status: 'error' }),
    span('running', { status: 'running' }),
  ])
  const spans = document.resourceSpans[0].scopeSpans[0].spans
  assert.deepEqual(
    spans.map((entry) => entry.status.code),
    [1, 2, 1],
  )
  assert.equal(Object.hasOwn(spans[2], 'endTimeUnixNano'), false)

  const imported = fromOtlp(document)
  assert.deepEqual(
    imported.map((entry) => entry.status),
    ['ok', 'error', 'running'],
  )
})

test('fromOtlp rejects bad JSON and malformed OTLP envelopes', () => {
  assert.throws(
    () => fromOtlp('{not json'),
    (error) => error.code === 'INVALID_OTLP' && /not valid JSON/.test(error.message),
  )
  assert.throws(
    () => fromOtlp({}),
    (error) => error.code === 'INVALID_OTLP' && /resourceSpans/.test(error.message),
  )
  assert.throws(
    () => fromOtlp(42),
    (error) => error.code === 'INVALID_OTLP',
  )
  assert.deepEqual(fromOtlp({ resourceSpans: [] }), [])
})
