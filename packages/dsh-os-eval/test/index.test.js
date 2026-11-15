import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index.js'

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
 * @returns {{ tools: object[], ctx: object }}
 */
function createContext() {
  /** @type {object[]} */
  const tools = []
  return {
    tools,
    ctx: {
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
  assert.equal(runResult.trajectory.sessionId, 'fixture-success')
  assert.equal(runResult.trajectory.steps, 1)
  assert.equal(runResult.comparison.passRate, 1)
  assert.equal(runResult.comparison.tokenRegression, (27 - 40) / 40)

  const gateResult = await byName.get('eval_gate').execute({ tags: ['recorded'] })
  assert.equal(gateResult.verdict, 'PASS')

  const reportResult = await byName.get('eval_report').execute({ tags: ['recorded'] })
  assert.equal(reportResult.total, 1)
  assert.equal(reportResult.passed, 1)
  assert.equal(reportResult.trajectory.sessions, 1)
  assert.equal(reportResult.trajectory.steps, 1)
  assert.equal(reportResult.trajectory.tokens, 27)
  assert.deepEqual(reportResult.trajectory.tools, { read: 1 })
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
  const reportResult = await byName.get('eval_report').execute({})
  assert.equal(reportResult.trajectory.sessions, 0)
  assert.equal(reportResult.cases[0].trajectory, null)
})
