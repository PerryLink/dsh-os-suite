import test from 'node:test'
import assert from 'node:assert/strict'
import { createTraceStore } from '../src/core.js'
import { createIngest } from '../src/ingest.js'
import { createFakeCtx } from './fake-ctx.js'

const T0 = 1_700_000_000_000

/**
 * @param {() => number} now
 */
function setup(now) {
  const store = createTraceStore({ now })
  const ingest = createIngest({ store, now })
  const ctx = createFakeCtx()
  ingest.attach(ctx)
  return { store, ingest, ctx }
}

/**
 * @param {Record<string, unknown>} [overrides]
 */
function exec(overrides = {}) {
  return {
    callId: 'call-1',
    name: 'read_file',
    arguments: { path: '/tmp/x' },
    agent: { id: 'session-1', session: { id: 'session-1' } },
    ...overrides,
  }
}

test('attach subscribes core and family events; detach is idempotent', () => {
  const { ingest, ctx } = setup(() => T0)
  assert.deepEqual(Object.keys(ingest).sort(), ['attach', 'detach', 'spans'])
  assert.equal(typeof ingest.status, 'function')
  const status = ingest.status()
  assert.equal(status.attached, true)
  assert.ok(status.subscriptions > 10)
  assert.equal(status.wildcard, true)
  for (const eventName of [
    'session/event',
    'tools/pre-execute',
    'tools/post-execute',
    'tool/result',
    'approval/*',
    'agent/*',
    'subagent/*',
    'job/*',
    'mcp/*',
    'internal/dispatch',
  ]) {
    assert.ok(status.subscribed.includes(eventName), `missing subscription ${eventName}`)
  }

  const before = ingest.status().subscriptions
  ingest.attach(ctx)
  assert.equal(ingest.status().subscriptions, before)

  ingest.detach()
  ingest.detach()
  assert.equal(ingest.status().attached, false)
  ctx.emit('tools/pre-execute', exec())
  assert.deepEqual(ingest.spans(), [])

  ingest.attach(ctx)
  assert.equal(ingest.status().attached, true)
  ctx.emit('tools/pre-execute', exec())
  assert.equal(ingest.spans().length, 1)
})

test('pre/post pair by call id, duplicate delivery is idempotent, missing post stays running', () => {
  let now = T0
  const { store, ingest, ctx } = setup(() => now)

  ctx.emit('tools/pre-execute', exec())
  let spans = ingest.spans()
  assert.equal(spans.length, 1)
  assert.equal(spans[0].id, 'tool:call-1')
  assert.equal(spans[0].status, 'running')
  assert.equal(spans[0].endMs, undefined)
  assert.equal(store.query({}).length, 0)
  assert.equal(ingest.status().running, 1)
  assert.equal(ingest.status().finalized, 0)

  now = T0 + 5
  ctx.emit('tools/post-execute', exec(), { isError: false, content: [] })
  spans = ingest.spans()
  assert.equal(spans.length, 1)
  assert.equal(spans[0].status, 'ok')
  assert.equal(spans[0].startMs, T0)
  assert.equal(spans[0].endMs, T0 + 5)
  assert.ok(spans[0].hash)
  assert.equal(store.query({}).length, 1)
  assert.equal(ingest.status().finalized, 1)
  assert.equal(ingest.status().running, 0)

  // Replayed pre/post must not add a second span or a second chain entry.
  ctx.emit('tools/pre-execute', exec())
  ctx.emit('tools/post-execute', exec(), { isError: false, content: [] })
  assert.equal(ingest.spans().length, 1)
  assert.equal(store.query({}).length, 1)
  assert.equal(ingest.status().errors, 0)

  now = T0 + 10
  ctx.emit('tools/pre-execute', exec({ callId: 'call-2' }))
  now = T0 + 20
  ctx.emit('tools/pre-execute', exec({ callId: 'call-3' }))
  ctx.emit(
    'tools/post-execute',
    exec({ callId: 'call-3' }),
    { isError: true, error: { message: 'boom', info: { code: 'E_BOOM' } }, content: [] },
  )
  spans = ingest.spans()
  assert.equal(spans.length, 3)
  assert.deepEqual(
    spans.map((span) => [span.id, span.status]),
    [
      ['tool:call-1', 'ok'],
      ['tool:call-2', 'running'],
      ['tool:call-3', 'error'],
    ],
  )
  assert.equal(spans[2].attrs.errorCode, 'E_BOOM')
  assert.equal(ingest.status().running, 1)
  assert.equal(store.query({}).length, 2)

  // spans() is detached from collector state.
  spans[0].status = 'error'
  assert.equal(ingest.spans()[0].status, 'ok')
})

