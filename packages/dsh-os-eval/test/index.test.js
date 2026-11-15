import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index.js'
import { liveFailureSnapshot, liveSuccessSnapshot } from './live-snapshots.js'

/**
 * @param {string} name Fixture filename.
 * @returns {string} Absolute path to the fixture.
 */
function fixturePath(name) {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
}

/**
 * Minimal Cordis context with just the tool registry.
 *
 * @param {object} [extra] Optional services merged next to `tools`.
 * @returns {{ tools: object[], ctx: object }}
 */
function createContext(extra = {}) {
  /** @type {object[]} */
  const tools = []
  return {
    tools,
    ctx: {
      ...extra,
      tools: {
        register(definition) {
          tools.push(definition)
        },
      },
    },
  }
}

/**
 * Tool-registry context that can also publish `session/event` and record
 * `ctx.effect` disposers, like the Cordis host does.
 *
 * @returns {{
 *   tools: object[],
 *   ctx: object,
 *   listeners: Set<Function>,
 *   effects: Function[],
 *   emit: (sessionId: string, event: object) => void,
 *   dispose: () => void,
 * }} Fake host context.
 */
function createWatchContext() {
  /** @type {object[]} */
  const tools = []
  /** @type {Set<Function>} */
  const listeners = new Set()
  /** @type {Function[]} */
  const effects = []

  return {
    tools,
    listeners,
    effects,
    ctx: {
      tools: {
        register(definition) {
          tools.push(definition)
        },
      },
      on(eventName, listener) {
        assert.equal(eventName, 'session/event')
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      effect(setup) {
        effects.push(setup())
      },
    },
    emit(sessionId, event) {
      for (const listener of [...listeners]) listener({ id: sessionId }, event)
    },
    dispose() {
      for (const dispose of effects) dispose()
    },
  }
}

/**
 * @param {string} type Event type.
 * @param {object} data Event payload.
 * @param {number} seq Sequence number.
 * @returns {object} Session event.
 */
function watchEvent(type, data, seq) {
  return { type, seq, time: 1000 + seq, data }
}

test('apply registers exactly eval_run, eval_watch, eval_gate, and eval_report', () => {
  const { tools, ctx } = createContext()
  apply(ctx, {
    cases: [{
      id: 'configured',
      name: 'Configured case',
      input: 'hello',
      expect: { contains: ['hello'] },
    }],
  })

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['eval_run', 'eval_watch', 'eval_gate', 'eval_report'],
  )
})

