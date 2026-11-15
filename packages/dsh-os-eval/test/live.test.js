import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attach,
  evaluateLive,
  readLiveSession,
  snapshotToJsonl,
} from '../src/live.js'
import { liveFailureSnapshot, liveSuccessSnapshot } from './live-snapshots.js'

/**
 * @param {object} snapshot Snapshot returned by the fake service.
 * @param {{ calls?: string[], error?: unknown }} [options] Observation and failure hooks.
 * @returns {{ ctx: object, calls: string[] }} Context with a fake `sessionQuery`.
 */
function createLiveContext(snapshot, options = {}) {
  const calls = options.calls ?? []
  return {
    calls,
    ctx: {
      sessionQuery: {
        async readSession(sessionId) {
          calls.push(sessionId)
          if (options.error !== undefined) throw options.error
          return snapshot
        },
      },
    },
  }
}

test('attach detects the session-query exact-read seam without subscribing', () => {
  const snapshot = liveSuccessSnapshot()
  const { ctx } = createLiveContext(snapshot)
  let subscriptions = 0
  ctx.on = () => {
    subscriptions += 1
  }
  ctx.effect = () => {
    subscriptions += 1
  }

  const capability = attach(ctx)

  assert.equal(capability.available, true)
  assert.equal(capability.service, ctx.sessionQuery)
  assert.equal(typeof capability.readSession, 'function')
  assert.equal(capability.reason, null)
  assert.equal(subscriptions, 0)

  const unavailable = attach({})
  assert.equal(unavailable.available, false)
  assert.equal(unavailable.service, null)
  assert.equal(unavailable.readSession, null)
  assert.match(unavailable.reason, /sessionQuery\.readSession/)
})

test('attach resolves ctx.get without requiring a Cordis injection', () => {
  const service = {
    async readSession() {
      return liveSuccessSnapshot()
    },
  }
  const ctx = {
    get(name) {
      return name === 'sessionQuery' ? service : undefined
    },
  }

  const capability = attach(ctx)
  assert.equal(capability.available, true)
  assert.equal(capability.service, service)
  assert.equal(typeof capability.readSession, 'function')
})

test('readLiveSession calls readSession and parses the returned snapshot', async () => {
  const { ctx, calls } = createLiveContext(liveSuccessSnapshot())

  const session = await readLiveSession(ctx, 'live-success')

  assert.deepEqual(calls, ['live-success'])
  assert.equal(session.id, 'live-success')
  assert.equal(session.turns, 2)
  assert.equal(session.messages.length, 2)
  assert.equal(session.toolCalls.length, 1)
  assert.deepEqual(session.toolCalls[0].args, { path: 'README.md' })
  assert.equal(session.toolCalls[0].result, '# dsh-os-eval live')
  assert.equal(session.toolCalls[0].hasResult, true)
})

test('snapshotToJsonl keeps the header, events, and parser-visible fields', () => {
  const snapshot = liveSuccessSnapshot()
  const text = snapshotToJsonl(snapshot)
  const lines = text.split('\n')

  assert.equal(lines.length, snapshot.events.length + 1)
  assert.equal(JSON.parse(lines[0]).type, 'session')
  assert.equal(JSON.parse(lines[0]).id, 'live-success')
  assert.equal(JSON.parse(lines[1]).type, 'turn/start')
  assert.equal(JSON.parse(lines[3]).surfaceOp, 'append')
  assert.equal(JSON.parse(lines[4]).data.callId, 'call-live')
})

test('readLiveSession surfaces a missing service as SESSION_QUERY_UNAVAILABLE', async () => {
  await assert.rejects(
    readLiveSession({}, 'live-success'),
    (error) => error.name === 'EvalError'
      && error.code === 'SESSION_QUERY_UNAVAILABLE'
      && /sessionQuery/.test(error.message),
  )
})

test('readLiveSession rejects invalid ids before touching the service', async () => {
  const { ctx, calls } = createLiveContext(liveSuccessSnapshot())

  await assert.rejects(
    readLiveSession(ctx, '   '),
    (error) => error.code === 'INVALID_SESSION_ID',
  )
  assert.deepEqual(calls, [])
})