test('session/event maps tool, turn and step lifecycles and ignores unknown events', () => {
  let now = T0
  const { store, ingest, ctx } = setup(() => now)
  const session = { id: 'session-1' }
  const send = (event) => ctx.emit('session/event', session, event)

  send({ type: 'turn/start', seq: 1, time: T0, data: { turn: 1 } })
  send({ type: 'step/start', seq: 2, time: T0 + 1, data: { turn: 1, step: 1 } })
  now = T0 + 2
  send({
    type: 'tool/call',
    seq: 3,
    time: T0 + 2,
    data: { turn: 1, step: 1, callId: 'call-9', name: 'bash', arguments: '{}' },
  })
  now = T0 + 3
  send({
    type: 'tool/result',
    seq: 4,
    time: T0 + 3,
    data: {
      turn: 1,
      step: 1,
      message: { toolCallId: 'call-9', isError: true, content: [] },
      error: { name: 'BashError', code: 'E_BASH' },
    },
  })
  send({ type: 'step/end', seq: 5, time: T0 + 4, data: { turn: 1, step: 1 } })
  send({ type: 'turn/end', seq: 6, time: T0 + 5, data: { turn: 1, reason: { kind: 'error' } } })

  const tool = ingest.spans().find((span) => span.id === 'tool:call-9')
  assert.equal(tool.status, 'error')
  assert.equal(tool.parentId, 'step:session-1:1:1')
  assert.equal(tool.attrs.callId, 'call-9')
  assert.equal(tool.attrs.turn, 1)

  const step = ingest.spans().find((span) => span.id === 'step:session-1:1:1')
  assert.equal(step.kind, 'session')
  assert.equal(step.status, 'ok')
  assert.equal(step.parentId, 'turn:session-1:1')

  const turn = ingest.spans().find((span) => span.id === 'turn:session-1:1')
  assert.equal(turn.kind, 'session')
  assert.equal(turn.status, 'error')
  assert.equal(turn.attrs.reason, 'error')

  assert.equal(store.query({ kind: 'session' }).length, 2)
  const why = store.why('tool:call-9', 2)
  assert.equal(why.found, true)
  assert.deepEqual(
    why.spans.map((span) => span.id),
    ['turn:session-1:1', 'step:session-1:1:1', 'tool:call-9'],
  )

  const before = ingest.spans().length
  send({ type: 'user/message', seq: 7, time: T0 + 6, data: { turn: 1 } })
  send(null)
  ctx.emit('session/event', null, null)
  assert.equal(ingest.spans().length, before)
  assert.ok(ingest.status().ignored >= 1)
  assert.equal(ingest.status().errors, 0)

  // Replayed tool/result is recognized but does not duplicate the span.
  send({
    type: 'tool/result',
    seq: 4,
    time: T0 + 3,
    data: { turn: 1, step: 1, message: { toolCallId: 'call-9', isError: true, content: [] } },
  })
  assert.equal(ingest.spans().length, before)
})

