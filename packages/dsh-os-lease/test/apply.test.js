import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ApplyError,
  applyPatchset,
  readJournal,
  rollback,
} from '../src/apply.js'
import { FileLockProvider, MemoryLockProvider } from '../src/lock.js'

/**
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>}
 */
async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-os-lease-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  return fs.realpath(root)
}

/** @param {string} root @param {string} relative */
function absolute(root, relative) {
  return path.join(root, relative)
}

/** @param {string} root @param {string} relative */
async function readText(root, relative) {
  return fs.readFile(absolute(root, relative), 'utf8')
}

/** @param {string} root @param {string} relative @param {string} text */
async function writeText(root, relative, text) {
  const target = absolute(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, text)
  return target
}

/** @param {string} root @param {string} relative */
function lockPathFor(root, relative) {
  const hash = createHash('sha256').update(Buffer.from(relative, 'utf8')).digest('hex')
  return path.join(root, '.dsh-os-lease', 'locks', `${hash}.lock`)
}

/** @param {Promise<unknown>} promise @param {string} code */
async function assertApplyCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'ApplyError')
    assert.equal(error.code, code)
    return true
  })
}

test('applyPatchset writes files, backs up the real pre-image, and readJournal reads it back', async (t) => {
  const root = await makeRoot(t)
  await writeText(root, 'src/app.txt', 'old-app')

  const journal = await applyPatchset(
    {
      id: 'patch-write',
      leaseId: 'lease-1',
      files: [
        { path: 'src/app.txt', before: 'old-app', after: 'new-app' },
        { path: 'src/nested/created.txt', after: 'hello' },
      ],
    },
    { root },
  )

  assert.equal(await readText(root, 'src/app.txt'), 'new-app')
  assert.equal(await readText(root, 'src/nested/created.txt'), 'hello')
  assert.equal(journal.id, 'patch-write')
  assert.equal(journal.status, 'applied')
  assert.equal(journal.applied, true)
  assert.equal(
    journal.journalPath,
    path.join(root, '.dsh-os-lease', 'journal', 'patch-write', 'journal.json'),
  )
  assert.equal(journal.leaseId, 'lease-1')

  const existing = journal.files.find((file) => file.path === 'src/app.txt')
  assert.equal(existing.existed, true)
  assert.equal(existing.beforeMatches, true)
  assert.equal(existing.backup, 'backups/0000.before')
  assert.equal(await fs.readFile(existing.backupPath, 'utf8'), 'old-app')
  const created = journal.files.find((file) => file.path === 'src/nested/created.txt')
  assert.equal(created.existed, false)
  assert.equal(created.backup, null)

  const read = await readJournal('patch-write', { root })
  assert.equal(read.status, 'applied')
  assert.equal(read.journalPath, journal.journalPath)
  assert.deepEqual(
    read.files.map((file) => file.path),
    ['src/app.txt', 'src/nested/created.txt'],
  )
  assert.equal(await fs.readFile(read.files[0].backupPath, 'utf8'), 'old-app')
})

test('atomic replacement preserves the file mode and leaves no temp files behind', async (t) => {
  const root = await makeRoot(t)
  const target = await writeText(root, 'bin/tool.txt', 'old')
  await fs.chmod(target, 0o640)

  await applyPatchset(
    { id: 'patch-atomic', files: [{ path: 'bin/tool.txt', after: 'new' }] },
    { root },
  )

  assert.equal(await readText(root, 'bin/tool.txt'), 'new')
  const stat = await fs.stat(target)
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o640)
  const entries = await fs.readdir(absolute(root, 'bin'))
  assert.equal(
    entries.some((entry) => entry.includes('.dsh-os-lease-tmp-')),
    false,
  )
})

