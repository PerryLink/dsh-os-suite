import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createLeaseManager,
  isPathCovered,
  normalizePath,
  pathsOverlap,
} from '../src/core.js'

/**
 * @param {number} start
 */
function makeClock(start = 0) {
  let current = start
  return {
    now: () => current,
    advance(ms) {
      current += ms
    },
    set(value) {
      current = value
    },
  }
}

/**
 * @param {() => unknown} fn
 * @param {string} code
 */
function assertLeaseError(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, 'LeaseError')
    assert.equal(error.code, code)
    return true
  })
}

test('acquire normalizes paths and release is an explicit, single-use transition', () => {
  const clock = makeClock(1_000_000)
  const manager = createLeaseManager({ now: clock.now, defaultTtlMs: 60_000 })

  const lease = manager.acquire({
    workspace: ' /repo/ ',
    paths: ['./src/a.js', 'src\\b.js', 'src/a.js'],
    owner: 'agent-a',
  })

  assert.equal(lease.workspace, '/repo')
  assert.deepEqual(lease.paths, ['src/a.js', 'src/b.js'])
  assert.equal(lease.ttlMs, 60_000)
  assert.equal(lease.expiresAt, 1_060_000)
  assert.equal(lease.status, 'active')

  const released = manager.release(lease.id)
  assert.equal(released.status, 'released')
  assert.equal(manager.status().counts.leases.released, 1)
  assertLeaseError(() => manager.release(lease.id), 'ALREADY_RELEASED')
})

test('renew extends from the current clock and cannot revive an expired lease', () => {
  const clock = makeClock(0)
  const manager = createLeaseManager({ now: clock.now })
  const lease = manager.acquire({
    workspace: '/repo',
    paths: ['src'],
    owner: 'agent-a',
    ttlMs: 100,
  })

  clock.advance(50)
  const renewed = manager.renew(lease.id, 200)
  assert.equal(renewed.expiresAt, 250)
  assert.equal(renewed.ttlMs, 200)

  clock.set(300)
  assertLeaseError(() => manager.renew(lease.id), 'LEASE_EXPIRED')
  const released = manager.release(lease.id)
  assert.equal(released.status, 'released')
  assertLeaseError(() => manager.renew(lease.id), 'LEASE_RELEASED')
})

test('TTL expiry lazily marks leases expired and frees their paths', () => {
  const clock = makeClock(0)
  const manager = createLeaseManager({ now: clock.now })
  const lease = manager.acquire({
    workspace: '/repo',
    paths: ['src/a'],
    owner: 'agent-a',
    ttlMs: 100,
  })

  clock.set(99)
  assert.equal(
    manager.checkConflict({ workspace: '/repo', paths: ['src/a/b.js'] }).conflict,
    true,
  )

  clock.set(100)
  const result = manager.checkConflict({ workspace: '/repo', paths: ['src/a/b.js'] })
  assert.equal(result.conflict, false)
  assert.deepEqual(result.conflicts, [])
  assert.equal(manager.status().leases.find((item) => item.id === lease.id)?.status, 'expired')

  const replacement = manager.acquire({
    workspace: '/repo',
    paths: ['src/a'],
    owner: 'agent-b',
    ttlMs: 100,
  })
  assert.equal(replacement.status, 'active')
  assert.equal(manager.status().counts.leases.active, 1)
})

test('prefix overlaps conflict on segment boundaries in both directions', () => {
  const clock = makeClock(0)
  const manager = createLeaseManager({ now: clock.now })

  manager.acquire({ workspace: '/repo', paths: ['src/a'], owner: 'agent-a' })

  assertLeaseError(
    () => manager.acquire({ workspace: '/repo', paths: ['src/a/b'], owner: 'agent-b' }),
    'CONFLICT',
  )
  assertLeaseError(
    () => manager.acquire({ workspace: '/repo', paths: ['src/a/b/c'], owner: 'agent-b' }),
    'CONFLICT',
  )

  // Same prefix string but not a segment boundary: allowed.
  const sibling = manager.acquire({ workspace: '/repo', paths: ['src/ab'], owner: 'agent-c' })
  assert.equal(sibling.status, 'active')

  const check = manager.checkConflict({ workspace: '/repo', paths: ['src/a/x.js'] })
  assert.equal(check.conflict, true)
  assert.equal(check.conflicts[0].reason, 'prefix')
  assert.equal(check.conflicts[0].leasePath, 'src/a')

  const reversedClock = makeClock(0)
  const reversed = createLeaseManager({ now: reversedClock.now })
  reversed.acquire({ workspace: '/repo', paths: ['src/a/b'], owner: 'agent-a' })
  assertLeaseError(
    () => reversed.acquire({ workspace: '/repo', paths: ['src/a'], owner: 'agent-b' }),
    'CONFLICT',
  )

  assert.equal(pathsOverlap('src/a', 'src/a/b'), true)
  assert.equal(pathsOverlap('src/a', 'src/ab'), false)
})

