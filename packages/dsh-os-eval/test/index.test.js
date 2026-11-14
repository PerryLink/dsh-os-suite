import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'

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
