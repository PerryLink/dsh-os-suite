import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, inject, name } from '../src/index.js'
import { MemoryLockProvider } from '../src/lock.js'

/**
 * @param {object} [config]
 * @returns {Map<string, any>}
 */
function loadTools(config) {
  /** @type {Map<string, any>} */
  const tools = new Map()
  const ctx = {
    tools: {
      register: (tool) => tools.set(tool.name, tool),
    },
  }
  if (config === undefined) apply(ctx)
  else apply(ctx, config)
  return tools
}

/**
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>}
 */
async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-os-lease-index-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  return fs.realpath(root)
}

test('apply registers the four workspace tools', () => {
  const tools = loadTools()

  assert.equal(name, 'dsh-os-lease')
  assert.deepEqual(inject, ['tools'])
  assert.deepEqual([...tools.keys()].sort(), [
    'workspace_apply',
    'workspace_lease',
    'workspace_rollback',
    'workspace_status',
  ])
})

test('workspace_apply is dry-run by default and never creates files', async (t) => {
  const root = await makeRoot(t)
  const tools = loadTools()

  const acquired = await tools.get('workspace_lease').execute({
    action: 'acquire',
    workspace: '/repo',
    paths: ['src'],
    owner: 'agent-1',
  })
  const prepared = await tools.get('workspace_apply').execute({
    action: 'prepare',
    leaseId: acquired.lease.id,
    files: [{ path: 'src/a.txt', after: 'new' }],
  })
  const committed = await tools.get('workspace_apply').execute({
    action: 'commit',
    patchsetId: prepared.patchset.id,
  })

  assert.equal(committed.applied, undefined)
  assert.deepEqual(committed.writes, [{ path: 'src/a.txt', after: 'new' }])
  await assert.rejects(fs.stat(path.join(root, 'src/a.txt')), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(root, '.dsh-os-lease')), { code: 'ENOENT' })

  const rolledBack = await tools.get('workspace_rollback').execute({
    patchsetId: prepared.patchset.id,
  })
  assert.equal(rolledBack.status, 'rolledBack')
  assert.deepEqual(rolledBack.restores, [{ path: 'src/a.txt' }])
})

test('config apply:true + root writes the patchset and rollback restores it', async (t) => {
  const root = await makeRoot(t)
  await fs.writeFile(path.join(root, 'keep.txt'), 'old')
  const tools = loadTools({ apply: true, root })

  const acquired = await tools.get('workspace_lease').execute({
    action: 'acquire',
    workspace: '/repo',
    paths: ['keep.txt', 'new'],
    owner: 'agent-1',
  })
  const prepared = await tools.get('workspace_apply').execute({
    action: 'prepare',
    leaseId: acquired.lease.id,
    files: [
      { path: 'keep.txt', before: 'old', after: 'new' },
      { path: 'new/file.txt', after: 'created' },
    ],
  })
  const committed = await tools.get('workspace_apply').execute({
    action: 'commit',
    patchsetId: prepared.patchset.id,
  })

  assert.equal(committed.applied, true)
  assert.equal(committed.journal.status, 'applied')
  assert.equal(await fs.readFile(path.join(root, 'keep.txt'), 'utf8'), 'new')
  assert.equal(await fs.readFile(path.join(root, 'new/file.txt'), 'utf8'), 'created')

  const rolledBack = await tools.get('workspace_rollback').execute({
    patchsetId: prepared.patchset.id,
  })
  assert.equal(rolledBack.status, 'rolledBack')
  assert.equal(rolledBack.appliedRollback, true)
  assert.equal(await fs.readFile(path.join(root, 'keep.txt'), 'utf8'), 'old')
  await assert.rejects(fs.stat(path.join(root, 'new/file.txt')), { code: 'ENOENT' })
})

test('config apply:true without root is rejected at registration', () => {
  assert.throws(
    () => loadTools({ apply: true }),
    /config\.apply=true requires config\.root/,
  )
  assert.throws(
    () => loadTools({ apply: true, root: '/tmp', lockProvider: {} }),
    /config\.lockProvider is invalid/,
  )
  assert.throws(() => loadTools({ lockTtlMs: 0 }), /config\.lockTtlMs must be a positive number/)
  assert.throws(
    () => loadTools({ lockOwner: '' }),
    /config\.lockOwner must be a 1-256 character string/,
  )
})