test('different workspaces never conflict, even for identical paths', () => {
  const clock = makeClock(0)
  const manager = createLeaseManager({ now: clock.now })

  manager.acquire({ workspace: '/repo-a', paths: ['src/a'], owner: 'agent-a' })
  const other = manager.acquire({ workspace: '/repo-b', paths: ['src/a'], owner: 'agent-b' })
  assert.equal(other.workspace, '/repo-b')

  assert.equal(
    manager.checkConflict({ workspace: '/repo-c', paths: ['src/a'] }).conflict,
    false,
  )
  assert.equal(
    manager.checkConflict({ workspace: '/repo-a/', paths: ['src/a'] }).conflict,
    true,
  )
  assert.equal(
    manager.checkConflict({ workspace: '/repo-a//', paths: ['src/a'] }).conflict,
    true,
  )
  assert.deepEqual(manager.checkConflict({ workspace: '/repo-a', paths: [] }).conflicts, [])
})

test('prepare validates coverage then commit returns a path-sorted write set', () => {
  const clock = makeClock(0)
  const manager = createLeaseManager({ now: clock.now })
  const lease = manager.acquire({ workspace: '/repo', paths: ['src'], owner: 'agent-a' })

  const patchset = manager.preparePatchset(lease.id, [
    { path: 'src/z.js', before: 'old-z', after: 'new-z' },
    { path: './src/a.js', before: 'old-a', after: 'new-a' },
  ])

  assert.equal(patchset.status, 'prepared')
  assert.equal(patchset.files.length, 2)
  assert.equal(manager.status().counts.patchsets.prepared, 1)

  const writes = manager.commitPatchset(patchset.id)
  assert.deepEqual(writes, [
    { path: 'src/a.js', after: 'new-a' },
    { path: 'src/z.js', after: 'new-z' },
  ])
  assert.equal(manager.status().patchsets[0].status, 'committed')
  assertLeaseError(() => manager.commitPatchset(patchset.id), 'ALREADY_COMMITTED')
})

test('rollback returns sorted before values and can run only once', () => {
  const clock = makeClock(0)
  const manager = createLeaseManager({ now: clock.now })
  const lease = manager.acquire({ workspace: '/repo', paths: ['src'], owner: 'agent-a' })

  const prepared = manager.preparePatchset(lease.id, [
    { path: 'src/z.js', after: 'z' },
    { path: 'src/a.js', before: 'old-a', after: 'a' },
  ])
  const restores = manager.rollbackPatchset(prepared.id)
  assert.deepEqual(restores, [{ path: 'src/a.js', before: 'old-a' }, { path: 'src/z.js' }])
  assert.equal('before' in restores[1], false)
  assertLeaseError(() => manager.rollbackPatchset(prepared.id), 'ALREADY_ROLLED_BACK')
  assertLeaseError(() => manager.commitPatchset(prepared.id), 'ALREADY_ROLLED_BACK')

  // A committed patchset can still be rolled back to undo its pre-images.
  const committed = manager.preparePatchset(lease.id, [
    { path: 'src/a.js', before: 'before-commit', after: 'after-commit' },
  ])
  manager.commitPatchset(committed.id)
  assert.deepEqual(manager.rollbackPatchset(committed.id), [
    { path: 'src/a.js', before: 'before-commit' },
  ])
  assertLeaseError(() => manager.commitPatchset(committed.id), 'ALREADY_ROLLED_BACK')
})

test('commit is rejected when the authorizing lease expired or was released', () => {
  const clock = makeClock(0)
  const manager = createLeaseManager({ now: clock.now })
  const lease = manager.acquire({
    workspace: '/repo',
    paths: ['src'],
    owner: 'agent-a',
    ttlMs: 100,
  })
  const patchset = manager.preparePatchset(lease.id, [
    { path: 'src/a.js', before: 'old', after: 'new' },
  ])

  clock.set(100)
  assertLeaseError(() => manager.commitPatchset(patchset.id), 'LEASE_EXPIRED')
  assertLeaseError(
    () => manager.preparePatchset(lease.id, [{ path: 'src/b.js', after: 'x' }]),
    'LEASE_EXPIRED',
  )
  // Rollback remains available for cleanup even after the lease died.
  assert.deepEqual(manager.rollbackPatchset(patchset.id), [
    { path: 'src/a.js', before: 'old' },
  ])

  const clock2 = makeClock(0)
  const manager2 = createLeaseManager({ now: clock2.now })
  const lease2 = manager2.acquire({ workspace: '/repo', paths: ['src'], owner: 'agent-a' })
  const patchset2 = manager2.preparePatchset(lease2.id, [
    { path: 'src/a.js', before: 'old', after: 'new' },
  ])
  manager2.release(lease2.id)
  assertLeaseError(() => manager2.commitPatchset(patchset2.id), 'LEASE_RELEASED')
  assertLeaseError(
    () => manager2.preparePatchset(lease2.id, [{ path: 'src/b.js', after: 'x' }]),
    'LEASE_RELEASED',
  )
})

