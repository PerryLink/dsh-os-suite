import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name, verifySignedBundle } from '../src/index.js'
import { TraceError } from '../src/core.js'
import { createFakeCtx, toolsByName } from './fake-ctx.js'

const T0 = 1_700_000_000_000

/**
 * @param {Record<string, unknown>} [config]
 */
function setup(config = {}) {
  const ctx = createFakeCtx()
  apply(ctx, config)
  return { ctx, definitions: ctx.definitions, tools: toolsByName(ctx.definitions) }
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} [overrides]
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

test('apply registers the five trace tools with schemas', () => {
  const { definitions, tools } = setup({ now: () => T0 })
  assert.equal(name, 'dsh-os-trace')
  assert.deepEqual(inject, ['tools'])
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ['trace_query', 'trace_why', 'trace_export', 'trace_verify', 'trace_live_status'],
  )
  for (const definition of definitions) {
    assert.ok(definition.parameters)
    assert.ok(definition.output)
    assert.equal(definition.output.schema.type, 'object')
  }
  assert.deepEqual(Object.keys(tools).sort(), [
    'trace_export',
    'trace_live_status',
    'trace_query',
    'trace_verify',
    'trace_why',
  ])
})

test('tools share one seeded store from query through verify', async () => {
  const { tools } = setup({
    now: () => T0 + 1_000,
    spans: [
      span('root', { kind: 'workflow', name: 'run', attrs: { apiKey: 'sk-root' } }),
      span('tool', { parentId: 'root', name: 'read_file', startMs: T0 + 10 }),
      span('sub', { parentId: 'tool', kind: 'subagent', startMs: T0 + 20 }),
    ],
  })

  const queried = await tools.trace_query.execute({ sessionId: 'session-1' }, {})
  assert.equal(queried.count, 3)
  assert.deepEqual(
    queried.spans.map((entry) => entry.id),
    ['root', 'tool', 'sub'],
  )

  const filtered = await tools.trace_query.execute({ kind: 'subagent' }, {})
  assert.equal(filtered.count, 1)
  assert.equal(filtered.spans[0].id, 'sub')

  const why = await tools.trace_why.execute({ eventId: 'tool', depth: 2 }, {})
  assert.equal(why.found, true)
  assert.deepEqual(
    why.spans.map((entry) => entry.id),
    ['root', 'tool', 'sub'],
  )
  assert.deepEqual(why.missing, [])
  assert.equal(why.target.id, 'tool')

  const exported = await tools.trace_export.execute({ redact: ['apiKey'] }, {})
  assert.equal(exported.format, 'dsh-os-trace/bundle')
  assert.equal(exported.spanCount, 3)
  assert.equal(JSON.stringify(exported).includes('sk-root'), false)
  assert.equal(JSON.stringify(exported).includes('[redacted]'), true)

  const verified = await tools.trace_verify.execute({ bundle: exported }, {})
  assert.equal(verified.ok, true)
  assert.equal(verified.count, 3)
  assert.equal(verified.firstBad, null)

  const fromJson = await tools.trace_verify.execute(
    { bundle: JSON.stringify(exported) },
    {},
  )
  assert.equal(fromJson.ok, true)

  const tampered = structuredClone(exported)
  tampered.spans[1].status = 'error'
  const tamperedResult = await tools.trace_verify.execute({ bundle: tampered }, {})
  assert.equal(tamperedResult.ok, false)
  assert.equal(tamperedResult.firstBad.index, 1)
  assert.equal(tamperedResult.firstBad.id, 'tool')

  const invalidJson = await tools.trace_verify.execute({ bundle: '{nope' }, {})
  assert.equal(invalidJson.ok, false)
  assert.equal(invalidJson.firstBad.index, -1)
  assert.match(invalidJson.firstBad.reason, /not valid JSON/)
})

