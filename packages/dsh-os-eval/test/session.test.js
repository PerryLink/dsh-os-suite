import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  evaluate,
  parseSessionJsonl,
  readSessionFile,
  replay,
  summarizeSession,
  summarizeTrajectory,
  trajectoryOf,
} from '../src/session.js'

/**
 * @param {string} name Fixture filename.
 * @returns {string} Absolute path to the fixture.
 */
function fixturePath(name) {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
}

/**
 * @param {string} name Fixture filename.
 * @returns {string} Fixture contents.
 */
function fixtureText(name) {
  return readFileSync(fixturePath(name), 'utf8')
}

test('parseSessionJsonl reads a recorded success session and pairs its tool call', () => {
  const session = parseSessionJsonl(fixtureText('session-success.jsonl'))

  assert.equal(session.id, 'fixture-success')
  assert.equal(session.turns, 2)
  assert.equal(session.messages.length, 2)
  assert.equal(session.messages[0].text, '')
  assert.equal(session.messages[1].text, 'Read the README. All checks passed.')
  assert.equal(session.messages[0].tokens, 15)
  assert.equal(session.messages[1].tokens, 12)

  assert.equal(session.toolCalls.length, 1)
  assert.deepEqual(session.toolCalls[0], {
    callId: 'call-1',
    tool: 'read',
    args: { path: 'README.md' },
    turn: 1,
    step: 1,
    result: '# dsh-os-eval',
    hasResult: true,
    isError: false,
    time: 1003,
    resultTime: 1004,
  })
})

test('parseSessionJsonl tolerates malformed lines, unknown events, and unknown fields', () => {
  const session = parseSessionJsonl(fixtureText('session-failure.jsonl'))

  assert.equal(session.id, 'fixture-failure')
  assert.equal(session.turns, 2)
  assert.equal(session.messages.length, 2)
  assert.equal(session.messages[1].tokens, 999)
  assert.equal(session.toolCalls.length, 1)
  assert.equal(session.toolCalls[0].isError, true)
  assert.equal(session.toolCalls[0].result, 'ENOENT: no such file or directory')
})

test('parseSessionJsonl accepts kind tags and flat event payloads', () => {
  const text = [
    '{"type":"session","id":"kind-session","version":4}',
    '{"kind":"turn/start","turn":1}',
    '{"kind":"tool/call","turn":1,"step":1,"callId":"kind-call","name":"bash","arguments":"{\\"command\\":\\"echo ok\\"}"}',
    '{"kind":"tool/result","turn":1,"step":1,"message":{"toolCallId":"kind-call","content":[{"type":"text","text":"ok"}],"isError":false}}',
    '{"kind":"assistant/message","turn":1,"message":{"content":"flat assistant text"},"usage":{"inputTokens":2,"outputTokens":1}}',
  ].join('\n')

  const session = parseSessionJsonl(text)

  assert.equal(session.id, 'kind-session')
  assert.equal(session.turns, 1)
  assert.deepEqual(session.toolCalls[0].args, { command: 'echo ok' })
  assert.equal(session.toolCalls[0].result, 'ok')
  assert.equal(session.messages[0].text, 'flat assistant text')
  assert.equal(session.messages[0].tokens, 3)
})

test('parseSessionJsonl returns an empty session for junk input', () => {
  const session = parseSessionJsonl('\nnot json\n[1,2,3]\n{"unrelated":true}\n')

  assert.deepEqual(session, { id: null, turns: 0, toolCalls: [], messages: [] })
  assert.throws(
    () => parseSessionJsonl(null),
    (error) => error.code === 'INVALID_SESSION',
  )
})

test('trajectoryOf pairs results that arrive before their call and keeps unanswered calls', () => {
  const session = parseSessionJsonl([
    '{"type":"session","id":"late-result"}',
    '{"type":"tool/result","data":{"message":{"toolCallId":"late","content":[{"type":"text","text":"LATE"}],"isError":false}}}',
    '{"type":"tool/call","data":{"callId":"late","name":"bash","arguments":"{\\"command\\":\\"echo late\\"}"}}',
    '{"type":"tool/call","data":{"callId":"unanswered","name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}}',
  ].join('\n'))

  const trajectory = trajectoryOf(session)

  assert.equal(trajectory.length, 2)
  assert.deepEqual(trajectory[0].args, { command: 'echo late' })
  assert.equal(trajectory[0].result, 'LATE')
  assert.equal(trajectory[0].hasResult, true)
  assert.equal(trajectory[1].result, null)
  assert.equal(trajectory[1].hasResult, false)
})

