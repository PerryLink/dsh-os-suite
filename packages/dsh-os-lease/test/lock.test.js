import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_LOCK_TTL_MS,
  FileLockProvider,
  LockError,
  LockProvider,
  MemoryLockProvider,
  assertLockProvider,
  lockFileName,
  withLock,
} from '../src/lock.js'

const START = 1_800_000_000_000

/**
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>}
 */
async function makeDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-os-lease-locks-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return fs.realpath(dir)
}

/**
 * @param {number} [start]
 * @returns {{ now: number }}
 */
function makeClock(start = START) {
  return { now: start }
}

/** @param {{ now: number }} clock */
function clockOf(clock) {
  return () => clock.now
}

const PROVIDERS = [
  {
    kind: 'file',
    /**
     * @param {import('node:test').TestContext} t
     * @param {{ now: number }} clock
     */
    async create(t, clock) {
      return new FileLockProvider({ dir: await makeDir(t), clock: clockOf(clock) })
    },
  },
  {
    kind: 'memory',
    /**
     * @param {import('node:test').TestContext} _t
     * @param {{ now: number }} clock
     */
    async create(_t, clock) {
      return new MemoryLockProvider({ clock: clockOf(clock) })
    },
  },
]

/** @param {string} code */
function lockCode(code) {
  return (error) => {
    assert.ok(error instanceof LockError, `expected LockError, got ${error}`)
    assert.equal(error.name, 'LockError')
    assert.equal(error.code, code)
    return true
  }
}

