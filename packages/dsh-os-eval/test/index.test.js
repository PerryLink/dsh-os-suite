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

test('apply registers exactly eval_run, eval_gate, and eval_report', () => {
  const { tools, ctx } = createContext()
  apply(ctx, {
    cases: [{
      id: 'configured',
      name: 'Configured case',
      input: 'hello',
      expect: { contains: ['hello'] },
    }],
  })

  assert.deepEqual(tools.map((tool) => tool.name), ['eval_run', 'eval_gate', 'eval_report'])
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
