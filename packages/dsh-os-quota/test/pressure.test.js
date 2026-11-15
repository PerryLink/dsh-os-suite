import test from 'node:test'
import assert from 'node:assert/strict'
import { createPressureGuard } from '../src/pressure.js'

/**
 * Minimal fake context for the token-meter and jobs seams. Every interesting
 * call is recorded so tests can assert the exact caller/reason contract.
 */
function fakeContext(options = {}) {
  const calls = { pressure: [], list: [], kill: [] }
  const ctx = {}
  if (options.meter !== false) {
    ctx.tokenMeter = {
      contextPressure(session) {
        calls.pressure.push(session)
        if (options.meterError !== undefined) throw options.meterError
        return options.projection ?? (options.tokens === undefined ? {} : { pressureTokens: options.tokens })
      },
    }
  }
  if (options.jobs !== false) {
    ctx.jobs = {
      list(caller) {
        calls.list.push(caller)
        if (options.jobsError !== undefined) throw options.jobsError
        return options.jobs ?? []
      },
    }
    if (options.kill !== false) {
      ctx.jobs.kill = (id, caller, reason) => {
        calls.kill.push({ id, caller, reason })
        if (options.killError !== undefined) throw options.killError
        return options.killResult ?? 'requested'
      }
    }
  }
  return { ctx, calls }
}

const SESSION = Object.freeze({ id: 'session:test' })

test('allows pressure at or below maxPressure, inclusive, and does not touch jobs', () => {
  const { ctx, calls } = fakeContext({
    tokens: 100,
    jobs: [{ id: 'bash-running', status: 'running' }],
  })
  const guard = createPressureGuard({ ctx, maxPressure: 100, killJobs: true })

  assert.deepEqual(guard.check({ session: SESSION }), { allow: true })
  assert.equal(calls.list.length, 0)
  assert.equal(calls.kill.length, 0)
  assert.deepEqual(calls.pressure, [SESSION])

  const status = guard.status()
  assert.equal(status.pressureTokens, 100)
  assert.equal(status.counters.checks, 1)
  assert.equal(status.counters.allowed, 1)
  assert.equal(status.counters.denied, 0)
  assert.equal(status.last.kind, 'allow')
})

test('denies pressure above maxPressure with the documented decision', () => {
  const { ctx } = fakeContext({ tokens: 101 })
  const guard = createPressureGuard({ ctx, maxPressure: 100 })

  assert.deepEqual(guard.check({ session: SESSION }), {
    kind: 'deny',
    allow: false,
    reason: 'pressure',
  })
  const status = guard.status()
  assert.equal(status.counters.denied, 1)
  assert.equal(status.pressureTokens, 101)
  assert.equal(status.last.kind, 'deny')
  assert.equal(status.last.reason, 'pressure')
})

test('a missing tokenMeter service fails open without throwing', () => {
  const guard = createPressureGuard({ ctx: {}, maxPressure: 10 })

  assert.deepEqual(guard.check({ session: SESSION }), { allow: true, reason: 'unavailable' })
  assert.equal(guard.available, false)
  const status = guard.status()
  assert.equal(status.available, false)
  assert.equal(status.counters.unavailable, 1)
  assert.equal(status.counters.errors, 0)
  assert.equal(status.last.reason, 'unavailable')
})

test('a throwing contextPressure fails open and is counted', () => {
  const { ctx } = fakeContext({ meterError: new Error('meter exploded') })
  const guard = createPressureGuard({ ctx, maxPressure: 10 })

  assert.deepEqual(guard.check({ session: SESSION }), { allow: true, reason: 'unavailable' })
  const status = guard.status()
  assert.equal(status.counters.unavailable, 1)
  assert.equal(status.counters.errors, 1)
  assert.match(status.lastError, /meter exploded/)
})

test('a projection without pressureTokens is treated as no pressure', () => {
  const { ctx } = fakeContext({ projection: {} })
  const guard = createPressureGuard({ ctx, maxPressure: 0 })

  assert.deepEqual(guard.check({ session: SESSION }), { allow: true })
  assert.equal(guard.status().pressureTokens, null)
  assert.equal(guard.status().last.reason, 'no-pressure')
})

test('a missing session fails open and never calls the meter', () => {
  const { ctx, calls } = fakeContext({ tokens: 999 })
  const guard = createPressureGuard({ ctx, maxPressure: 10 })

  assert.deepEqual(guard.check({}), { allow: true, reason: 'unavailable' })
  assert.deepEqual(guard.check(), { allow: true, reason: 'unavailable' })
  assert.equal(calls.pressure.length, 0)
})

