import test from 'node:test'
import assert from 'node:assert/strict'
import { createGovernor } from '../src/core.js'
import { attachTokenMeter, tokensOfUsage } from '../src/meter.js'

/** Minimal Cordis-like event bus: `on` returns a disposer, exactly like Cordis. */
function fakeCtx() {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      on(event, handler) {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return () => {
          const index = list.indexOf(handler)
          if (index >= 0) list.splice(index, 1)
          return index >= 0
        }
      },
    },
  }
}

/** Synchronous emit helper. */
function emit(handlers, event, ...args) {
  for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
}

test('books usage.totalTokens from an assistant/message event', () => {
  const governor = createGovernor({ now: 1000 })
  const { ctx, handlers } = fakeCtx()
  const meter = attachTokenMeter(ctx, { governor })
  const { stats } = meter

  emit(handlers, 'session/event', { id: 'session:a' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 99 } },
  })

  assert.equal(governor.status('session:a').used.tokens, 99)
  assert.equal(stats.counters.consumed, 1)
  assert.equal(stats.last.tokens, 99)
  assert.equal(meter.stats.counters.events, 1)
  assert.equal(meter.stats.counters.assistantEvents, 1)
  assert.equal(meter.stats.counters.consumed, 1)
  assert.equal(meter.stats.counters.tokens, 99)
  assert.equal(meter.stats.last.kind, 'consume')
  assert.equal(meter.stats.last.scope, 'session:a')
  assert.equal(meter.stats.last.type, 'assistant/message')
  assert.equal(meter.stats.sessions, 1)
})

test('sums disjoint input/output/cacheRead/cacheWrite when totalTokens is absent', () => {
  const governor = createGovernor({ now: 1000 })
  const { ctx, handlers } = fakeCtx()
  attachTokenMeter(ctx, { governor })

  emit(handlers, 'session/event', { id: 'session:sum' }, {
    type: 'assistant/message',
    data: {
      turn: 2,
      step: 3,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
    },
  })

  assert.equal(governor.status('session:sum').used.tokens, 20)
})

test('assistant/attempt falls back to the last usage chunk in the compact stream', () => {
  const governor = createGovernor({ now: 1000 })
  const { ctx, handlers } = fakeCtx()
  attachTokenMeter(ctx, { governor })

  emit(handlers, 'session/event', { id: 'session:attempt' }, {
    type: 'assistant/attempt',
    data: {
      turn: 1,
      step: 1,
      stream: [
        { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
        { type: 'usage', usage: { inputTokens: 4, outputTokens: 6 } },
      ],
    },
  })

  assert.equal(governor.status('session:attempt').used.tokens, 10)
})

test('a repeated sessionId+turn+step+type is booked once, but another session is separate', () => {
  const governor = createGovernor({ now: 1000 })
  const { ctx, handlers } = fakeCtx()
  const meter = attachTokenMeter(ctx, { governor })
  const event = {
    type: 'assistant/message',
    data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 } },
  }

  emit(handlers, 'session/event', { id: 'session:a' }, event)
  emit(handlers, 'session/event', { id: 'session:a' }, event)
  emit(handlers, 'session/event', { id: 'session:b' }, event)

  assert.equal(governor.status('session:a').used.tokens, 15)
  assert.equal(governor.status('session:b').used.tokens, 15)
  assert.equal(meter.stats.counters.consumed, 2)
  assert.equal(meter.stats.counters.duplicates, 1)
  assert.equal(meter.stats.last.kind, 'consume')
})