test('approval, subagent and job lifecycles pair by id and carry structural attrs', () => {
  let now = T0
  const { ingest, ctx } = setup(() => now)

  now = T0 + 1
  ctx.emit('session/event', { id: 'session-1' }, {
    type: 'approval/asked',
    seq: 1,
    time: T0 + 1,
    data: { id: 'approval-1', toolName: 'bash', callId: 'call-1', reason: 'needs shell' },
  })
  now = T0 + 2
  ctx.emit('session/event', { id: 'session-1' }, {
    type: 'approval/decided',
    seq: 2,
    time: T0 + 2,
    data: { id: 'approval-1', outcome: 'rejected' },
  })

  now = T0 + 3
  ctx.emit('subagent/start', {
    runId: 'run-1',
    provider: 'inproc',
    parentSessionId: 'session-1',
    id: 'child-1',
    local: true,
  })
  now = T0 + 4
  ctx.emit('subagent/end', {
    runId: 'run-1',
    provider: 'inproc',
    parentSessionId: 'session-1',
    id: 'child-1',
    local: true,
    stopReason: 'completed',
  })

  now = T0 + 5
  ctx.emit('session/event', { id: 'session-1' }, {
    type: 'job/registered',
    seq: 3,
    time: T0 + 5,
    data: { jobId: 'job-1', owner: 'session-1', kind: 'bash', label: 'sleep 1', startedAt: T0 + 5 },
  })
  now = T0 + 6
  ctx.emit('session/event', { id: 'session-1' }, {
    type: 'job/settled',
    seq: 4,
    time: T0 + 6,
    data: {
      jobId: 'job-1',
      owner: 'session-1',
      kind: 'bash',
      label: 'sleep 1',
      startedAt: T0 + 5,
      finishedAt: T0 + 6,
      status: 'completed',
      cause: 'producer',
      producerReported: true,
    },
  })

  // A direct approval/request carries an agent; its id must not be mistaken
  // for the approval id. The later session asked/decided events pair by callId.
  ctx.emit(
    'approval/request',
    { agent: { id: 'session-1' }, toolName: 'bash', callId: 'call-2' },
    () => 'allowed-once',
  )
  ctx.emit('session/event', { id: 'session-1' }, {
    type: 'approval/asked',
    seq: 5,
    time: T0 + 7,
    data: { id: 'approval-2', toolName: 'bash', callId: 'call-2' },
  })
  ctx.emit('session/event', { id: 'session-1' }, {
    type: 'approval/decided',
    seq: 6,
    time: T0 + 8,
    data: { id: 'approval-2', outcome: 'allowed-once' },
  })

  const spans = ingest.spans()
  const approval = spans.find((span) => span.kind === 'approval')
  assert.equal(approval.id, 'approval:approval-1')
  assert.equal(approval.status, 'error')
  assert.equal(approval.attrs.outcome, 'rejected')
  assert.equal(approval.attrs.toolName, 'bash')

  const requested = spans.find((span) => span.attrs?.approvalId === 'approval-2')
  assert.equal(requested.id, 'approval:call-2')
  assert.equal(requested.status, 'ok')
  assert.equal(requested.attrs.callId, 'call-2')

  const subagent = spans.find((span) => span.kind === 'subagent')
  assert.equal(subagent.id, 'subagent:run-1')
  assert.equal(subagent.status, 'ok')
  assert.equal(subagent.attrs.provider, 'inproc')
  assert.equal(subagent.attrs.childId, 'child-1')

  const job = spans.find((span) => span.kind === 'job')
  assert.equal(job.id, 'job:job-1')
  assert.equal(job.status, 'ok')
  assert.equal(job.name, 'sleep 1')
  assert.equal(job.startMs, T0 + 5)
  assert.equal(job.endMs, T0 + 6)

  // Duplicate end events are no-ops.
  ctx.emit('subagent/end', { runId: 'run-1', stopReason: 'completed' })
  assert.equal(ingest.spans().length, spans.length)
})

test('mcp tool names and mcp lifecycle events are classified; unknown events are ignored', () => {
  let now = T0
  const { ingest, ctx } = setup(() => now)

  ctx.emit('tools/pre-execute', exec({ callId: 'mcp-call', name: 'mcp__github__search' }))
  now = T0 + 1
  ctx.emit('tools/post-execute', exec({ callId: 'mcp-call', name: 'mcp__github__search' }), {
    isError: false,
    content: [],
  })
  const mcpTool = ingest.spans().find((span) => span.id === 'mcp:mcp-call')
  assert.equal(mcpTool.kind, 'mcp')
  assert.equal(mcpTool.status, 'ok')
  assert.equal(mcpTool.attrs.mcpServer, 'github')

  now = T0 + 2
  ctx.emit('mcp/connect', { serverName: 'github' })
  ctx.emit('mcp/connect', { serverName: 'github' })
  assert.equal(ingest.spans().filter((span) => span.kind === 'mcp').length, 2)
  now = T0 + 3
  ctx.emit('mcp/disconnected', { serverName: 'github' })
  const connected = ingest.spans().find((span) => span.name === 'mcp/connect')
  assert.equal(connected.status, 'ok')

  const before = ingest.spans().length
  ctx.emit('mystery/event', { id: 'x' })
  ctx.emit('totally/unknown', {})
  ctx.emit('tools/pre-execute', null)
  ctx.emit('tool/result', null)
  assert.equal(ingest.spans().length, before)
  assert.equal(ingest.status().errors, 0)
  assert.ok(ingest.status().ignored >= 2)

  // High-frequency agent frames and non-lifecycle suffixes must not create
  // spans (or even be counted) through the internal/dispatch catch-all.
  const eventsBeforeInternal = ingest.status().events
  ctx.emit('internal/dispatch', 'emit', 'agent/assistant-stream', [
    { agent: { id: 'session-1' }, frame: { type: 'text' } },
  ], null)
  ctx.emit('internal/dispatch', 'emit', 'agent/request', [
    { agent: { id: 'session-1' }, turn: 1, step: 1 },
  ], null)
  ctx.emit('internal/dispatch', 'emit', 'agent/request-error', [
    { agent: { id: 'session-1' }, provider: 'x', failure: { code: 'E' } },
  ], null)
  assert.equal(ingest.spans().length, before)
  assert.equal(ingest.status().events, eventsBeforeInternal)

  // Unknown but clearly lifecycle-shaped family events are caught by the
  // internal/dispatch fallback.
  ctx.emit('internal/dispatch', 'emit', 'mcp/server-start', [
    { serverName: 'future-server' },
  ], null)
  ctx.emit('internal/dispatch', 'emit', 'mcp/server-end', [
    { serverName: 'future-server' },
  ], null)
  const future = ingest.spans().find((span) => span.id === 'mcp:event:future-server')
  assert.equal(future.status, 'ok')
  assert.equal(future.attrs.event, 'mcp/server-end')
  assert.equal(ingest.spans().length, before + 1)
})

