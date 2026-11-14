import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../src/index.js'
import { TraceError } from '../src/core.js'

const T0 = 1_700_000_000_000

/**
 * @param {Record<string, unknown>} [config]
 */
function setup(config = {}) {
  /** @type {any[]} */
  const definitions = []
  const ctx = {
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
  }
  apply(ctx, config)
  /** @type {Record<string, any>} */
  const tools = {}
  for (const definition of definitions) tools[definition.name] = definition
  return { definitions, tools }
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

test('apply registers the four trace tools with schemas', () => {
  const { definitions, tools } = setup({ now: () => T0 })
  assert.equal(name, 'dsh-os-trace')
  assert.deepEqual(inject, ['tools'])
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ['trace_query', 'trace_why', 'trace_export', 'trace_verify'],
  )
  for (const definition of definitions) {
    assert.ok(definition.parameters)
    assert.ok(definition.output)
    assert.equal(definition.output.schema.type, 'object')
  }
  assert.deepEqual(Object.keys(tools).sort(), [
    'trace_export',
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
})