test('config lockProvider is honored by workspace_apply and released afterwards', async (t) => {
  const root = await makeRoot(t)
  const provider = new MemoryLockProvider()
  const tools = loadTools({
    apply: true,
    root,
    lockProvider: provider,
    lockTtlMs: 5000,
    lockOwner: 'host-a/agent-1',
  })

  const firstLease = await tools.get('workspace_lease').execute({
    action: 'acquire',
    workspace: '/repo',
    paths: ['a.txt'],
    owner: 'agent-1',
  })
  const firstPrepared = await tools.get('workspace_apply').execute({
    action: 'prepare',
    leaseId: firstLease.lease.id,
    files: [{ path: 'a.txt', after: 'a' }],
  })
  const firstCommit = await tools.get('workspace_apply').execute({
    action: 'commit',
    patchsetId: firstPrepared.patchset.id,
  })
  assert.equal(firstCommit.applied, true)
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'a')
  assert.equal((await provider.inspect('a.txt')).locked, false)

  // A lock held by another host makes commit fail before any write.
  const held = await provider.acquire('b.txt', { ttlMs: 5000, owner: 'host-b/agent-2' })
  const secondLease = await tools.get('workspace_lease').execute({
    action: 'acquire',
    workspace: '/repo',
    paths: ['b.txt'],
    owner: 'agent-1',
  })
  const secondPrepared = await tools.get('workspace_apply').execute({
    action: 'prepare',
    leaseId: secondLease.lease.id,
    files: [{ path: 'b.txt', after: 'b' }],
  })
  await assert.rejects(
    tools.get('workspace_apply').execute({
      action: 'commit',
      patchsetId: secondPrepared.patchset.id,
    }),
    (error) => {
      assert.equal(error.code, 'LOCKED')
      assert.equal(error.details.owner, 'host-b/agent-2')
      return true
    },
  )
  await assert.rejects(fs.stat(path.join(root, 'b.txt')), { code: 'ENOENT' })
  await provider.release(held)
})

test('workspace_rollback without a journal still returns the plan', async (t) => {
  const root = await makeRoot(t)
  const tools = loadTools({ root })

  const acquired = await tools.get('workspace_lease').execute({
    action: 'acquire',
    workspace: '/repo',
    paths: ['a.txt'],
    owner: 'agent-1',
  })
  const prepared = await tools.get('workspace_apply').execute({
    action: 'prepare',
    leaseId: acquired.lease.id,
    files: [{ path: 'a.txt', after: 'a' }],
  })
  await tools.get('workspace_apply').execute({
    action: 'commit',
    patchsetId: prepared.patchset.id,
  })

  const rolledBack = await tools.get('workspace_rollback').execute({
    patchsetId: prepared.patchset.id,
  })
  assert.equal(rolledBack.status, 'rolledBack')
  assert.equal(rolledBack.appliedRollback, false)
  await assert.rejects(fs.stat(path.join(root, 'a.txt')), { code: 'ENOENT' })
})

test('a reused patchset id with an existing journal is refused without writes', async (t) => {
  const root = await makeRoot(t)
  const first = loadTools({ apply: true, root })
  const firstLease = await first.get('workspace_lease').execute({
    action: 'acquire',
    workspace: '/repo',
    paths: ['a.txt'],
    owner: 'agent-1',
  })
  const firstPrepared = await first.get('workspace_apply').execute({
    action: 'prepare',
    leaseId: firstLease.lease.id,
    files: [{ path: 'a.txt', after: 'one' }],
  })
  await first.get('workspace_apply').execute({
    action: 'commit',
    patchsetId: firstPrepared.patchset.id,
  })

  // A fresh plugin instance restarts its patchset sequence at 1. The old
  // journal is still on disk, so the new apply must refuse before writing.
  const second = loadTools({ apply: true, root })
  const secondLease = await second.get('workspace_lease').execute({
    action: 'acquire',
    workspace: '/repo',
    paths: ['b.txt'],
    owner: 'agent-2',
  })
  const secondPrepared = await second.get('workspace_apply').execute({
    action: 'prepare',
    leaseId: secondLease.lease.id,
    files: [{ path: 'b.txt', after: 'two' }],
  })
  assert.equal(secondPrepared.patchset.id, 'patchset-1')

  await assert.rejects(
    second.get('workspace_apply').execute({
      action: 'commit',
      patchsetId: secondPrepared.patchset.id,
    }),
    (error) => {
      assert.equal(error.code, 'ALREADY_APPLIED')
      return true
    },
  )
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one')
  await assert.rejects(fs.stat(path.join(root, 'b.txt')), { code: 'ENOENT' })
  const oldJournal = JSON.parse(
    await fs.readFile(
      path.join(root, '.dsh-os-lease', 'journal', 'patchset-1', 'journal.json'),
      'utf8',
    ),
  )
  assert.equal(oldJournal.status, 'applied')
  const status = await second.get('workspace_status').execute({})
  assert.equal(status.counts.patchsets.rolledBack, 1)
})