for (const { kind, create } of PROVIDERS) {
  test(`${kind}: acquire records owner/expiry, inspect reports it, and conflicts are LOCKED`, async (t) => {
    const clock = makeClock()
    const provider = await create(t, clock)

    const handle = await provider.acquire('src/app.js', { ttlMs: 5000, owner: 'agent-1' })
    assert.equal(handle.key, 'src/app.js')
    assert.equal(handle.owner, 'agent-1')
    assert.equal(handle.expiresAt, START + 5000)
    assert.equal(handle.provider, kind)
    assert.equal(typeof handle.token, 'string')

    const info = await provider.inspect('src/app.js')
    assert.equal(info.key, 'src/app.js')
    assert.equal(info.locked, true)
    assert.equal(info.owner, 'agent-1')
    assert.equal(info.expiresAt, START + 5000)
    assert.equal(info.expired, false)

    await assert.rejects(
      provider.acquire('src/app.js', { ttlMs: 5000, owner: 'agent-2' }),
      (error) => {
        assert.ok(error instanceof LockError)
        assert.equal(error.code, 'LOCKED')
        assert.equal(error.details.key, 'src/app.js')
        assert.equal(error.details.owner, 'agent-1')
        assert.equal(error.details.expiresAt, START + 5000)
        return true
      },
    )

    // A disjoint key is independent.
    const other = await provider.acquire('src/other.js', { ttlMs: 5000, owner: 'agent-2' })
    assert.equal(other.owner, 'agent-2')
    assert.equal((await provider.inspect('src/other.js')).locked, true)

    await provider.release(handle)
    await provider.release(other)
    assert.equal((await provider.inspect('src/app.js')).locked, false)
  })

  test(`${kind}: expired locks are reclaimable and the old handle cannot renew or release`, async (t) => {
    const clock = makeClock()
    const provider = await create(t, clock)

    const first = await provider.acquire('key', { ttlMs: 1000, owner: 'old-owner' })
    // Expiry is exclusive: at exactly expiresAt the lock is stale.
    clock.now = START + 1000
    const expired = await provider.inspect('key')
    assert.equal(expired.locked, true)
    assert.equal(expired.expired, true)
    await assert.rejects(provider.renew(first, { ttlMs: 1000 }), lockCode('LOCK_EXPIRED'))

    const second = await provider.acquire('key', { ttlMs: 1000, owner: 'new-owner' })
    assert.equal(second.owner, 'new-owner')
    assert.notEqual(second.token, first.token)
    assert.equal((await provider.inspect('key')).owner, 'new-owner')

    // Token check: the stale holder must not be able to affect the new lock.
    await assert.rejects(provider.renew(first, { ttlMs: 1000 }), lockCode('LOCK_LOST'))
    await assert.rejects(provider.release(first), lockCode('LOCK_LOST'))
    assert.equal((await provider.inspect('key')).owner, 'new-owner')
    assert.equal((await provider.inspect('key')).locked, true)

    await provider.release(second)
  })

  test(`${kind}: release frees the key exactly once and cannot release a reacquired lock`, async (t) => {
    const clock = makeClock()
    const provider = await create(t, clock)
    const first = await provider.acquire('key', { ttlMs: 1000, owner: 'agent-1' })

    const released = await provider.release(first)
    assert.equal(released.key, 'key')
    assert.equal(released.owner, 'agent-1')
    assert.equal(released.released, true)
    assert.equal((await provider.inspect('key')).locked, false)
    await assert.rejects(provider.release(first), lockCode('LOCK_LOST'))

    const second = await provider.acquire('key', { ttlMs: 1000, owner: 'agent-2' })
    assert.equal((await provider.inspect('key')).owner, 'agent-2')
    // The old handle's token is still not a capability for the new lock.
    await assert.rejects(provider.release(first), lockCode('LOCK_LOST'))
    assert.equal((await provider.inspect('key')).owner, 'agent-2')
    await provider.release(second)
  })

  test(`${kind}: renew extends from now and keeps ownership`, async (t) => {
    const clock = makeClock()
    const provider = await create(t, clock)
    const handle = await provider.acquire('key', { ttlMs: 1000, owner: 'agent-1' })
    assert.equal(handle.expiresAt, START + 1000)

    clock.now = START + 500
    const renewed = await provider.renew(handle, { ttlMs: 2000 })
    assert.equal(renewed.owner, 'agent-1')
    assert.equal(renewed.expiresAt, START + 2500)
    assert.equal(renewed.renewedAt, START + 500)
    const info = await provider.inspect('key')
    assert.equal(info.expiresAt, START + 2500)
    assert.equal(info.expired, false)

    clock.now = START + 2500
    await assert.rejects(provider.renew(renewed, { ttlMs: 1000 }), lockCode('LOCK_EXPIRED'))
    // Releasing an expired-but-unreclaimed record is still safe.
    await provider.release(renewed)
    assert.equal((await provider.inspect('key')).locked, false)
  })

  test(`${kind}: withLock returns the callback result and releases on success and on throw`, async (t) => {
    const clock = makeClock()
    const provider = await create(t, clock)

    const value = await withLock(
      provider,
      'key',
      async (handle) => {
        assert.equal(handle.key, 'key')
        assert.equal(handle.owner, `withLock:${process.pid}`)
        assert.equal((await provider.inspect('key')).locked, true)
        return 42
      },
      { ttlMs: 1000 },
    )
    assert.equal(value, 42)
    assert.equal((await provider.inspect('key')).locked, false)

    await assert.rejects(
      withLock(
        provider,
        'key',
        async () => {
          assert.equal((await provider.inspect('key')).locked, true)
          throw new Error('callback exploded')
        },
        { ttlMs: 1000, owner: 'agent-failure' },
      ),
      /callback exploded/,
    )
    assert.equal((await provider.inspect('key')).locked, false)

    // A held lock surfaces as LOCKED instead of running the callback.
    const held = await provider.acquire('key', { ttlMs: 1000, owner: 'other' })
    await assert.rejects(withLock(provider, 'key', () => 'never', { ttlMs: 1000 }), lockCode('LOCKED'))
    await provider.release(held)
  })
}