test('readLiveSession wraps a generic read failure as SESSION_QUERY_READ_FAILED', async () => {
  const { ctx } = createLiveContext(undefined, { error: new Error('backend offline') })

  await assert.rejects(
    readLiveSession(ctx, 'live-success'),
    (error) => error.code === 'SESSION_QUERY_READ_FAILED'
      && /backend offline/.test(error.message)
      && /live-success/.test(error.message)
      && error.cause instanceof Error,
  )
})

test('readLiveSession preserves a stable session-query failure code', async () => {
  const failure = Object.assign(new Error('session not found'), {
    code: 'SESSION_QUERY_SESSION_NOT_FOUND',
  })
  const { ctx } = createLiveContext(undefined, { error: failure })

  await assert.rejects(
    readLiveSession(ctx, 'missing'),
    (error) => error.code === 'SESSION_QUERY_SESSION_NOT_FOUND'
      && /session not found/.test(error.message),
  )
})

test('readLiveSession rejects malformed snapshots with INVALID_SESSION_SNAPSHOT', async () => {
  const noEvents = createLiveContext({ session: { id: 'live-success' } })
  await assert.rejects(
    readLiveSession(noEvents.ctx, 'live-success'),
    (error) => error.code === 'INVALID_SESSION_SNAPSHOT' && /events/.test(error.message),
  )

  const noHeader = createLiveContext({ session: {}, events: [] })
  await assert.rejects(
    readLiveSession(noHeader.ctx, 'live-success'),
    (error) => error.code === 'INVALID_SESSION_SNAPSHOT' && /session id/.test(error.message),
  )

  const badEvent = createLiveContext({
    session: { id: 'live-success' },
    events: [{ seq: 1, time: 0, data: {} }],
  })
  await assert.rejects(
    readLiveSession(badEvent.ctx, 'live-success'),
    (error) => error.code === 'INVALID_SESSION_SNAPSHOT' && /event objects/.test(error.message),
  )
})

test('evaluateLive grades a successful live session and exposes its trajectory', async () => {
  const { ctx } = createLiveContext(liveSuccessSnapshot())

  const result = await evaluateLive(ctx, 'live-success', [
    {
      id: 'live-ok',
      name: 'Live success',
      expect: { contains: ['Live session passed.'], maxSteps: 1, maxTokens: 27 },
    },
  ])

  assert.equal(result.source, 'live')
  assert.equal(result.total, 1)
  assert.equal(result.passed, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.steps, 1)
  assert.equal(result.tokens, 27)
  assert.equal(result.output, 'Live session passed.')
  assert.equal(result.trajectory.sessionId, 'live-success')
  assert.equal(result.trajectory.steps, 1)
  assert.equal(result.trajectory.paired, 1)
  assert.equal(result.trajectory.toolErrors, 0)
  assert.deepEqual(result.trajectory.tools, ['read'])
  assert.equal(result.toolTrajectory.length, 1)
  assert.equal(result.toolTrajectory[0].callId, 'call-live')
  assert.equal(result.cases[0].status, 'PASS')
})

test('evaluateLive reports every failed expectation for a failing live session', async () => {
  const { ctx } = createLiveContext(liveFailureSnapshot())

  const result = await evaluateLive(ctx, 'live-failure', [{
    id: 'live-expected-success',
    name: 'Live expected success',
    expect: {
      contains: ['Live session passed.'],
      equals: 'Live session passed.',
      maxSteps: 0,
      maxTokens: 100,
    },
  }])

  assert.equal(result.source, 'live')
  assert.equal(result.failed, 1)
  assert.equal(result.steps, 1)
  assert.equal(result.tokens, 999)
  assert.equal(result.trajectory.toolErrors, 1)
  assert.deepEqual(result.cases[0].reasons, [
    'output does not contain "Live session passed."',
    'output does not equal "Live session passed."',
    'steps 1 exceed maxSteps 0',
    'tokens 999 exceed maxTokens 100',
  ])
})
