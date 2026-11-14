import test from 'node:test'
import assert from 'node:assert/strict'
import { createEvalStore, EvalError } from '../src/core.js'

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function makeCase(overrides = {}) {
  return {
    id: 'greeting',
    name: 'Greets the user',
    input: 'say hello to the world',
    expect: { contains: ['hello', 'world'] },
    ...overrides,
  }
}

test('runCase passes when every expectation matches', () => {
  const store = createEvalStore()
  store.defineCase(makeCase({ expect: { contains: ['hello', 'world'], maxSteps: 3, maxTokens: 100 } }))

  const run = store.runCase('greeting', () => ({
    output: 'hello world',
    steps: 2,
    tokens: 50,
    latencyMs: 7,
  }))

  assert.deepEqual(run, {
    caseId: 'greeting',
    output: 'hello world',
    steps: 2,
    tokens: 50,
    latencyMs: 7,
    status: 'PASS',
    reasons: [],
  })
  assert.equal(store.gate().verdict, 'PASS')
})

test('runCase fails on missing text and exceeded budgets', () => {
  const store = createEvalStore()
  store.defineCase(makeCase({
    expect: { contains: ['hello', 'absent'], maxSteps: 1, maxTokens: 10 },
  }))

  const run = store.runCase('greeting', () => ({ output: 'hello', steps: 2, tokens: 11 }))

  assert.equal(run.status, 'FAIL')
  assert.equal(run.reasons.length, 3)
  assert.match(run.reasons.join('\n'), /does not contain "absent"/)
  assert.match(run.reasons.join('\n'), /steps 2 exceed maxSteps 1/)
  assert.match(run.reasons.join('\n'), /tokens 11 exceed maxTokens 10/)
})

test('runCase deep-equals structured output', () => {
  const store = createEvalStore()
  store.defineCase(makeCase({
    id: 'structured',
    name: 'Structured output',
    expect: { equals: { ok: true, items: [1, 2] } },
  }))

  const pass = store.runCase('structured', () => ({ output: { ok: true, items: [1, 2] } }))
  assert.equal(pass.status, 'PASS')

  const fail = store.runCase('structured', () => ({ output: { ok: false, items: [1, 2] } }))
  assert.equal(fail.status, 'FAIL')
  assert.match(fail.reasons[0], /does not equal/)
})

test('runCase records a throwing runner as FAIL instead of throwing', () => {
  const store = createEvalStore()
  store.defineCase(makeCase())

  const run = store.runCase('greeting', () => {
    throw new Error('mock runner exploded')
  })

  assert.equal(run.status, 'FAIL')
  assert.equal(run.output, null)
  assert.match(run.reasons[0], /runner threw: mock runner exploded/)
  assert.equal(store.gate().verdict, 'FAIL')
})

test('gate fails when the failed-case ratio exceeds maxFailRatio', () => {
  const store = createEvalStore()
  store.defineCase(makeCase({ id: 'good', name: 'Good' }))
  store.defineCase(makeCase({ id: 'bad', name: 'Bad' }))

  store.runCase('good', () => ({ output: 'hello world' }))
  store.runCase('bad', () => ({ output: 'nothing useful' }))

  const result = store.gate()

  assert.equal(result.verdict, 'FAIL')
  assert.deepEqual(result.failed, ['bad'])
  assert.deepEqual(result.warned, [])
  assert.equal(result.failRatio, 0.5)
  assert.equal(result.evaluated, 2)
  assert.match(result.reasons[0], /failure ratio 50\.0% exceeds maxFailRatio 0\.0%/)
  assert.match(result.reasons.join('\n'), /case "bad" failed/)
})

test('gate tolerates a failure ratio at the configured limit', () => {
  const store = createEvalStore()
  store.defineCase(makeCase({ id: 'good', name: 'Good' }))
  store.defineCase(makeCase({ id: 'bad', name: 'Bad' }))
  store.runCase('good', () => ({ output: 'hello world' }))
  store.runCase('bad', () => ({ output: 'nothing useful' }))

  const result = store.gate({ maxFailRatio: 0.5 })

  assert.equal(result.verdict, 'PASS')
  assert.equal(result.failRatio, 0.5)
  assert.deepEqual(result.failed, ['bad'])
  assert.match(result.reasons[0], /1 failure\(s\) within maxFailRatio 50\.0%/)
})

test('gate warns when token usage regresses more than 20% over baseline', () => {
  const store = createEvalStore()
  store.defineCase(makeCase({ id: 'costly', name: 'Costly' }))
  store.runCase('costly', () => ({ output: 'hello world', tokens: 130 }))

  const comparison = store.compareToBaseline('costly', {
    caseId: 'costly',
    passRate: 1,
    p50Tokens: 100,
  })
  assert.equal(comparison.tokenRegression, 0.3)
  assert.equal(comparison.passRateDelta, 0)

  const result = store.gate()
  assert.equal(result.verdict, 'WARN')
  assert.deepEqual(result.failed, [])
  assert.deepEqual(result.warned, ['costly'])
  assert.equal(result.failRatio, 0)
  assert.match(result.reasons.join('\n'), /token regression 30\.0% exceeds 20\.0%/)
})