test('lockFileName is a deterministic hash instead of the raw key', () => {
  const name = lockFileName('src/deep path/a.js')
  assert.match(name, /^[a-f0-9]{64}\.lock$/)
  assert.equal(name, lockFileName('src/deep path/a.js'))
  assert.notEqual(name, lockFileName('src/deep path/b.js'))
  assert.equal(lockFileName('a'), lockFileName('a'))
})

test('FileLockProvider writes owner/expiresAt and reclaims an expired foreign lock', async (t) => {
  const dir = await makeDir(t)
  const provider = new FileLockProvider({ dir, clock: () => START })
  const handle = await provider.acquire('src/x.js', { ttlMs: 1234, owner: 'agent-7' })
  const lockPath = path.join(dir, lockFileName('src/x.js'))

  const record = JSON.parse(await fs.readFile(lockPath, 'utf8'))
  assert.equal(record.key, 'src/x.js')
  assert.equal(record.owner, 'agent-7')
  assert.equal(record.expiresAt, START + 1234)
  assert.equal(record.pid, process.pid)
  assert.equal(record.token, handle.token)
  assert.equal(path.basename(lockPath), lockFileName('src/x.js'))

  await provider.release(handle)
  assert.equal((await provider.inspect('src/x.js')).locked, false)

  // Simulate a crash: a lock file whose owner is gone and whose TTL elapsed.
  await fs.writeFile(
    lockPath,
    `${JSON.stringify({
      version: 1,
      key: 'src/x.js',
      owner: 'crashed-process',
      token: 'stale-token',
      pid: 999999,
      // ISO strings are accepted for hand-written/foreign records too.
      acquiredAt: new Date(START - 60_000).toISOString(),
      renewedAt: null,
      expiresAt: new Date(START - 1).toISOString(),
    })}\n`,
  )
  const reclaimed = await provider.acquire('src/x.js', { ttlMs: 5000, owner: 'agent-8' })
  assert.equal(reclaimed.owner, 'agent-8')
  const replaced = JSON.parse(await fs.readFile(lockPath, 'utf8'))
  assert.equal(replaced.owner, 'agent-8')
  assert.notEqual(replaced.token, 'stale-token')
  assert.deepEqual(await fs.readdir(dir), [lockFileName('src/x.js')])
  await provider.release(reclaimed)
})

test('FileLockProvider treats a legacy lock file without expiresAt as held', async (t) => {
  const dir = await makeDir(t)
  const lockPath = path.join(dir, lockFileName('a.txt'))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(lockPath, `${JSON.stringify({ pid: process.pid, path: 'a.txt' })}\n`)

  const provider = new FileLockProvider({ dir, clock: () => START })
  await assert.rejects(provider.acquire('a.txt', { ttlMs: 1000, owner: 'new' }), (error) => {
    assert.ok(error instanceof LockError)
    assert.equal(error.code, 'LOCKED')
    // No expiry is conservative: never auto-reclaim a legacy lock.
    assert.equal(error.details.owner, null)
    assert.equal(error.details.expiresAt, null)
    assert.equal(error.details.lockPath, lockPath)
    return true
  })
  const info = await provider.inspect('a.txt')
  assert.equal(info.locked, true)
  assert.equal(info.expired, false)
  assert.equal(info.expiresAt, null)

  await fs.unlink(lockPath)
  assert.equal((await provider.inspect('a.txt')).locked, false)
})