test('absolute paths, traversal, reserved state paths, and symlink escapes are rejected', async (t) => {
  const root = await makeRoot(t)
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-os-lease-outside-'))
  t.after(async () => {
    await fs.rm(outside, { recursive: true, force: true })
  })
  const realOutside = await fs.realpath(outside)

  await assertApplyCode(
    applyPatchset({ id: 'abs', files: [{ path: '/etc/passwd', after: 'x' }] }, { root }),
    'INVALID_PATH',
  )
  await assertApplyCode(
    applyPatchset({ id: 'up', files: [{ path: '../escape.txt', after: 'x' }] }, { root }),
    'INVALID_PATH',
  )
  await assertApplyCode(
    applyPatchset({ id: 'drive', files: [{ path: 'C:\\temp\\x', after: 'x' }] }, { root }),
    'INVALID_PATH',
  )
  await assertApplyCode(
    applyPatchset(
      { id: 'state', files: [{ path: '.dsh-os-lease/journal/x', after: 'x' }] },
      { root },
    ),
    'RESERVED_PATH',
  )

  try {
    await fs.symlink(realOutside, absolute(root, 'linkdir'), 'dir')
  } catch (error) {
    if (error instanceof Error && error.code === 'EPERM') {
      t.skip('creating symlinks is not permitted on this platform')
      return
    }
    throw error
  }
  await fs.writeFile(path.join(realOutside, 'secret.txt'), 'secret')
  await fs.symlink(path.join(realOutside, 'secret.txt'), absolute(root, 'linkfile'))

  await assertApplyCode(
    applyPatchset(
      { id: 'linkdir', files: [{ path: 'linkdir/evil.txt', after: 'x' }] },
      { root },
    ),
    'PATH_ESCAPE',
  )
  await assertApplyCode(
    applyPatchset({ id: 'linkfile', files: [{ path: 'linkfile', after: 'x' }] }, { root }),
    'PATH_ESCAPE',
  )
  assert.equal(await fs.readFile(path.join(realOutside, 'secret.txt'), 'utf8'), 'secret')
  await assert.rejects(fs.stat(path.join(realOutside, 'evil.txt')), { code: 'ENOENT' })
})

test('rollback restores pre-images, deletes new files, and removes created directories', async (t) => {
  const root = await makeRoot(t)
  await writeText(root, 'keep.txt', 'before')

  const journal = await applyPatchset(
    {
      id: 'patch-rollback',
      files: [
        { path: 'keep.txt', before: 'before', after: 'after' },
        { path: 'new/a.txt', after: 'a' },
        { path: 'new/deep/b.txt', after: 'b' },
      ],
    },
    { root },
  )
  assert.equal(await readText(root, 'keep.txt'), 'after')
  assert.equal(await readText(root, 'new/deep/b.txt'), 'b')

  const result = await rollback(journal.journalPath)
  assert.equal(result.id, 'patch-rollback')
  assert.equal(result.status, 'rolledBack')
  assert.equal(result.alreadyRolledBack, false)
  assert.deepEqual(result.restored, ['keep.txt'])
  assert.deepEqual(result.deleted, ['new/a.txt', 'new/deep/b.txt'])

  assert.equal(await readText(root, 'keep.txt'), 'before')
  await assert.rejects(fs.stat(absolute(root, 'new/deep/b.txt')), { code: 'ENOENT' })
  await assert.rejects(fs.stat(absolute(root, 'new/a.txt')), { code: 'ENOENT' })
  await assert.rejects(fs.stat(absolute(root, 'new')), { code: 'ENOENT' })

  const read = await readJournal('patch-rollback', { root })
  assert.equal(read.status, 'rolledBack')
  assert.ok(read.rolledBackAt)
})

test('rollback is idempotent for journal objects and journal paths', async (t) => {
  const root = await makeRoot(t)
  await writeText(root, 'a.txt', 'old')
  const journal = await applyPatchset(
    {
      id: 'patch-idem',
      files: [
        { path: 'a.txt', before: 'old', after: 'new' },
        { path: 'b.txt', after: 'new-file' },
      ],
    },
    { root },
  )

  const first = await rollback(journal)
  assert.equal(first.alreadyRolledBack, false)
  assert.equal(await readText(root, 'a.txt'), 'old')

  const second = await rollback(journal)
  assert.equal(second.alreadyRolledBack, true)
  assert.equal(await readText(root, 'a.txt'), 'old')

  const third = await rollback(journal.journalPath)
  assert.equal(third.alreadyRolledBack, true)
  await assert.rejects(fs.stat(absolute(root, 'b.txt')), { code: 'ENOENT' })
})

test('rollback reports a missing backup precisely and can be retried after repair', async (t) => {
  const root = await makeRoot(t)
  await writeText(root, 'a.txt', 'old')
  const journal = await applyPatchset(
    { id: 'patch-missing', files: [{ path: 'a.txt', before: 'old', after: 'new' }] },
    { root },
  )
  const backupPath = journal.files[0].backupPath
  const saved = await fs.readFile(backupPath)
  await fs.unlink(backupPath)

  await assert.rejects(rollback(journal), (error) => {
    assert.equal(error.name, 'ApplyError')
    assert.equal(error.code, 'ROLLBACK_FAILED')
    assert.match(error.message, /failed/)
    assert.equal(error.details.failures.length, 1)
    assert.equal(error.details.failures[0].path, 'a.txt')
    assert.equal(error.details.failures[0].code, 'BACKUP_MISSING')
    return true
  })
  assert.equal((await readJournal('patch-missing', { root })).status, 'rollbackFailed')

  await fs.writeFile(backupPath, saved)
  const retried = await rollback(journal)
  assert.equal(retried.status, 'rolledBack')
  assert.equal(await readText(root, 'a.txt'), 'old')
})

