import test from 'node:test'
import assert from 'node:assert/strict'
import { childrenByParent } from '../src/core.js'

test('groups children by parent', () => {
  const map = childrenByParent([
    { id: 'a' },
    { id: 'b', parentId: 'a' },
  ])
  assert.equal(map.get('')?.length, 1)
  assert.equal(map.get('a')?.length, 1)
})