test('prepare rejects unleased, duplicate, and escaping paths', () => {
  const clock = makeClock(0)
  const manager = createLeaseManager({ now: clock.now })
  const lease = manager.acquire({ workspace: '/repo', paths: ['src/a'], owner: 'agent-a' })

  assertLeaseError(
    () => manager.preparePatchset(lease.id, [{ path: 'src/b.js', after: 'x' }]),
    'PATH_NOT_LEASED',
  )
  assertLeaseError(
    () => manager.preparePatchset(lease.id, [{ path: 'src/ab', after: 'x' }]),
    'PATH_NOT_LEASED',
  )
  assertLeaseError(
    () =>
      manager.preparePatchset(lease.id, [
        { path: 'src/a/x.js', after: 'one' },
        { path: 'src/a/./x.js', after: 'two' },
      ]),
    'INVALID_PATH',
  )
  assertLeaseError(
    () =>
      manager.preparePatchset(lease.id, [
        { path: 'src/a/x.js', after: 'one' },
        { path: 'src/a/x.js', after: 'two' },
      ]),
    'DUPLICATE_PATH',
  )
  assertLeaseError(
    () => manager.preparePatchset(lease.id, [{ path: '../escape.js', after: 'x' }]),
    'INVALID_PATH',
  )
  assertLeaseError(() => manager.preparePatchset(lease.id, []), 'INVALID_ARGUMENT')

  assert.equal(isPathCovered('src/a/x.js', ['src/a']), true)
  assert.equal(isPathCovered('src/ab', ['src/a']), false)
  assert.throws(() => normalizePath('/absolute'), { code: 'INVALID_PATH' })
  assert.throws(() => normalizePath('C:\\repo\\x'), { code: 'INVALID_PATH' })
})

test('two prepared patchsets may not overlap, while committed ones do not block new work', () => {
  const clock = makeClock(0)
  const manager = createLeaseManager({ now: clock.now })
  const lease = manager.acquire({ workspace: '/repo', paths: ['src'], owner: 'agent-a' })

  const first = manager.preparePatchset(lease.id, [{ path: 'src/a.js', after: 'first' }])
  assertLeaseError(
    () => manager.preparePatchset(lease.id, [{ path: 'src/a.js', after: 'second' }]),
    'PATCHSET_CONFLICT',
  )
  assertLeaseError(
    () => manager.preparePatchset(lease.id, [{ path: 'src/a.js/child', after: 'child' }]),
    'PATCHSET_CONFLICT',
  )

  // Disjoint paths can be prepared concurrently.
  const disjoint = manager.preparePatchset(lease.id, [{ path: 'src/b.js', after: 'b' }])
  assert.equal(disjoint.status, 'prepared')

  manager.commitPatchset(first.id)
  const later = manager.preparePatchset(lease.id, [{ path: 'src/a.js', before: 'first', after: 'later' }])
  assert.equal(later.status, 'prepared')
})

test('status reports counts and summarizes patchsets without echoing file bodies', () => {
  const clock = makeClock(0)
  const manager = createLeaseManager({ now: clock.now, defaultTtlMs: 5_000 })
  const lease = manager.acquire({ workspace: '/repo', paths: ['src'], owner: 'agent-a' })
  manager.preparePatchset(lease.id, [
    { path: 'src/a.js', before: 'secret-before', after: 'secret-after' },
  ])

  const snapshot = manager.status()
  assert.equal(snapshot.defaultTtlMs, 5_000)
  assert.equal(snapshot.leases.length, 1)
  assert.equal(snapshot.leases[0].owner, 'agent-a')
  assert.equal(snapshot.patchsets.length, 1)
  assert.deepEqual(snapshot.patchsets[0].paths, ['src/a.js'])
  assert.equal(snapshot.patchsets[0].fileCount, 1)
  assert.equal('files' in snapshot.patchsets[0], false)
  assert.equal(JSON.stringify(snapshot).includes('secret-after'), false)
  assert.deepEqual(snapshot.counts.leases, { active: 1, expired: 0, released: 0 })
  assert.deepEqual(snapshot.counts.patchsets, { prepared: 1, committed: 0, rolledBack: 0 })
})
