import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createRegistry,
  DEFAULT_PORT_RANGE,
  DEFAULT_TTL_MS,
  RegistryError,
} from '../src/core.js'

/**
 * Deterministic clock for lease tests.
 *
 * @param {number} [start]
 */
function buildClock(start = 1_000_000) {
  let current = start
  return {
    now: () => current,
    advance(ms) {
      current += ms
    },
  }
}

/**
 * @param {() => unknown} fn
 * @param {string} code
 */
function assertErrorCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof RegistryError, 'expected a RegistryError')
    assert.equal(error.code, code)
    return true
  })
}

test('allocates the lowest free port and records the full service shape', () => {
  const clock = buildClock()
  const registry = createRegistry({
    now: clock.now,
    portRange: { start: 4100, end: 4102 },
  })

  const web = registry.register({ name: 'web', owner: 'agent-a' })
  assert.match(web.id, /^svc-/)
  assert.equal(web.name, 'web')
  assert.equal(web.port, 4100)
  assert.equal(web.url, 'http://127.0.0.1:4100')
  assert.equal(web.owner, 'agent-a')
  assert.equal(web.health, 'unknown')
  assert.equal(web.ttlMs, DEFAULT_TTL_MS)
  assert.equal(web.createdAt, clock.now())
  assert.equal(web.expiresAt, clock.now() + DEFAULT_TTL_MS)
  assert.equal('pid' in web, false)

  const api = registry.register({ name: 'api', owner: 'agent-a', pid: 4242, ttlMs: 5_000 })
  assert.equal(api.port, 4101)
  assert.equal(api.pid, 4242)
  assert.equal(api.ttlMs, 5_000)
  assert.equal(api.expiresAt, clock.now() + 5_000)

  const docs = registry.register({ name: 'docs', owner: 'agent-b' })
  assert.equal(docs.port, 4102)
  assert.deepEqual(registry.reclaimExpired(), [])
})

test('honors an explicit port and rejects a conflicting lease', () => {
  const clock = buildClock()
  const registry = createRegistry({ now: clock.now, portRange: { start: 4100, end: 4199 } })

  const first = registry.register({ name: 'api', port: 5000, owner: 'agent-a' })
  assert.equal(first.port, 5000)
  assert.equal(first.url, 'http://127.0.0.1:5000')

  assertErrorCode(
    () => registry.register({ name: 'api-2', port: 5000, owner: 'agent-b' }),
    'PORT_IN_USE',
  )

  // The failed registration must not reserve anything or consume the id.
  assert.equal(registry.list().length, 1)
  assert.equal(registry.release(first.id), true)
  const second = registry.register({ name: 'api-2', port: 5000, owner: 'agent-b' })
  assert.equal(second.port, 5000)
})

test('explicit ports may live outside the auto-allocation pool', () => {
  const clock = buildClock()
  const registry = createRegistry({ now: clock.now, portRange: { start: 4100, end: 4101 } })

  const fixed = registry.register({ name: 'fixed', port: 3000, owner: 'agent-a' })
  assert.equal(fixed.port, 3000)

  const allocated = registry.register({ name: 'web', owner: 'agent-a' })
  assert.equal(allocated.port, 4100)
})

test('throws PORT_RANGE_EXHAUSTED and recovers when a lease is released', () => {
  const clock = buildClock()
  const registry = createRegistry({ now: clock.now, portRange: { start: 4200, end: 4201 } })

  const first = registry.register({ name: 'web', owner: 'agent-a' })
  registry.register({ name: 'api', owner: 'agent-a' })
  assertErrorCode(
    () => registry.register({ name: 'docs', owner: 'agent-a' }),
    'PORT_RANGE_EXHAUSTED',
  )

  registry.release(first.id)
  const reused = registry.register({ name: 'docs', owner: 'agent-a' })
  assert.equal(reused.port, 4200)
})

test('release is idempotent and frees the port', () => {
  const clock = buildClock()
  const registry = createRegistry({ now: clock.now, portRange: { start: 4100, end: 4100 } })

  const service = registry.register({ name: 'web', owner: 'agent-a' })
  assert.deepEqual(registry.status(service.id), service)

  assert.equal(registry.release(service.id), true)
  assert.equal(registry.status(service.id), null)
  assert.equal(registry.release(service.id), false)
  assert.equal(registry.release('svc-does-not-exist'), false)
  assert.deepEqual(registry.list(), [])

  const replacement = registry.register({ name: 'web-2', owner: 'agent-b' })
  assert.equal(replacement.port, 4100)
  assert.notEqual(replacement.id, service.id)
})

test('expired leases are reclaimed by list at the TTL boundary', () => {
  const clock = buildClock()
  const registry = createRegistry({ now: clock.now, portRange: { start: 4100, end: 4100 } })

  registry.register({ name: 'web', owner: 'agent-a', ttlMs: 1_000 })
  assert.equal(registry.list().length, 1)

  clock.advance(999)
  assert.equal(registry.list().length, 1)

  clock.advance(1)
  assert.deepEqual(registry.list(), [])
  assert.equal(registry.status('svc-1'), null)

  const replacement = registry.register({ name: 'web-2', owner: 'agent-b' })
  assert.equal(replacement.port, 4100)
})