test('apply loads a read-only JSONL dataFile', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-os-trace-'))
  const dataFile = join(directory, 'spans.jsonl')
  writeFileSync(
    dataFile,
    [
      JSON.stringify(span('file-root', { kind: 'workflow', name: 'run' })),
      '',
      JSON.stringify(span('file-child', { parentId: 'file-root', startMs: T0 + 10 })),
    ].join('\n'),
    'utf8',
  )

  try {
    const { tools } = setup({ dataFile, now: () => T0 })
    const queried = await tools.trace_query.execute({}, {})
    assert.equal(queried.count, 2)
    assert.deepEqual(
      queried.spans.map((entry) => entry.id),
      ['file-root', 'file-child'],
    )
    const why = await tools.trace_why.execute({ eventId: 'file-child' }, {})
    assert.deepEqual(
      why.spans.map((entry) => entry.id),
      ['file-root', 'file-child'],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('apply reports invalid config instead of starting an empty store', () => {
  assert.throws(
    () => setup({ spans: 'not-an-array' }),
    (error) => error instanceof TraceError && error.code === 'INVALID_OPTIONS',
  )
  assert.throws(
    () => setup({ dataFile: '/definitely/not/here/spans.jsonl' }),
    (error) => error instanceof TraceError && error.code === 'INVALID_DATA_FILE',
  )
  assert.throws(
    () => setup({ ingest: 'yes' }),
    (error) => error instanceof TraceError && error.code === 'INVALID_OPTIONS',
  )
  assert.throws(
    () => setup({ secret: '' }),
    (error) => error instanceof TraceError && error.code === 'INVALID_OPTIONS',
  )
})

test('trace_live_status reports collector state and ingest:false disables attach', async () => {
  const { ctx, tools } = setup({ now: () => T0 })
  const initial = await tools.trace_live_status.execute({}, {})
  assert.equal(initial.attached, true)
  assert.equal(initial.running, 0)
  assert.equal(initial.finalized, 0)

  ctx.emit('tools/pre-execute', {
    callId: 'call-live',
    name: 'read_file',
    agent: { id: 'session-1', session: { id: 'session-1' } },
  })
  const running = await tools.trace_live_status.execute({}, {})
  assert.equal(running.running, 1)
  assert.equal(running.events, 1)
  assert.equal(running.mapped, 1)

  ctx.emit('tools/post-execute', { callId: 'call-live', name: 'read_file' }, {
    isError: false,
    content: [],
  })
  const finalized = await tools.trace_live_status.execute({}, {})
  assert.equal(finalized.running, 0)
  assert.equal(finalized.finalized, 1)
  assert.ok(finalized.subscribed.includes('session/event'))

  const disabled = setup({ now: () => T0, ingest: false })
  const off = await disabled.tools.trace_live_status.execute({}, {})
  assert.equal(off.attached, false)
  assert.equal(off.subscriptions, 0)
  disabled.ctx.emit('tools/pre-execute', { callId: 'ignored', name: 'x' })
  const queried = await disabled.tools.trace_query.execute({}, {})
  assert.equal(queried.count, 0)
})

test('trace_export sign:true uses config.secret or TESTATUM_KEY and never leaks it', async () => {
  const { tools } = setup({
    now: () => T0,
    secret: 'config-secret',
    spans: [span('signed-root', { kind: 'workflow', name: 'run', attrs: { apiKey: 'sk-live' } })],
  })
  const signed = await tools.trace_export.execute({ sign: true }, {})
  assert.equal(signed.signature.alg, 'hmac-sha256')
  assert.match(signed.signature.sig, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(signed).includes('config-secret'), false)
  assert.equal(verifySignedBundle(signed, 'config-secret').ok, true)

  const tampered = structuredClone(signed)
  tampered.spans[0].name = 'tampered'
  assert.equal(verifySignedBundle(tampered, 'config-secret').ok, false)

  const unsigned = await tools.trace_export.execute({}, {})
  assert.equal(unsigned.signature, undefined)

  const redactedSigned = await tools.trace_export.execute({ redact: ['apiKey'], sign: true }, {})
  assert.equal(JSON.stringify(redactedSigned).includes('sk-live'), false)
  assert.equal(redactedSigned.redaction.applied, true)
  assert.equal(verifySignedBundle(redactedSigned, 'config-secret').ok, true)

  const previous = process.env.TESTATUM_KEY
  delete process.env.TESTATUM_KEY
  try {
    const noSecret = setup({ now: () => T0, spans: [span('no-secret')] })
    await assert.rejects(
      () => noSecret.tools.trace_export.execute({ sign: true }, {}),
      (error) =>
        error instanceof TraceError &&
        error.code === 'SIGNING_KEY_MISSING' &&
        !error.message.includes('secret-'),
    )

    process.env.TESTATUM_KEY = 'env-secret'
    const fromEnv = await noSecret.tools.trace_export.execute({ sign: true }, {})
    assert.equal(JSON.stringify(fromEnv).includes('env-secret'), false)
    assert.equal(verifySignedBundle(fromEnv).ok, true)
  } finally {
    if (previous === undefined) delete process.env.TESTATUM_KEY
    else process.env.TESTATUM_KEY = previous
  }
})