test('a second apply with the same journal id is rejected before touching the tree', async (t) => {
  const root = await makeRoot(t)
  await applyPatchset(
    { id: 'patch-once', files: [{ path: 'a.txt', after: 'first' }] },
    { root },
  )

  await assertApplyCode(
    applyPatchset({ id: 'patch-once', files: [{ path: 'a.txt', after: 'second' }] }, { root }),
    'ALREADY_APPLIED',
  )
  assert.equal(await readText(root, 'a.txt'), 'first')
})

test('overlapping applies are excluded by per-path lock files', async (t) => {
  const root = await makeRoot(t)
  const lockPath = lockPathFor(root, 'a.txt')
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  await fs.writeFile(
    lockPath,
    `${JSON.stringify({ pid: process.pid, path: 'a.txt' })}\n`,
  )

  await assert.rejects(
    applyPatchset({ id: 'patch-locked', files: [{ path: 'a.txt', after: 'x' }] }, { root }),
    (error) => {
      assert.equal(error.name, 'ApplyError')
      assert.equal(error.code, 'LOCKED')
      assert.equal(error.details.path, 'a.txt')
      assert.equal(error.details.lockPath, lockPath)
      return true
    },
  )
  // A disjoint path is not blocked by the lock.
  const disjoint = await applyPatchset(
    { id: 'patch-disjoint', files: [{ path: 'b.txt', after: 'b' }] },
    { root },
  )
  assert.equal(disjoint.status, 'applied')
  assert.equal(await readText(root, 'b.txt'), 'b')

  await fs.unlink(lockPath)
  const retried = await applyPatchset(
    { id: 'patch-locked', files: [{ path: 'a.txt', after: 'x' }] },
    { root },
  )
  assert.equal(retried.status, 'applied')
  assert.equal(await readText(root, 'a.txt'), 'x')
})

test('two applies that start together cannot both hold the same path', async (t) => {
  const root = await makeRoot(t)
  const largeBody = 'x'.repeat(2 * 1024 * 1024)
  const first = applyPatchset(
    { id: 'patch-race-a', files: [{ path: 'race.txt', after: largeBody }] },
    { root },
  )
  const second = applyPatchset(
    { id: 'patch-race-b', files: [{ path: 'race.txt', after: 'y' }] },
    { root },
  )

  const results = await Promise.allSettled([first, second])
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.name, 'ApplyError')
  assert.equal(rejected[0].reason.code, 'LOCKED')

  const content = await readText(root, 'race.txt')
  assert.ok(content === 'y' || content === largeBody)
})

test('verifyBefore rejects a stale caller pre-image and leaves no journal behind', async (t) => {
  const root = await makeRoot(t)
  await writeText(root, 'a.txt', 'actual')

  await assertApplyCode(
    applyPatchset(
      {
        id: 'patch-mismatch',
        files: [{ path: 'a.txt', before: 'stale', after: 'new' }],
      },
      { root, verifyBefore: true },
    ),
    'BEFORE_MISMATCH',
  )
  assert.equal(await readText(root, 'a.txt'), 'actual')
  await assertApplyCode(readJournal('patch-mismatch', { root }), 'NOT_FOUND')

  // Without verifyBefore the write proceeds; the journal records the mismatch
  // and still backs up the real on-disk pre-image.
  const journal = await applyPatchset(
    {
      id: 'patch-mismatch-allowed',
      files: [{ path: 'a.txt', before: 'stale', after: 'new' }],
    },
    { root },
  )
  assert.equal(journal.files[0].beforeMatches, false)
  assert.equal(await fs.readFile(journal.files[0].backupPath, 'utf8'), 'actual')
})

test('readJournal reports missing and path-tampered journals', async (t) => {
  const root = await makeRoot(t)
  await assertApplyCode(readJournal('does-not-exist', { root }), 'NOT_FOUND')

  const journal = await applyPatchset(
    { id: 'patch-corrupt', files: [{ path: 'a.txt', after: 'a' }] },
    { root },
  )
  const manifest = JSON.parse(await fs.readFile(journal.journalPath, 'utf8'))
  manifest.files[0].path = '../escape.txt'
  await fs.writeFile(journal.journalPath, JSON.stringify(manifest))
  await assertApplyCode(readJournal('patch-corrupt', { root }), 'JOURNAL_CORRUPT')
})

test('a directory target is refused rather than replaced', async (t) => {
  const root = await makeRoot(t)
  await fs.mkdir(absolute(root, 'dir-target'))
  await assertApplyCode(
    applyPatchset({ id: 'patch-dir', files: [{ path: 'dir-target', after: 'x' }] }, { root }),
    'NOT_A_FILE',
  )
  assert.equal((await fs.stat(absolute(root, 'dir-target'))).isDirectory(), true)
})