test('configured cases, baselines, and an injected runner drive the gate', async () => {
  const { tools, ctx } = createContext()
  apply(ctx, {
    cases: [{
      id: 'configured',
      name: 'Configured case',
      input: 'hello',
      expect: { contains: ['hello'] },
    }],
    baselines: [{ caseId: 'configured', passRate: 1, p50Tokens: 10 }],
    runner: () => ({ output: 'hello', steps: 1, tokens: 13 }),
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  const runResult = await byName.get('eval_run').execute({ caseId: 'configured' })
  assert.equal(runResult.run.status, 'PASS')
  assert.equal(runResult.run.tokens, 13)

  const gateResult = await byName.get('eval_gate').execute({})
  assert.equal(gateResult.verdict, 'WARN')
  assert.deepEqual(gateResult.warned, ['configured'])
})

test('the three tools integrate through the default mock runner', async () => {
  const { tools, ctx } = createContext()
  apply(ctx)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  const runResult = await byName.get('eval_run').execute({
    caseId: 'inline',
    case: {
      id: 'inline',
      name: 'Inline case',
      input: 'hello world',
      expect: { contains: ['hello'], maxSteps: 2, maxTokens: 10 },
      tags: ['smoke'],
    },
    mock: { output: 'hello world', steps: 1, tokens: 5, latencyMs: 3 },
  })

  assert.equal(runResult.run.status, 'PASS')
  assert.equal(runResult.run.tokens, 5)
  assert.equal(runResult.comparison, null)

  const gateResult = await byName.get('eval_gate').execute({ tags: ['smoke'] })
  assert.equal(gateResult.verdict, 'PASS')
  assert.equal(gateResult.evaluated, 1)

  const reportResult = await byName.get('eval_report').execute({ tags: ['smoke'] })
  assert.equal(reportResult.total, 1)
  assert.equal(reportResult.passed, 1)
  assert.equal(Object.hasOwn(reportResult.cases[0], 'output'), false)
})

test('eval_run grades a recorded session file and eval_report adds its trajectory summary', async () => {
  const { tools, ctx } = createContext()
  apply(ctx, {
    cases: [{
      id: 'recorded',
      name: 'Recorded session',
      input: 'fixture',
      expect: { contains: ['All checks passed'], maxSteps: 1, maxTokens: 27 },
      tags: ['recorded'],
    }],
    baselines: [{ caseId: 'recorded', passRate: 1, p50Tokens: 40 }],
    // A host runner must not shadow the explicitly supplied recording.
    runner: () => ({ output: 'host runner must not run', steps: 99, tokens: 999 }),
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  const runResult = await byName.get('eval_run').execute({
    caseId: 'recorded',
    sessionFile: fixturePath('session-success.jsonl'),
    baseline: { passRate: 1, p50Tokens: 40 },
  })

  assert.equal(runResult.run.status, 'PASS')
  assert.equal(runResult.run.output, 'Read the README. All checks passed.')
  assert.equal(runResult.run.steps, 1)
  assert.equal(runResult.run.tokens, 27)
  assert.equal(runResult.source, 'file')
  assert.equal(runResult.trajectory.sessionId, 'fixture-success')
  assert.equal(runResult.trajectory.steps, 1)
  assert.equal(runResult.comparison.passRate, 1)
  assert.equal(runResult.comparison.tokenRegression, (27 - 40) / 40)

  const gateResult = await byName.get('eval_gate').execute({ tags: ['recorded'] })
  assert.equal(gateResult.verdict, 'PASS')

  const reportResult = await byName.get('eval_report').execute({ tags: ['recorded'] })
  assert.equal(reportResult.total, 1)
  assert.equal(reportResult.passed, 1)
  assert.equal(reportResult.source, 'file')
  assert.deepEqual(reportResult.sources, { live: 0, file: 1 })
  assert.equal(reportResult.trajectory.sessions, 1)
  assert.equal(reportResult.trajectory.steps, 1)
  assert.equal(reportResult.trajectory.tokens, 27)
  assert.deepEqual(reportResult.trajectory.tools, { read: 1 })
  assert.equal(reportResult.cases[0].source, 'file')
  assert.equal(reportResult.cases[0].trajectory.paired, 1)
  assert.equal(reportResult.cases[0].trajectory.toolErrors, 0)
  assert.equal(Object.hasOwn(reportResult.cases[0], 'output'), false)
  assert.equal(Object.hasOwn(reportResult.cases[0].trajectory, 'args'), false)
})

test('a recorded failure fails the gate and is visible in the trajectory summary', async () => {
  const { tools, ctx } = createContext()
  apply(ctx, {
    cases: [{
      id: 'recorded',
      name: 'Recorded session',
      input: 'fixture',
      expect: { contains: ['All checks passed'] },
    }],
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  const runResult = await byName.get('eval_run').execute({
    caseId: 'recorded',
    sessionFile: fixturePath('session-failure.jsonl'),
  })
  assert.equal(runResult.run.status, 'FAIL')
  assert.equal(runResult.trajectory.toolErrors, 1)
  assert.match(runResult.run.reasons.join('\n'), /does not contain "All checks passed"/)

  const gateResult = await byName.get('eval_gate').execute({})
  assert.equal(gateResult.verdict, 'FAIL')
  assert.deepEqual(gateResult.failed, ['recorded'])

  const reportResult = await byName.get('eval_report').execute({})
  assert.equal(reportResult.failed, 1)
  assert.equal(reportResult.cases[0].trajectory.sessionId, 'fixture-failure')
  assert.equal(reportResult.cases[0].trajectory.toolErrors, 1)
})

test('a later non-session run clears the stale trajectory summary', async () => {
  const { tools, ctx } = createContext()
  apply(ctx, {
    cases: [{
      id: 'recorded',
      name: 'Recorded session',
      input: 'fixture',
      expect: { contains: ['All checks passed'] },
    }],
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  await byName.get('eval_run').execute({
    caseId: 'recorded',
    sessionFile: fixturePath('session-success.jsonl'),
  })
  const afterMock = await byName.get('eval_run').execute({
    caseId: 'recorded',
    mock: { output: 'All checks passed from a mock' },
  })

  assert.equal(afterMock.trajectory, null)
  assert.equal(afterMock.source, null)
  const reportResult = await byName.get('eval_report').execute({})
  assert.equal(reportResult.trajectory.sessions, 0)
  assert.equal(reportResult.source, null)
  assert.deepEqual(reportResult.sources, { live: 0, file: 0 })
  assert.equal(reportResult.cases[0].source, null)
  assert.equal(reportResult.cases[0].trajectory, null)
})

test('eval_run reads a live session through sessionQuery and eval_report marks source=live', async () => {
  /** @type {string[]} */
  const reads = []
  const { tools, ctx } = createContext({
    sessionQuery: {
      async readSession(sessionId) {
        reads.push(sessionId)
        return liveSuccessSnapshot()
      },
    },
  })
  apply(ctx, {
    cases: [{
      id: 'live',
      name: 'Live session',
      input: 'live',
      expect: { contains: ['Live session passed.'], maxSteps: 1, maxTokens: 27 },
      tags: ['live'],
    }],
    // A host runner must not shadow the explicitly requested live read.
    runner: () => ({ output: 'host runner must not run', steps: 99, tokens: 999 }),
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  const runResult = await byName.get('eval_run').execute({
    caseId: 'live',
    liveSessionId: 'live-success',
  })

  assert.deepEqual(reads, ['live-success'])
  assert.equal(runResult.source, 'live')
  assert.equal(runResult.run.status, 'PASS')
  assert.equal(runResult.run.output, 'Live session passed.')
  assert.equal(runResult.run.steps, 1)
  assert.equal(runResult.run.tokens, 27)
  assert.equal(runResult.trajectory.sessionId, 'live-success')
  assert.equal(runResult.trajectory.toolErrors, 0)

  const reportResult = await byName.get('eval_report').execute({ tags: ['live'] })
  assert.equal(reportResult.source, 'live')
  assert.deepEqual(reportResult.sources, { live: 1, file: 0 })
  assert.equal(reportResult.cases[0].source, 'live')
  assert.equal(reportResult.cases[0].trajectory.sessionId, 'live-success')
  assert.equal(Object.hasOwn(reportResult.cases[0], 'output'), false)
})

test('a failing live session fails the gate and is visible in the trajectory summary', async () => {
  const { tools, ctx } = createContext({
    sessionQuery: {
      async readSession() {
        return liveFailureSnapshot()
      },
    },
  })
  apply(ctx, {
    cases: [{
      id: 'live-failure',
      name: 'Live failure',
      input: 'live',
      expect: { contains: ['Live session passed.'] },
    }],
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  const runResult = await byName.get('eval_run').execute({
    caseId: 'live-failure',
    liveSessionId: 'live-failure',
  })
  assert.equal(runResult.source, 'live')
  assert.equal(runResult.run.status, 'FAIL')
  assert.equal(runResult.trajectory.toolErrors, 1)
  assert.match(runResult.run.reasons.join('\n'), /does not contain "Live session passed\."/)

  const gateResult = await byName.get('eval_gate').execute({})
  assert.equal(gateResult.verdict, 'FAIL')
  assert.deepEqual(gateResult.failed, ['live-failure'])

  const reportResult = await byName.get('eval_report').execute({})
  assert.equal(reportResult.source, 'live')
  assert.deepEqual(reportResult.sources, { live: 1, file: 0 })
  assert.equal(reportResult.cases[0].source, 'live')
  assert.equal(reportResult.cases[0].trajectory.toolErrors, 1)
})

test('a missing sessionQuery service gives a clear error for liveSessionId', async () => {
  const { tools, ctx } = createContext()
  apply(ctx)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  await assert.rejects(
    byName.get('eval_run').execute({
      caseId: 'live',
      case: { id: 'live', name: 'Live', input: 'live', expect: {} },
      liveSessionId: 'live-success',
    }),
    (error) => error.code === 'SESSION_QUERY_UNAVAILABLE'
      && /sessionQuery/.test(error.message)
      && /sessionFile/.test(error.message),
  )

  const gateResult = await byName.get('eval_gate').execute({})
  assert.equal(gateResult.verdict, 'FAIL')
  assert.equal(gateResult.evaluated, 0)
})

test('sessionFile and liveSessionId are mutually exclusive', async () => {
  let reads = 0
  const { tools, ctx } = createContext({
    sessionQuery: {
      async readSession() {
        reads += 1
        return liveSuccessSnapshot()
      },
    },
  })
  apply(ctx, {
    cases: [{
      id: 'conflict',
      name: 'Conflict',
      input: 'fixture',
      expect: { contains: ['All checks passed'] },
    }],
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  await assert.rejects(
    byName.get('eval_run').execute({
      caseId: 'conflict',
      sessionFile: fixturePath('session-success.jsonl'),
      liveSessionId: 'live-success',
    }),
    (error) => error.code === 'CONFLICTING_SESSION_SOURCE'
      && /either sessionFile or liveSessionId/.test(error.message),
  )
  assert.equal(reads, 0)
})

test('eval_watch attach is explicit, filters by session, pairs steps, and detaches', async () => {
  const fake = createWatchContext()
  apply(fake.ctx)
  const watch = fake.tools.find((tool) => tool.name === 'eval_watch')

  // Activation registers tools only: there is no watcher and no listener yet.
  assert.equal(fake.listeners.size, 0)
  assert.deepEqual(await watch.execute({ action: 'status' }), { action: 'status', watchers: [] })

  const attached = await watch.execute({ action: 'attach', sessionId: 'session-a' })
  assert.equal(fake.listeners.size, 1)
  assert.deepEqual(attached, {
    action: 'attach',
    watchers: [{
      sessionId: 'session-a',
      attached: true,
      events: 0,
      steps: 0,
      paired: 0,
      toolErrors: 0,
      tools: [],
    }],
  })

  fake.emit('session-b', watchEvent('tool/call', { callId: 'other', name: 'write' }, 1))
  fake.emit('session-a', watchEvent('turn/start', { turn: 1 }, 2))
  fake.emit('session-a', watchEvent('tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-1',
    name: 'read',
    arguments: '{"path":"README.md"}',
  }, 3))
  fake.emit('session-a', watchEvent('future/event', { unknown: true }, 4))
  fake.emit('session-a', watchEvent('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'ok' }],
      isError: true,
    },
  }, 5))

  const status = await watch.execute({ action: 'status', sessionId: 'session-a' })
  assert.deepEqual(status, {
    action: 'status',
    watchers: [{
      sessionId: 'session-a',
      attached: true,
      events: 4,
      steps: 1,
      paired: 1,
      toolErrors: 1,
      tools: ['read'],
    }],
  })
  assert.equal((await watch.execute({ action: 'status' })).watchers.length, 1)

  const missing = await watch.execute({ action: 'status', sessionId: 'session-missing' })
  assert.deepEqual(missing.watchers[0], {
    sessionId: 'session-missing',
    attached: false,
    events: 0,
    steps: 0,
    paired: 0,
    toolErrors: 0,
    tools: [],
  })

  const detached = await watch.execute({ action: 'detach', sessionId: 'session-a' })
  assert.equal(fake.listeners.size, 0)
  assert.equal(detached.watchers[0].attached, false)
  assert.equal(detached.watchers[0].events, 4)

  fake.emit('session-a', watchEvent('turn/end', { turn: 1 }, 6))
  assert.deepEqual((await watch.execute({ action: 'status' })).watchers, [])
})

test('eval_watch attach is idempotent, detach-all clears watchers, and plugin dispose detaches', async () => {
  const fake = createWatchContext()
  apply(fake.ctx)
  const watch = fake.tools.find((tool) => tool.name === 'eval_watch')

  await watch.execute({ action: 'attach', sessionId: 'session-a' })
  await watch.execute({ action: 'attach', sessionId: 'session-a' })
  assert.equal(fake.listeners.size, 1)

  await watch.execute({ action: 'attach', sessionId: 'session-b' })
  assert.equal(fake.listeners.size, 2)

  const detached = await watch.execute({ action: 'detach' })
  assert.deepEqual(
    detached.watchers.map((entry) => entry.sessionId).sort(),
    ['session-a', 'session-b'],
  )
  assert.equal(detached.watchers.every((entry) => entry.attached === false), true)
  assert.equal(fake.listeners.size, 0)

  await watch.execute({ action: 'attach', sessionId: 'session-c' })
  assert.equal(fake.listeners.size, 1)
  fake.dispose()
  assert.equal(fake.listeners.size, 0)
  assert.deepEqual((await watch.execute({ action: 'status' })).watchers, [])
})

test('eval_watch rejects unknown actions and malformed targets', async () => {
  const fake = createWatchContext()
  apply(fake.ctx)
  const watch = fake.tools.find((tool) => tool.name === 'eval_watch')

  // The tool schema rejects an action outside the enum before execute runs;
  // runWatchAction keeps an equivalent guard for direct programmatic use.
  await assert.rejects(
    watch.execute({ action: 'stop' }),
    /action/,
  )
  await assert.rejects(
    watch.execute({ action: 'attach' }),
    (error) => error.code === 'INVALID_SESSION_ID',
  )
  await assert.rejects(
    watch.execute({ action: 'detach', sessionId: '   ' }),
    (error) => error.code === 'INVALID_SESSION_ID',
  )
  assert.equal(fake.listeners.size, 0)
})
