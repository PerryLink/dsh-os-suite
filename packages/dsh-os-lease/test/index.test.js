import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../src/index.js'

test('apply registers the four workspace tools', () => {
  const tools = []
  apply({ tools: { register: (tool) => tools.push(tool.name) } })

  assert.equal(name, 'dsh-os-lease')
  assert.deepEqual(inject, ['tools'])
  assert.deepEqual(tools.sort(), [
    'workspace_apply',
    'workspace_lease',
    'workspace_rollback',
    'workspace_status',
  ])
})