test('applyPatchset accepts a custom lockProvider and releases after the apply', async (t) => {
  const root = await makeRoot(t)
  const provider = new MemoryLockProvider()
  const held = await provider.acquire('a.txt', { ttlMs: 60_000, owner: 'other-agent' })

  const calls = []
  const acquire = provider.acquire.bind(provider)
  provider.acquire = async (key, options) => {
    calls.push({ key, ...options })
    return acquire(key, options)
  }

  await assert.rejects(
    applyPatchset(
      { id: 'patch-custom-lock', files: [{ path: 'a.txt', after: 'x' }] },
      { root, lockProvider: provider },
    ),
    (error) => {
      assert.equal(error.name, 'ApplyError')
      assert.equal(error.code, 'LOCKED')
      assert.equal(error.details.path, 'a.txt')
      assert.equal(error.details.owner, 'other-agent')
      assert.equal(typeof error.details.expiresAt, 'number')
      return true
    },
  )
  await provider.release(held)

  const journal = await applyPatchset(
    { id: 'patch-custom-lock', files: [{ path: 'a.txt', after: 'x' }] },
    { root, lockProvider: provider, lockTtlMs: 4321, lockOwner: 'host-a/agent-1' },
  )
  assert.equal(journal.status, 'applied')
  assert.deepEqual(calls.at(-1), { key: 'a.txt', ttlMs: 4321, owner: 'host-a/agent-1' })
  assert.equal((await provider.inspect('a.txt')).locked, false)

  await assertApplyCode(
    applyPatchset(
      { id: 'patch-bad-provider', files: [{ path: 'b.txt', after: 'b' }] },
      { root, lockProvider: {} },
    ),
    'INVALID_ARGUMENT',
  )
})

test('a dependency-free custom provider can signal LOCKED with owner/expiresAt', async (t) => {
  const root = await makeRoot(t)
  const expiresAt = Date.now() + 60_000
  // A custom provider is not required to import LockError: a string `code` and
  // a `details` object are enough for the applier to preserve holder identity.
  const provider = {
    async acquire() {
      const error = new Error('held by custom adapter')
      error.code = 'LOCKED'
      error.details = { owner: 'custom/agent', expiresAt }
      throw error
    },
    async renew() {},
    async release() {},
    async inspect() {
      return { locked: false }
    },
  }

  await assert.rejects(
    applyPatchset(
      { id: 'patch-custom-error', files: [{ path: 'a.txt', after: 'x' }] },
      { root, lockProvider: provider },
    ),
    (error) => {
      assert.equal(error.name, 'ApplyError')
      assert.equal(error.code, 'LOCKED')
      assert.equal(error.details.path, 'a.txt')
      assert.equal(error.details.owner, 'custom/agent')
      assert.equal(error.details.expiresAt, expiresAt)
      return true
    },
  )
  await assert.rejects(fs.stat(absolute(root, 'a.txt')), { code: 'ENOENT' })
})

test('the default file lock lives under .dsh-os-lease/locks and reports holder metadata', async (t) => {
  const root = await makeRoot(t)
  const lockPath = lockPathFor(root, 'a.txt')
  const provider = new FileLockProvider({ dir: path.dirname(lockPath) })
  const handle = await provider.acquire('a.txt', { ttlMs: 60_000, owner: 'host-b/agent-2' })

  await assert.rejects(
    applyPatchset(
      { id: 'patch-default-lock', files: [{ path: 'a.txt', after: 'x' }] },
      { root },
    ),
    (error) => {
      assert.equal(error.name, 'ApplyError')
      assert.equal(error.code, 'LOCKED')
      assert.equal(error.details.path, 'a.txt')
      assert.equal(error.details.owner, 'host-b/agent-2')
      assert.equal(error.details.expiresAt, handle.expiresAt)
      assert.equal(error.details.lockPath, lockPath)
      return true
    },
  )

  const record = JSON.parse(await fs.readFile(lockPath, 'utf8'))
  assert.equal(record.owner, 'host-b/agent-2')
  assert.equal(record.expiresAt, handle.expiresAt)

  await provider.release(handle)
  const journal = await applyPatchset(
    { id: 'patch-default-lock', files: [{ path: 'a.txt', after: 'x' }] },
    { root },
  )
  assert.equal(journal.status, 'applied')
  assert.equal(await readText(root, 'a.txt'), 'x')
  assert.equal((await provider.inspect('a.txt')).locked, false)
})

test('ApplyError carries a stable name and code', () => {
  const error = new ApplyError('LOCKED', 'nope', { path: 'a' })
  assert.equal(error.name, 'ApplyError')
  assert.equal(error.code, 'LOCKED')
  assert.deepEqual(error.details, { path: 'a' })
})