test('skips events without usage, without identity, and non-assistant event types', () => {
  const governor = createGovernor({ now: 1000 })
  const { ctx, handlers } = fakeCtx()
  const meter = attachTokenMeter(ctx, { governor })

  // No usage object at all.
  emit(handlers, 'session/event', { id: 'session:skip' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 1 },
  })
  // Usage with no input/output and no total.
  emit(handlers, 'session/event', { id: 'session:skip' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 2, usage: { cacheReadTokens: 4 } },
  })
  // Missing turn is not dedupe-able and must be skipped.
  emit(handlers, 'session/event', { id: 'session:skip' }, {
    type: 'assistant/message',
    data: { step: 3, usage: { inputTokens: 9, outputTokens: 1 } },
  })
  // A non-assistant event with usage is not a model settlement.
  emit(handlers, 'session/event', { id: 'session:skip' }, {
    type: 'tool/result',
    data: { turn: 1, step: 4, usage: { inputTokens: 9, outputTokens: 1 } },
  })

  assert.equal(governor.status('session:skip').used.tokens, 0)
  assert.equal(meter.stats.counters.events, 4)
  assert.equal(meter.stats.counters.assistantEvents, 3)
  assert.equal(meter.stats.counters.consumed, 0)
  assert.equal(meter.stats.counters.skipped, 3)
  assert.equal(meter.stats.last.kind, 'skip')
  assert.equal(meter.stats.last.reason, 'missing turn')
})

test('scopeOf overrides the session id and falls back when it returns no string', () => {
  const governor = createGovernor({ now: 1000 })
  const { ctx, handlers } = fakeCtx()
  const meter = attachTokenMeter(ctx, {
    governor,
    scopeOf: (session) => session.team === undefined ? '' : `team:${session.team}`,
  })
  const usage = { inputTokens: 7, outputTokens: 3 }

  emit(handlers, 'session/event', { id: 'session:a', team: 'alpha' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, usage },
  })
  emit(handlers, 'session/event', { id: 'session:b' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, usage },
  })

  assert.equal(governor.status('team:alpha').used.tokens, 10)
  assert.equal(governor.status('session:b').used.tokens, 10)
  assert.equal(meter.stats.scopeSource, 'scopeOf(session)')
})

test('detach removes the listener and stops further bookings', () => {
  const governor = createGovernor({ now: 1000 })
  const { ctx, handlers } = fakeCtx()
  const meter = attachTokenMeter(ctx, { governor })
  const usage = { inputTokens: 10, outputTokens: 5 }

  emit(handlers, 'session/event', { id: 'session:a' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, usage },
  })
  assert.equal(governor.status('session:a').used.tokens, 15)
  assert.equal(handlers.get('session/event').length, 1)

  meter.detach()
  assert.equal(meter.stats.attached, false)
  assert.equal(handlers.get('session/event').length, 0)

  emit(handlers, 'session/event', { id: 'session:a' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 2, usage },
  })
  assert.equal(governor.status('session:a').used.tokens, 15)
  assert.equal(meter.stats.counters.consumed, 1)
})

test('tokensOfUsage accepts total-only samples and rejects malformed buckets', () => {
  assert.equal(tokensOfUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 100 }), 100)
  assert.equal(tokensOfUsage({ inputTokens: 1, outputTokens: 2 }), 3)
  assert.equal(tokensOfUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 4 }), 7)
  assert.equal(tokensOfUsage({ totalTokens: 0 }), 0)
  assert.equal(tokensOfUsage({ inputTokens: 1 }), null)
  assert.equal(tokensOfUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: -1 }), null)
  assert.equal(tokensOfUsage(undefined), null)
})

test('a governor.consume failure is contained and counted, not thrown at the host', () => {
  const governor = {
    consume() {
      throw new Error('ledger offline')
    },
  }
  const { ctx, handlers } = fakeCtx()
  const meter = attachTokenMeter(ctx, { governor })

  assert.doesNotThrow(() => {
    emit(handlers, 'session/event', { id: 'session:a' }, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 2 } },
    })
  })
  assert.equal(meter.stats.counters.errors, 1)
  assert.equal(meter.stats.counters.consumed, 0)
  assert.equal(meter.stats.lastError, 'ledger offline')
  assert.equal(meter.stats.last.kind, 'error')
})