test('token growth of exactly 20% is not a warning', () => {
  const store = createEvalStore()
  store.defineCase(makeCase({ id: 'edge', name: 'Edge' }))
  store.runCase('edge', () => ({ output: 'hello world', tokens: 120 }))
  store.compareToBaseline('edge', { caseId: 'edge', passRate: 1, p50Tokens: 100 })

  const result = store.gate({ maxTokenRegression: 0.2 })
  assert.equal(result.verdict, 'PASS')
  assert.deepEqual(result.warned, [])
})

test('baseline can be stored before the first run', () => {
  const store = createEvalStore()
  store.defineCase(makeCase({ id: 'later', name: 'Later' }))

  const before = store.compareToBaseline('later', {
    caseId: 'later',
    passRate: 0.9,
    p50Tokens: 100,
  })
  assert.equal(before.run, null)
  assert.equal(before.tokenRegression, null)

  store.runCase('later', () => ({ output: 'hello world', tokens: 150 }))
  const gate = store.gate()
  assert.equal(gate.verdict, 'WARN')
  assert.deepEqual(gate.warned, ['later'])
})

test('tags filtering selects an AND subset for gate and report', () => {
  const store = createEvalStore()
  store.defineCase(makeCase({ id: 'smoke', name: 'Smoke', tags: ['smoke', 'fast'] }))
  store.defineCase(makeCase({ id: 'nightly', name: 'Nightly', tags: ['regression'] }))

  store.runCase('smoke', () => ({ output: 'hello world', tokens: 5 }))
  store.runCase('nightly', () => ({ output: 'broken' }))

  assert.equal(store.gate().verdict, 'FAIL')

  const filtered = store.gate({ tags: ['smoke'] })
  assert.equal(filtered.verdict, 'PASS')
  assert.equal(filtered.evaluated, 1)

  const andFiltered = store.gate({ tags: ['smoke', 'fast'] })
  assert.equal(andFiltered.verdict, 'PASS')

  const noMatch = store.gate({ tags: ['smoke', 'nightly'] })
  assert.equal(noMatch.verdict, 'FAIL')
  assert.match(noMatch.reasons[0], /no cases matched/)

  const report = store.report({ tags: ['smoke'] })
  assert.equal(report.total, 1)
  assert.equal(report.cases[0].caseId, 'smoke')
})

test('duplicate case ids are rejected', () => {
  const store = createEvalStore()
  store.defineCase(makeCase())

  assert.throws(
    () => store.defineCase(makeCase({ name: 'Duplicate' })),
    (error) => error instanceof EvalError
      && error.code === 'DUPLICATE_CASE_ID'
      && /duplicate case id: "greeting"/.test(error.message),
  )
  assert.equal(store.report().total, 1)
})

test('report summarises latest runs without raw output', () => {
  const store = createEvalStore()
  store.defineCase(makeCase({ id: 'checked', name: 'Checked', tags: ['smoke'] }))
  store.defineCase(makeCase({ id: 'never', name: 'Never run' }))

  store.runCase('checked', () => ({ output: 'hello world', steps: 2, tokens: 8, latencyMs: 4 }))

  const report = store.report()
  assert.equal(report.total, 2)
  assert.equal(report.runCount, 1)
  assert.equal(report.passed, 1)
  assert.equal(report.failed, 0)
  assert.equal(report.notRun, 1)
  assert.equal(report.passRate, 1)
  assert.equal(report.tokens, 8)
  assert.equal(report.steps, 2)
  assert.equal(report.cases[0].status, 'PASS')
  assert.equal(report.cases[1].status, 'NOT_RUN')
  assert.equal(Object.hasOwn(report.cases[0], 'output'), false)
})

test('gate fails without evidence when no selected case has run', () => {
  const store = createEvalStore()
  store.defineCase(makeCase())

  const result = store.gate()
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.evaluated, 0)
  assert.match(result.reasons[0], /no eval runs available/)
})

test('unknown cases and invalid runners are rejected', () => {
  const store = createEvalStore()

  assert.throws(
    () => store.runCase('missing', () => ({ output: 'x' })),
    (error) => error instanceof EvalError && error.code === 'UNKNOWN_CASE',
  )

  store.defineCase(makeCase())
  assert.throws(
    () => store.runCase('greeting', null),
    (error) => error instanceof EvalError && error.code === 'INVALID_RUNNER',
  )
})
