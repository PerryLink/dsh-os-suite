import test from 'node:test'
import assert from 'node:assert/strict'
import { createGovernor, DIMENSIONS, DEFAULT_SOFT_RATIO } from '../src/core.js'

const LIMITS = { tokens: 100, jobs: 2, diskMb: 10 }

/**
 * Governor with a deterministic clock. The clock starts at epoch 1000 ms.
 * @param {object} [options]
 */
function harness(options = {}) {
  let now = 1_000
  const governor = createGovernor({ now: () => now, limits: LIMITS, ...options })
  return {
    governor,
    at: () => now,
    advance(ms) {
      now += ms
      return now
    },
  }
}

test('admit allows a projection inside the soft threshold and does not book it', () => {
  const { governor } = harness()
  const decision = governor.admit({ scope: 'agent:a', tokens: 40, jobs: 1 })

  assert.equal(decision.allowed, true)
  assert.equal(decision.level, 'ok')
  assert.equal(decision.reason, 'ok')
  assert.equal(decision.degrade, false)
  assert.deepEqual(decision.remaining, { tokens: 60, jobs: 1, diskMb: 10 })
  assert.deepEqual(decision.used, { tokens: 0, jobs: 0, diskMb: 0 })
  assert.deepEqual(decision.projected, { tokens: 40, jobs: 1, diskMb: 0 })

  // Admission is a projection, so the ledger is untouched.
  const status = governor.status('agent:a')
  assert.deepEqual(status.used, { tokens: 0, jobs: 0, diskMb: 0 })
  assert.equal(status.level, 'ok')
})

test('admit flags soft overage as allowed but degraded', () => {
  const { governor } = harness()
  const decision = governor.admit({ scope: 'agent:a', tokens: 90 })

  assert.equal(decision.allowed, true)
  assert.equal(decision.level, 'soft')
  assert.equal(decision.reason, 'soft-limit')
  assert.equal(decision.degrade, true)
  assert.deepEqual(decision.degraded, ['tokens'])
  assert.deepEqual(decision.exceeded, [])
  assert.equal(decision.remaining.tokens, 10)
  assert.deepEqual(decision.overBy, { tokens: 0, jobs: 0, diskMb: 0 })
})

test('admit rejects a projection beyond a hard limit', () => {
  const { governor } = harness()
  const decision = governor.admit({ scope: 'agent:a', tokens: 101 })

  assert.equal(decision.allowed, false)
  assert.equal(decision.level, 'hard')
  assert.equal(decision.reason, 'hard-limit')
  assert.equal(decision.degrade, false)
  assert.deepEqual(decision.exceeded, ['tokens'])
  assert.equal(decision.remaining.tokens, 0)
  assert.equal(decision.overBy.tokens, 1)
})

test('spending exactly up to a hard limit is allowed', () => {
  const { governor } = harness()
  const decision = governor.admit({ scope: 'agent:a', tokens: 100 })

  assert.equal(decision.allowed, true)
  assert.equal(decision.level, 'soft') // no soft headroom left, but not over hard
  assert.equal(decision.reason, 'soft-limit')
  assert.equal(decision.remaining.tokens, 0)
  assert.equal(decision.overBy.tokens, 0)
})

test('consume accumulates real usage, reports overage and stays non-negative', () => {
  const { governor } = harness()

  const first = governor.consume({ scope: 'agent:a', tokens: 60 })
  assert.equal(first.allowed, true)
  assert.equal(first.level, 'ok')
  assert.deepEqual(first.used, { tokens: 60, jobs: 0, diskMb: 0 })
  assert.equal(first.remaining.tokens, 40)

  const second = governor.consume({ scope: 'agent:a', tokens: 50 })
  assert.equal(second.allowed, false)
  assert.equal(second.level, 'hard')
  assert.equal(second.reason, 'hard-limit')
  assert.equal(second.used.tokens, 110)
  assert.equal(second.overBy.tokens, 10)
  assert.equal(second.remaining.tokens, 0)
  assert.deepEqual(second.exceeded, ['tokens'])

  const status = governor.status('agent:a')
  assert.equal(status.used.tokens, 110)
  assert.equal(status.level, 'hard')
  assert.equal(status.allowed, false)
})