test('two FileLockProvider instances over one directory exclude each other and reclaim after TTL', async (t) => {
  const dir = await makeDir(t)
  const clockA = { now: START }
  const clockB = { now: START + 100 } // a 100 ms skew between the two "hosts"
  const hostA = new FileLockProvider({ dir, clock: clockOf(clockA) })
  const hostB = new FileLockProvider({ dir, clock: clockOf(clockB) })

  const held = await hostA.acquire('shared/file.js', { ttlMs: 1000, owner: 'host-a/agent-1' })
  await assert.rejects(
    hostB.acquire('shared/file.js', { ttlMs: 1000, owner: 'host-b/agent-2' }),
    (error) => {
      assert.equal(error.code, 'LOCKED')
      assert.equal(error.details.owner, 'host-a/agent-1')
      assert.equal(error.details.expiresAt, START + 1000)
      return true
    },
  )

  // At START+1000 host A considers the lock expired; host B's clock is ahead
  // (START+1100), which only makes the same record look more expired. Reclaim
  // succeeds, and the old token is still rejected.
  clockA.now = START + 1000
  clockB.now = START + 1100
  const reclaimed = await hostB.acquire('shared/file.js', {
    ttlMs: 1000,
    owner: 'host-b/agent-2',
  })
  assert.equal(reclaimed.owner, 'host-b/agent-2')
  await assert.rejects(hostA.release(held), (error) => {
    assert.equal(error.code, 'LOCK_LOST')
    return true
  })
  await hostB.release(reclaimed)
  assert.equal((await hostA.inspect('shared/file.js')).locked, false)
})

test('FileLockProvider lets exactly one of several concurrent acquirers win', async (t) => {
  const dir = await makeDir(t)
  const provider = new FileLockProvider({ dir })
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) =>
      provider.acquire('race', { ttlMs: 5000, owner: `agent-${index}` }),
    ),
  )
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 4)
  for (const result of rejected) {
    assert.equal(result.reason.code, 'LOCKED')
  }
  await provider.release(fulfilled[0].value)
})

test('providers and withLock reject malformed keys, owners, TTLs, and handles', async (t) => {
  const clock = makeClock()
  const provider = new MemoryLockProvider({ clock: clockOf(clock) })

  await assert.rejects(provider.acquire('', { owner: 'a' }), lockCode('INVALID_ARGUMENT'))
  await assert.rejects(provider.acquire('key', { owner: '' }), lockCode('INVALID_ARGUMENT'))
  await assert.rejects(provider.acquire('key', { owner: 'a', ttlMs: 0 }), lockCode('INVALID_ARGUMENT'))
  await assert.rejects(provider.acquire('key', { owner: 'a', ttlMs: Number.NaN }), lockCode('INVALID_ARGUMENT'))
  await assert.rejects(provider.renew({ key: 'key' }), lockCode('INVALID_ARGUMENT'))
  await assert.rejects(provider.release(null), lockCode('INVALID_ARGUMENT'))

  assert.throws(() => assertLockProvider({}), lockCode('INVALID_ARGUMENT'))
  assert.throws(() => assertLockProvider(null), lockCode('INVALID_ARGUMENT'))
  assert.throws(() => assertLockProvider({ acquire() {}, renew() {}, release() {} }), lockCode('INVALID_ARGUMENT'))

  const base = new LockProvider()
  await assert.rejects(base.acquire('key', { owner: 'a' }), lockCode('NOT_IMPLEMENTED'))
  await assert.rejects(base.inspect('key'), lockCode('NOT_IMPLEMENTED'))

  await assert.rejects(withLock(provider, 'key', 'not a function'), lockCode('INVALID_ARGUMENT'))

  // Default TTL applies when ttlMs is omitted.
  const handle = await provider.acquire('default-ttl', { owner: 'a' })
  assert.equal(handle.expiresAt, START + DEFAULT_LOCK_TTL_MS)
  await provider.release(handle)
})

test('MemoryLockProvider instances do not share locks', async (t) => {
  const first = new MemoryLockProvider({ clock: () => START })
  const second = new MemoryLockProvider({ clock: () => START })
  const handle = await first.acquire('key', { ttlMs: 1000, owner: 'agent-1' })
  assert.equal((await second.inspect('key')).locked, false)
  const other = await second.acquire('key', { ttlMs: 1000, owner: 'agent-2' })
  assert.equal(other.owner, 'agent-2')
  await first.release(handle)
  await second.release(other)
})