test('reclaimExpired returns removed records and is idempotent', () => {
  const clock = buildClock()
  const registry = createRegistry({ now: clock.now, portRange: { start: 4100, end: 4101 } })

  const short = registry.register({ name: 'short', owner: 'agent-a', ttlMs: 1_000 })
  const long = registry.register({ name: 'long', owner: 'agent-a', ttlMs: 10_000 })

  clock.advance(1_000)
  const reclaimed = registry.reclaimExpired()
  assert.deepEqual(reclaimed, [short])
  assert.deepEqual(registry.reclaimExpired(), [])
  assert.deepEqual(registry.list(), [long])
})

test('list filters by owner and sorts by port', () => {
  const clock = buildClock()
  const registry = createRegistry({ now: clock.now, portRange: { start: 4100, end: 4199 } })

  registry.register({ name: 'docs', port: 4103, owner: 'agent-b' })
  registry.register({ name: 'web', port: 4101, owner: 'agent-a' })
  registry.register({ name: 'api', port: 4102, owner: 'agent-a' })

  assert.deepEqual(
    registry.list().map((service) => service.port),
    [4101, 4102, 4103],
  )
  assert.deepEqual(
    registry.list({ owner: 'agent-a' }).map((service) => service.name),
    ['web', 'api'],
  )
  assert.deepEqual(registry.list({ owner: 'nobody' }), [])
})

test('checkHealth records ok, down and throwing probes', async () => {
  const clock = buildClock()
  const registry = createRegistry({ now: clock.now, portRange: { start: 4100, end: 4199 } })
  const service = registry.register({ name: 'web', owner: 'agent-a' })

  assert.equal(registry.status(service.id)?.health, 'unknown')

  /** @type {unknown[]} */
  const probed = []
  const healthy = await registry.checkHealth(service.id, async (candidate) => {
    probed.push(candidate)
    return true
  })
  assert.equal(probed.length, 1)
  assert.deepEqual(probed[0], service)
  assert.equal(healthy?.health, 'ok')
  assert.equal(registry.status(service.id)?.health, 'ok')

  const unhealthy = await registry.checkHealth(service.id, async () => ({ ok: false, status: 'oops' }))
  assert.equal(unhealthy?.health, 'down')
  assert.equal(registry.status(service.id)?.health, 'down')

  const thrown = await registry.checkHealth(service.id, () => {
    throw new Error('probe exploded')
  })
  assert.equal(thrown?.health, 'down')

  const recovered = await registry.checkHealth(service.id, () => 'healthy')
  assert.equal(recovered?.health, 'ok')
})

test('checkHealth returns null for unknown ids and rejects a non-function probe', async () => {
  const clock = buildClock()
  const registry = createRegistry({ now: clock.now })

  assert.equal(await registry.checkHealth('svc-missing', () => true), null)
  await assert.rejects(
    registry.checkHealth('svc-missing', /** @type {any} */ (null)),
    (error) => error instanceof RegistryError && error.code === 'INVALID_ARGUMENT',
  )
})

test('checkHealth discards a probe result when the lease is released mid-flight', async () => {
  const clock = buildClock()
  const registry = createRegistry({ now: clock.now })
  const service = registry.register({ name: 'web', owner: 'agent-a' })

  /** @type {(value: boolean) => void} */
  let resolveProbe
  const pending = new Promise((resolve) => {
    resolveProbe = resolve
  })

  const result = registry.checkHealth(service.id, () => pending)
  assert.equal(registry.release(service.id), true)
  resolveProbe(true)

  assert.equal(await result, null)
  assert.equal(registry.status(service.id), null)
})

test('rejects invalid registration input and invalid registry options', () => {
  const clock = buildClock()
  const registry = createRegistry({ now: clock.now, portRange: { start: 4100, end: 4101 } })

  assertErrorCode(() => registry.register({ owner: 'agent-a' }), 'INVALID_ARGUMENT')
  assertErrorCode(() => registry.register({ name: 'web' }), 'INVALID_ARGUMENT')
  assertErrorCode(() => registry.register({ name: '  ', owner: 'agent-a' }), 'INVALID_ARGUMENT')
  assertErrorCode(
    () => registry.register({ name: 'web', owner: 'agent-a', port: 0 }),
    'INVALID_PORT',
  )
  assertErrorCode(
    () => registry.register({ name: 'web', owner: 'agent-a', port: 1.5 }),
    'INVALID_PORT',
  )
  assertErrorCode(
    () => registry.register({ name: 'web', owner: 'agent-a', ttlMs: 0 }),
    'INVALID_TTL',
  )
  assertErrorCode(
    () => registry.register({ name: 'web', owner: 'agent-a', pid: 0 }),
    'INVALID_PID',
  )
  assertErrorCode(
    () => registry.register({ name: 'web', owner: 'agent-a', port: 70_000 }),
    'INVALID_PORT',
  )

  assertErrorCode(
    () => createRegistry({ portRange: { start: 4200, end: 4100 } }),
    'INVALID_PORT_RANGE',
  )
  assertErrorCode(
    () => createRegistry({ portRange: { start: 0, end: 4100 } }),
    'INVALID_PORT_RANGE',
  )
  assertErrorCode(
    () => createRegistry({ now: /** @type {any} */ ('not-a-function') }),
    'INVALID_ARGUMENT',
  )

  assert.equal(registry.list().length, 0)
})

test('the default port range starts at 4100', () => {
  const clock = buildClock()
  const registry = createRegistry({ now: clock.now })
  assert.equal(registry.register({ name: 'web', owner: 'agent-a' }).port, DEFAULT_PORT_RANGE.start)
})