test('consume at exactly the hard limit is allowed and marks soft', () => {
  const { governor } = harness()
  const decision = governor.consume({ scope: 'agent:a', jobs: 2 })

  assert.equal(decision.allowed, true)
  assert.equal(decision.level, 'soft')
  assert.equal(decision.degrade, true)
  assert.deepEqual(decision.used, { tokens: 0, jobs: 2, diskMb: 0 })
  assert.equal(decision.overBy.jobs, 0)
  assert.equal(decision.remaining.jobs, 0)
})

test('negative and non-finite amounts never reduce usage', () => {
  const { governor } = harness()
  governor.consume({ scope: 'agent:a', tokens: 70, jobs: 1 })

  const decision = governor.consume({
    scope: 'agent:a',
    tokens: -30,
    jobs: Number.NaN,
    diskMb: Number.POSITIVE_INFINITY,
  })

  assert.deepEqual(decision.request, { tokens: 0, jobs: 0, diskMb: 0 })
  assert.deepEqual(decision.used, { tokens: 70, jobs: 1, diskMb: 0 })
  assert.equal(governor.status('agent:a').used.tokens, 70)
})

test('scopes are isolated ledgers', () => {
  const { governor } = harness()
  governor.setLimits('alpha', { tokens: 50 })
  governor.consume({ scope: 'alpha', tokens: 40 })

  const alpha = governor.status('alpha')
  const beta = governor.status('beta')

  assert.equal(alpha.used.tokens, 40)
  assert.equal(alpha.limits.tokens, 50)
  assert.equal(beta.used.tokens, 0)
  assert.equal(beta.limits.tokens, 100)
  assert.equal(governor.admit({ scope: 'beta', tokens: 90 }).level, 'soft')
  assert.equal(governor.status('alpha').used.tokens, 40)
})

test('resetWindow zeroes usage and restarts the window', () => {
  const { governor, advance } = harness()
  governor.consume({ scope: 'agent:a', tokens: 90, jobs: 1 })
  advance(5_000)

  const reset = governor.resetWindow('agent:a')

  assert.equal(reset.reset, true)
  assert.equal(reset.previousUsed.tokens, 90)
  assert.deepEqual(reset.used, { tokens: 0, jobs: 0, diskMb: 0 })
  assert.equal(reset.remaining.tokens, 100)
  assert.equal(reset.level, 'ok')
  assert.equal(reset.windowStartedAt, 6_000)
  assert.equal(reset.windowAgeMs, 0)

  // Other scopes are not touched.
  governor.consume({ scope: 'agent:b', tokens: 10 })
  governor.resetWindow('agent:a')
  assert.equal(governor.status('agent:b').used.tokens, 10)
})

test('resetWindow keeps the window start at the injected clock', () => {
  const { governor, at, advance } = harness()
  advance(2_500)
  const before = at()
  const reset = governor.resetWindow('agent:a')
  assert.equal(before, 3_500)
  assert.equal(reset.windowStartedAt, 3_500)
  assert.equal(reset.windowStartedAtIso, '1970-01-01T00:00:03.500Z')
  assert.equal(reset.previousWindowStartedAt, 3_500) // scope was created by this reset
  assert.deepEqual(governor.status('agent:a').used, { tokens: 0, jobs: 0, diskMb: 0 })
})

test('automatic windows roll lazily on access', () => {
  const { governor, advance } = harness({ windowMs: 1_000 })
  governor.consume({ scope: 'agent:a', tokens: 90 })

  advance(999)
  assert.equal(governor.status('agent:a').used.tokens, 90)

  advance(1) // now at start + 1000 ms
  const rolled = governor.status('agent:a')
  assert.equal(rolled.used.tokens, 0)
  assert.equal(rolled.windowStartedAt, 2_000)
  assert.equal(governor.status('agent:a').level, 'ok')
})