test('replay calls the runner with tool, args, and result only', () => {
  const session = parseSessionJsonl(fixtureText('session-success.jsonl'))
  /** @type {object[]} */
  const seen = []

  const replayed = replay(session, {
    runner(step) {
      seen.push(step)
      return { score: step.tool === 'read' ? 1 : 0 }
    },
  })

  assert.deepEqual(seen, [{ tool: 'read', args: { path: 'README.md' }, result: '# dsh-os-eval' }])
  assert.deepEqual(replayed.results, [{ score: 1 }])
  assert.equal(replayed.output, 'Read the README. All checks passed.')
  assert.equal(replayed.steps, 1)
  assert.equal(replayed.tokens, 27)
  assert.equal(replayed.trajectory[0].callId, 'call-1')
})

test('replay without a runner collects recorded results', () => {
  const session = parseSessionJsonl(fixtureText('session-success.jsonl'))
  const replayed = replay(session)
  assert.deepEqual(replayed.results, ['# dsh-os-eval'])
})

test('replay rejects asynchronous runners', () => {
  const session = parseSessionJsonl(fixtureText('session-success.jsonl'))
  assert.throws(
    () => replay(session, { runner: async () => 1 }),
    (error) => error.code === 'ASYNC_RUNNER_UNSUPPORTED',
  )
})

test('summaries expose run-shaped metrics without raw tool payloads', () => {
  const session = parseSessionJsonl(fixtureText('session-success.jsonl'))
  const summary = summarizeSession(session)
  const trajectory = summarizeTrajectory(session)

  assert.equal(summary.sessionId, 'fixture-success')
  assert.equal(summary.turns, 2)
  assert.equal(summary.messages, 2)
  assert.equal(summary.steps, 1)
  assert.equal(summary.tokens, 27)
  assert.equal(summary.output, 'Read the README. All checks passed.')
  assert.deepEqual(trajectory.tools, ['read'])
  assert.equal(trajectory.paired, 1)
  assert.equal(trajectory.toolErrors, 0)
  assert.equal(Object.hasOwn(trajectory, 'args'), false)
})

test('evaluate passes cases against the recorded final output and budgets', () => {
  const session = parseSessionJsonl(fixtureText('session-success.jsonl'))
  const result = evaluate(session, [
    {
      id: 'final-output',
      name: 'Final output',
      expect: {
        contains: ['All checks passed'],
        equals: 'Read the README. All checks passed.',
        maxSteps: 1,
        maxTokens: 27,
      },
    },
    {
      id: 'budget-only',
      name: 'Budget only',
      expect: { maxSteps: 2, maxTokens: 100 },
    },
  ])

  assert.equal(result.total, 2)
  assert.equal(result.passed, 2)
  assert.equal(result.failed, 0)
  assert.equal(result.steps, 1)
  assert.equal(result.tokens, 27)
  assert.equal(result.cases[0].status, 'PASS')
  assert.deepEqual(result.cases[0].reasons, [])
  assert.equal(result.trajectory.sessionId, 'fixture-success')
})

test('evaluate reports every failed expectation for a recorded failure', () => {
  const session = parseSessionJsonl(fixtureText('session-failure.jsonl'))
  const result = evaluate(session, [{
    id: 'expected-success',
    name: 'Expected success',
    expect: {
      contains: ['All checks passed'],
      equals: 'Read the README. All checks passed.',
      maxSteps: 0,
      maxTokens: 100,
    },
  }])

  assert.equal(result.failed, 1)
  assert.equal(result.cases[0].status, 'FAIL')
  assert.deepEqual(result.cases[0].reasons, [
    'output does not contain "All checks passed"',
    'output does not equal "Read the README. All checks passed."',
    'steps 1 exceed maxSteps 0',
    'tokens 999 exceed maxTokens 100',
  ])
  assert.equal(result.trajectory.toolErrors, 1)
})

test('evaluate rejects a non-array case list', () => {
  const session = parseSessionJsonl(fixtureText('session-success.jsonl'))
  assert.throws(
    () => evaluate(session, 'not-a-list'),
    (error) => error.code === 'INVALID_CASES',
  )
})

test('readSessionFile reads one explicit file and surfaces fs errors', () => {
  const session = readSessionFile(fixturePath('session-success.jsonl'))
  assert.equal(session.id, 'fixture-success')

  assert.throws(
    () => readSessionFile(fixturePath('missing.jsonl')),
    (error) => error.code === 'SESSION_READ_FAILED',
  )
  assert.throws(
    () => readSessionFile(''),
    (error) => error.code === 'INVALID_SESSION_FILE',
  )
})
