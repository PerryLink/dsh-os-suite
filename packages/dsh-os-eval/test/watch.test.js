import test from 'node:test'
import assert from 'node:assert/strict'
import { createWatcher } from '../src/watch.js'

/**
 * Minimal event emitter that mimics the Cordis `on` seam used by DSH's
 * `session/event` feed.
 *
 * @returns {{
 *   ctx: { on: (eventName: string, listener: Function) => () => void },
 *   emit: (sessionId: string|null, event: unknown) => void,
 *   listeners: Set<Function>,
 *   stats: { subscriptions: number },
 * }} Fake context plus an emitter for tests.
 */
function createEventContext() {
  /** @type {Set<Function>} */
  const listeners = new Set()
  /** @type {{ subscriptions: number }} */
  const stats = { subscriptions: 0 }

  return {
    listeners,
    stats,
    ctx: {
      on(eventName, listener) {
        assert.equal(eventName, 'session/event')
        stats.subscriptions += 1
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    emit(sessionId, event) {
      const session = sessionId === null ? null : { id: sessionId }
      for (const listener of [...listeners]) listener(session, event)
    },
  }
}

/**
 * @param {string} type Event type.
 * @param {object} data Event payload.
 * @param {number} seq Sequence number.
 * @returns {object} Session event.
 */
function sessionEvent(type, data, seq) {
  return { type, seq, time: 1000 + seq, data }
}

test('createWatcher requires a non-empty session id', () => {
  assert.throws(
    () => createWatcher({}),
    (error) => error.code === 'INVALID_SESSION_ID',
  )
  assert.throws(
    () => createWatcher({ ctx: {}, sessionId: '   ' }),
    (error) => error.code === 'INVALID_SESSION_ID',
  )
})

test('attach retains only events from the named session', () => {
  const fake = createEventContext()
  const watcher = createWatcher({ ctx: fake.ctx, sessionId: 'session-a' })

  assert.deepEqual(watcher.attach(), { sessionId: 'session-a', attached: true, events: 0 })
  assert.equal(fake.listeners.size, 1)

  fake.emit('session-a', sessionEvent('turn/start', { turn: 1 }, 1))
  fake.emit('session-b', sessionEvent('turn/start', { turn: 9 }, 2))
  fake.emit(null, sessionEvent('turn/start', { turn: 10 }, 3))
  fake.emit('session-a', sessionEvent('future/event', { hello: 'world' }, 4))

  const snapshot = watcher.snapshot()
  assert.deepEqual(snapshot.map((event) => event.seq), [1, 4])

  // snapshot() is a detached copy: callers cannot grow the watcher's history.
  snapshot.push(sessionEvent('turn/end', {}, 5))
  assert.equal(watcher.snapshot().length, 2)
})

test('trajectory pairs calls and results by call id and skips unknown events', () => {
  const fake = createEventContext()
  const watcher = createWatcher({ ctx: fake.ctx, sessionId: 'session-a' })
  watcher.attach()

  fake.emit('session-a', sessionEvent('turn/start', { turn: 1 }, 1))
  fake.emit('session-a', sessionEvent('tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-1',
    name: 'read',
    arguments: '{"path":"README.md"}',
  }, 2))
  fake.emit('session-a', sessionEvent('future/event', { nested: { payload: true } }, 3))
  fake.emit('session-a', sessionEvent('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: '# dsh-os-eval' }],
      isError: false,
    },
  }, 4))
  fake.emit('session-a', sessionEvent('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    usage: { totalTokens: 5 },
  }, 5))

  const steps = watcher.trajectory()
  assert.equal(steps.length, 1)
  assert.equal(steps[0].callId, 'call-1')
  assert.equal(steps[0].tool, 'read')
  assert.deepEqual(steps[0].args, { path: 'README.md' })
  assert.equal(steps[0].result, '# dsh-os-eval')
  assert.equal(steps[0].hasResult, true)
  assert.equal(steps[0].isError, false)
  assert.equal(watcher.snapshot().length, 5)
})

test('trajectory pairs a result that arrives before its call', () => {
  const fake = createEventContext()
  const watcher = createWatcher({ ctx: fake.ctx, sessionId: 'session-a' })
  watcher.attach()

  fake.emit('session-a', sessionEvent('tool/result', {
    message: {
      role: 'tool',
      toolCallId: 'call-early',
      content: [{ type: 'text', text: 'early' }],
      isError: false,
    },
  }, 1))
  fake.emit('session-a', sessionEvent('tool/call', {
    callId: 'call-early',
    name: 'read',
    arguments: '{}',
  }, 2))

  const steps = watcher.trajectory()
  assert.equal(steps.length, 1)
  assert.equal(steps[0].callId, 'call-early')
  assert.equal(steps[0].result, 'early')
  assert.equal(steps[0].hasResult, true)
})

test('attach is idempotent and does not duplicate the listener', () => {
  const fake = createEventContext()
  const watcher = createWatcher({ ctx: fake.ctx, sessionId: 'session-a' })

  watcher.attach()
  watcher.attach()

  assert.equal(fake.stats.subscriptions, 1)
  assert.equal(fake.listeners.size, 1)

  fake.emit('session-a', sessionEvent('turn/start', { turn: 1 }, 1))
  assert.equal(watcher.snapshot().length, 1)
})

test('detach stops new events and keeps the retained snapshot', () => {
  const fake = createEventContext()
  const watcher = createWatcher({ ctx: fake.ctx, sessionId: 'session-a' })
  watcher.attach()
  fake.emit('session-a', sessionEvent('turn/start', { turn: 1 }, 1))

  assert.deepEqual(watcher.detach(), { sessionId: 'session-a', attached: false, events: 1 })
  assert.equal(fake.listeners.size, 0)

  fake.emit('session-a', sessionEvent('tool/call', {
    callId: 'call-after-detach',
    name: 'read',
    arguments: '{}',
  }, 2))
  assert.equal(watcher.snapshot().length, 1)
  assert.deepEqual(watcher.trajectory(), [])

  // Detach is idempotent; reattach keeps the previous history.
  watcher.detach()
  watcher.attach()
  assert.equal(fake.listeners.size, 1)
  fake.emit('session-a', sessionEvent('turn/end', { turn: 1 }, 3))
  assert.equal(watcher.snapshot().length, 2)
})

test('attach reports a missing or failing session/event subscription', () => {
  const noOn = createWatcher({ ctx: {}, sessionId: 'session-a' })
  assert.throws(
    () => noOn.attach(),
    (error) => error.code === 'SESSION_EVENTS_UNAVAILABLE' && /session\/event/.test(error.message),
  )
  assert.equal(noOn.snapshot().length, 0)

  const failure = new Error('event bus unavailable')
  const throwing = createWatcher({
    ctx: {
      on() {
        throw failure
      },
    },
    sessionId: 'session-a',
  })
  assert.throws(
    () => throwing.attach(),
    (error) => error.code === 'SESSION_EVENTS_SUBSCRIBE_FAILED'
      && error.cause === failure
      && /event bus unavailable/.test(error.message),
  )
})

test('trajectory tolerates a non-serializable event retained by snapshot', () => {
  const fake = createEventContext()
  const watcher = createWatcher({ ctx: fake.ctx, sessionId: 'session-a' })
  watcher.attach()

  fake.emit('session-a', sessionEvent('future/event', { big: 1n }, 1))

  assert.equal(watcher.snapshot().length, 1)
  assert.deepEqual(watcher.trajectory(), [])
})