test('setLimits merges partial limits, accepts null, and can tighten below usage', () => {
  const { governor } = harness()
  governor.consume({ scope: 'agent:a', tokens: 20 })

  const tightened = governor.setLimits('agent:a', { tokens: 10 })
  assert.equal(tightened.limits.tokens, 10)
  assert.equal(tightened.limits.jobs, 2) // untouched
  assert.deepEqual(tightened.changed, ['tokens'])
  assert.equal(tightened.level, 'hard')
  assert.equal(tightened.overBy.tokens, 10)

  const unlimited = governor.setLimits('agent:a', { tokens: null })
  assert.equal(unlimited.limits.tokens, Number.POSITIVE_INFINITY)
  assert.equal(unlimited.remaining.tokens, Number.POSITIVE_INFINITY)
  assert.equal(unlimited.level, 'ok')
  assert.deepEqual(unlimited.changed, ['tokens'])
})

test('status snapshots are detached from the ledger', () => {
  const { governor } = harness()
  governor.consume({ scope: 'agent:a', tokens: 85 })

  const first = governor.status('agent:a')
  first.used.tokens = 9_999
  first.limits.tokens = 1
  first.remaining.tokens = 0
  first.exceeded.push('jobs')

  const second = governor.status('agent:a')
  assert.equal(second.used.tokens, 85)
  assert.equal(second.limits.tokens, 100)
  assert.equal(second.remaining.tokens, 15)
  assert.deepEqual(second.exceeded, [])
})

test('list reports known scopes sorted by id without creating new ones', () => {
  const { governor } = harness()
  assert.deepEqual(governor.list(), [])

  governor.setLimits('zulu', {})
  governor.setLimits('alpha', {})

  assert.deepEqual(governor.list().map((entry) => entry.scope), ['alpha', 'zulu'])
  assert.equal(governor.list().length, 2)
})

test('new scopes get default limits, a fresh window and ok status', () => {
  const { governor, at } = harness()
  const status = governor.status('brand-new')

  assert.deepEqual(status.limits, LIMITS)
  assert.deepEqual(status.used, { tokens: 0, jobs: 0, diskMb: 0 })
  assert.deepEqual(status.remaining, LIMITS)
  assert.equal(status.windowStartedAt, at())
  assert.equal(status.windowStartedAtIso, '1970-01-01T00:00:01.000Z')
  assert.equal(status.softRatio, DEFAULT_SOFT_RATIO)
})

test('seed scopes and a custom softRatio are honored', () => {
  const governor = createGovernor({
    now: () => 5_000,
    limits: LIMITS,
    softRatio: 0.5,
    scopes: [{ id: 'seed', limits: { tokens: 10 }, used: { tokens: 6 } }],
  })

  const status = governor.status('seed')
  assert.equal(status.limits.tokens, 10)
  assert.equal(status.limits.jobs, 2)
  assert.equal(status.used.tokens, 6)
  assert.equal(status.softRatio, 0.5)
  assert.equal(status.level, 'soft') // 6 > 0.5 * 10
  assert.equal(governor.admit({ scope: 'seed', tokens: 4 }).level, 'soft')
  assert.equal(governor.admit({ scope: 'seed', tokens: 4, jobs: 3 }).level, 'hard')
})

test('invalid configuration and scope ids fail loudly', () => {
  assert.throws(() => createGovernor({ softRatio: 0 }), RangeError)
  assert.throws(() => createGovernor({ softRatio: 1.5 }), RangeError)
  assert.throws(() => createGovernor({ windowMs: -1 }), RangeError)

  const badClock = createGovernor({ now: () => 'not-a-date' })
  assert.throws(() => badClock.status('s'), TypeError)
  assert.throws(() => createGovernor({ limits: LIMITS }).status(''), TypeError)
})

test('status does not create an unknown scope', () => {
  const { governor } = harness()
  const snapshot = governor.status('agent:ghost')

  assert.equal(snapshot.scope, 'agent:ghost')
  assert.equal(snapshot.used.tokens, 0)
  assert.equal(governor.list().length, 0)
})

test('all three dimensions are enforced independently', () => {
  const { governor } = harness()
  const decision = governor.admit({ scope: 'agent:a', tokens: 101, jobs: 3, diskMb: 11 })

  assert.equal(decision.allowed, false)
  assert.equal(decision.level, 'hard')
  assert.deepEqual(decision.exceeded.sort(), [...DIMENSIONS].sort())
  assert.deepEqual(decision.overBy, { tokens: 1, jobs: 1, diskMb: 1 })
  assert.deepEqual(decision.remaining, { tokens: 0, jobs: 0, diskMb: 0 })
})