test('kills only running jobs, with the session id and the quota reason', () => {
  const { ctx, calls } = fakeContext({
    tokens: 101,
    jobs: [
      { id: 'bash-running-a', status: 'running' },
      { id: 'bash-stopping', status: 'stopping' },
      { id: 'bash-completed', status: 'completed' },
      { id: 'bash-failed', status: 'failed' },
      { id: 'bash-killed', status: 'killed' },
      { id: 'bash-running-b', status: 'running' },
      { status: 'running' },
    ],
  })
  const guard = createPressureGuard({ ctx, maxPressure: 100, killJobs: true })

  assert.deepEqual(guard.check({ session: SESSION }), {
    kind: 'deny',
    allow: false,
    reason: 'pressure',
  })
  assert.deepEqual(calls.list, ['session:test'])
  assert.deepEqual(calls.kill, [
    { id: 'bash-running-a', caller: 'session:test', reason: 'quota' },
    { id: 'bash-running-b', caller: 'session:test', reason: 'quota' },
  ])

  const status = guard.status()
  assert.deepEqual(status.killedJobs, ['bash-running-a', 'bash-running-b'])
  assert.equal(status.counters.killLists, 1)
  assert.equal(status.counters.killRequests, 2)
  assert.equal(status.counters.killed, 2)
  assert.equal(status.counters.killSkipped, 1)
  assert.equal(status.counters.killErrors, 0)
})

test('killJobs:false never lists or kills jobs', () => {
  const { ctx, calls } = fakeContext({
    tokens: 101,
    jobs: [{ id: 'bash-running', status: 'running' }],
  })
  const guard = createPressureGuard({ ctx, maxPressure: 100 })

  assert.equal(guard.check({ session: SESSION }).reason, 'pressure')
  assert.equal(calls.list.length, 0)
  assert.equal(calls.kill.length, 0)
})

test('repeated over-limit checks do not request the same kill twice', () => {
  const { ctx, calls } = fakeContext({
    tokens: 101,
    jobs: [{ id: 'bash-running', status: 'running' }],
  })
  const guard = createPressureGuard({ ctx, maxPressure: 100, killJobs: true })

  guard.check({ session: SESSION })
  guard.check({ session: SESSION })
  assert.equal(calls.kill.length, 1)
  assert.equal(guard.status().counters.killSkipped, 1)
})

test('a kill failure is contained and the check still denies', () => {
  const { ctx } = fakeContext({
    tokens: 101,
    jobs: [{ id: 'bash-running', status: 'running' }],
    killError: new Error('kill exploded'),
  })
  const guard = createPressureGuard({ ctx, maxPressure: 100, killJobs: true })

  assert.deepEqual(guard.check({ session: SESSION }), {
    kind: 'deny',
    allow: false,
    reason: 'pressure',
  })
  const status = guard.status()
  assert.equal(status.counters.denied, 1)
  assert.equal(status.counters.killErrors, 1)
  assert.equal(status.counters.errors, 1)
  assert.match(status.lastError, /kill exploded/)
  assert.deepEqual(status.killedJobs, [])
})

test('a jobs.list failure is contained and the check still denies', () => {
  const { ctx } = fakeContext({
    tokens: 101,
    jobsError: new Error('list exploded'),
  })
  const guard = createPressureGuard({ ctx, maxPressure: 100, killJobs: true })

  assert.equal(guard.check({ session: SESSION }).kind, 'deny')
  const status = guard.status()
  assert.equal(status.counters.killLists, 0)
  assert.equal(status.counters.killErrors, 1)
  assert.match(status.lastError, /list exploded/)
})

test('a missing jobs service never changes the pressure denial', () => {
  const { ctx } = fakeContext({ tokens: 101, jobs: false })
  const guard = createPressureGuard({ ctx, maxPressure: 100, killJobs: true })

  assert.deepEqual(guard.check({ session: SESSION }), {
    kind: 'deny',
    allow: false,
    reason: 'pressure',
  })
  const status = guard.status()
  assert.equal(status.jobService, false)
  assert.equal(status.counters.killErrors, 1)
})

test('status aggregates allow and deny checks and exposes configuration', () => {
  let tokens = 10
  const { ctx } = fakeContext({ projection: { pressureTokens: 10 } })
  ctx.tokenMeter.contextPressure = () => ({ pressureTokens: tokens })
  const guard = createPressureGuard({ ctx, maxPressure: 100, killJobs: true })

  guard.check({ session: SESSION })
  tokens = 150
  guard.check({ session: SESSION })

  const status = guard.status()
  assert.equal(status.enabled, true)
  assert.equal(status.configured, true)
  assert.equal(status.available, true)
  assert.equal(status.jobService, true)
  assert.equal(status.maxPressure, 100)
  assert.equal(status.killJobs, true)
  assert.equal(status.counters.checks, 2)
  assert.equal(status.counters.allowed, 1)
  assert.equal(status.counters.denied, 1)
  assert.equal(status.pressureTokens, 150)
  assert.equal(status.last.kind, 'deny')
})

test('accepts a bare session object for lighter adapters', () => {
  const { ctx, calls } = fakeContext({ tokens: 10 })
  const guard = createPressureGuard({ ctx, maxPressure: 100 })

  assert.deepEqual(guard.check(SESSION), { allow: true })
  assert.deepEqual(calls.pressure, [SESSION])
})

test('validates maxPressure and killJobs', () => {
  assert.throws(() => createPressureGuard(), TypeError)
  assert.throws(() => createPressureGuard({ maxPressure: undefined }), /maxPressure/)
  assert.throws(() => createPressureGuard({ maxPressure: -1 }), /maxPressure/)
  assert.throws(() => createPressureGuard({ maxPressure: Number.NaN }), /maxPressure/)
  assert.throws(() => createPressureGuard({ maxPressure: 10, killJobs: 'yes' }), /killJobs/)
})