test('field-name variants are tolerated without throwing', () => {
  let now = T0
  const { ingest, ctx } = setup(() => now)

  ctx.emit('tools/pre-execute', {
    id: 'exec-1',
    tool: 'bash',
    callId: 'call-variant',
    agent: { id: 'session-variant' },
  })
  now = T0 + 1
  ctx.emit(
    'tools/post-execute',
    { toolName: 'bash', callId: 'call-variant' },
    { status: 'error' },
  )
  const span = ingest.spans()[0]
  assert.equal(span.id, 'tool:call-variant')
  assert.equal(span.name, 'bash')
  assert.equal(span.sessionId, 'session-variant')
  assert.equal(span.status, 'error')

  now = T0 + 2
  ctx.emit('tool/result', 'call-variant', { isError: true })
  assert.equal(ingest.spans().length, 1)

  now = T0 + 3
  ctx.emit('tool/result', {
    callId: 'call-direct',
    toolName: 'grep',
    isError: false,
    content: [],
  })
  const direct = ingest.spans().find((entry) => entry.id === 'tool:call-direct')
  assert.equal(direct.status, 'ok')

  // Malformed deliveries are contained, not thrown into the host.
  ctx.emit('tools/pre-execute', {})
  ctx.emit('tools/post-execute', {})
  ctx.emit('approval/request', {})
  ctx.emit('subagent/start', {})
  ctx.emit('job/registered', {})
  assert.equal(ingest.status().errors, 0)
})

test('waterfall listeners call next and preserve its result', () => {
  const { ingest, ctx } = setup(() => T0)
  let preNext = false
  const preResult = ctx.emit(
    'tools/pre-execute',
    exec(),
    () => {
      preNext = true
      return { kind: 'allow' }
    },
  )
  assert.equal(preNext, true)
  assert.deepEqual(preResult, [{ kind: 'allow' }])

  let postNext = false
  const postResult = ctx.emit(
    'tools/post-execute',
    exec(),
    { isError: false, content: [] },
    () => {
      postNext = true
      return { kind: 'accept' }
    },
  )
  assert.equal(postNext, true)
  assert.deepEqual(postResult, [{ kind: 'accept' }])

  let approvalNext = false
  const approvalResult = ctx.emit(
    'approval/request',
    { toolName: 'bash', callId: 'call-approval' },
    async () => {
      approvalNext = true
      return 'allowed-once'
    },
  )
  assert.equal(approvalNext, true)
  assert.equal(approvalResult.length, 1)
  assert.equal(ingest.status().running, 1)

  assert.throws(
    () =>
      ctx.emit('tools/pre-execute', exec({ callId: 'boom' }), () => {
        throw new Error('next failed')
      }),
    /next failed/,
  )
})

test('attach tolerates a ctx without on() and keeps counts after detach', () => {
  const store = createTraceStore({ now: () => T0 })
  const ingest = createIngest({ store, now: () => T0 })
  assert.equal(ingest.attach({ tools: { register() {} } }), false)
  assert.equal(ingest.status().attached, false)
  assert.match(ingest.status().lastError, /ctx\.on/)

  const ctx = createFakeCtx()
  ingest.attach(ctx)
  ctx.emit('tools/pre-execute', exec())
  const before = ingest.status()
  ingest.detach()
  const after = ingest.status()
  assert.equal(after.attached, false)
  assert.equal(after.events, before.events)
  assert.equal(after.running, before.running)
})
