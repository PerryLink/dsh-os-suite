import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CatalogError,
  createCatalog,
  permissionCovered,
} from '../src/core.js'

/**
 * @param {object} overrides
 */
function makeCap(overrides) {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    kind: overrides.kind ?? 'tool',
    intents: overrides.intents ?? [],
    inputs: overrides.inputs ?? [],
    outputs: overrides.outputs ?? [],
    permissions: overrides.permissions ?? [],
    cost: overrides.cost ?? 'free',
    health: overrides.health ?? 'ok',
    ...(overrides.meta !== undefined ? { meta: overrides.meta } : {}),
  }
}

test('register normalizes a manifest and rejects duplicate ids', () => {
  const catalog = createCatalog()
  const registered = catalog.register({
    id: '  pdf.convert  ',
    kind: 'tool',
    intents: ['convert markdown to pdf'],
  })

  assert.equal(registered.id, 'pdf.convert')
  assert.equal(registered.name, 'pdf.convert')
  assert.equal(registered.cost, 'cheap')
  assert.equal(registered.health, 'ok')
  assert.equal(catalog.list().length, 1)
  assert.equal(catalog.get('pdf.convert'), registered)
  assert.ok(Object.isFrozen(registered))
  assert.ok(Object.isFrozen(registered.intents))

  assert.throws(
    () => catalog.register({ id: 'pdf.convert', kind: 'tool' }),
    (error) => error instanceof CatalogError && error.code === 'DUPLICATE_ID',
  )
  assert.throws(
    () => catalog.register({ id: 'missing-kind' }),
    /capability\.kind is required/,
  )
  assert.throws(
    () => catalog.register({ id: 'bad-kind', kind: 'daemon' }),
    /capability\.kind/,
  )

  assert.equal(catalog.remove('pdf.convert'), true)
  assert.equal(catalog.remove('pdf.convert'), false)
  assert.equal(catalog.list().length, 0)
})

test('search ranks exact intent over prefix and substring', () => {
  const catalog = createCatalog([
    makeCap({ id: 'contains', name: 'Gamma', intents: ['latest'] }),
    makeCap({ id: 'prefix', name: 'Beta', intents: ['testing'] }),
    makeCap({ id: 'exact', name: 'Alpha', intents: ['test'] }),
  ])

  const result = catalog.search('test')
  assert.equal(result.total, 3)
  assert.deepEqual(
    result.items.map((hit) => hit.cap.id),
    ['exact', 'prefix', 'contains'],
  )
  assert.ok(result.items[0].score > result.items[1].score)
  assert.ok(result.items[1].score > result.items[2].score)
  assert.ok(result.items[0].why.some((reason) => reason.startsWith('intent exact')))
  assert.deepEqual(result.suggestions, [])
})

test('intent matches outrank name and input matches', () => {
  const catalog = createCatalog([
    makeCap({ id: 'by-input', name: 'Input only', inputs: ['deploy'] }),
    makeCap({ id: 'by-name', name: 'deploy helper', intents: ['misc'] }),
    makeCap({ id: 'by-intent', name: 'Alpha', intents: ['deploy'] }),
  ])

  const result = catalog.search('deploy')
  assert.deepEqual(
    result.items.map((hit) => hit.cap.id),
    ['by-intent', 'by-name', 'by-input'],
  )
  assert.ok(result.items[0].why.some((reason) => reason.startsWith('intent exact')))
  assert.ok(result.items[1].why.some((reason) => reason.startsWith('name exact')))
})

test('search filters by kind and truncates with total preserved', () => {
  const catalog = createCatalog([
    makeCap({ id: 'tool.a', name: 'Alpha', kind: 'tool', intents: ['inspect files'] }),
    makeCap({ id: 'mcp.b', name: 'Bravo', kind: 'mcp', intents: ['inspect files'] }),
    makeCap({ id: 'skill.c', name: 'Charlie', kind: 'skill', intents: ['inspect files'] }),
  ])

  assert.deepEqual(
    catalog.search('inspect', { kind: 'mcp' }).items.map((hit) => hit.cap.id),
    ['mcp.b'],
  )
  assert.deepEqual(
    catalog.search('inspect', { kind: ['tool', 'skill'] }).items.map((hit) => hit.cap.id),
    ['tool.a', 'skill.c'],
  )

  const limited = catalog.search('inspect', { limit: 2 })
  assert.equal(limited.items.length, 2)
  assert.equal(limited.total, 3)
})

test('search filters by maxCost and preflight blocks over-budget runs', () => {
  const catalog = createCatalog([
    makeCap({ id: 'free', name: 'Free', intents: ['convert'], cost: 'free' }),
    makeCap({ id: 'cheap', name: 'Cheap', intents: ['convert'], cost: 'cheap' }),
    makeCap({ id: 'expensive', name: 'Expensive', intents: ['convert'], cost: 'expensive' }),
  ])

  const affordable = catalog.search('convert', { maxCost: 'cheap' })
  assert.equal(affordable.total, 2)
  assert.deepEqual(
    affordable.items.map((hit) => hit.cap.id),
    ['free', 'cheap'],
  )

  const blocked = catalog.preflight('expensive', { maxCost: 'cheap' })
  assert.equal(blocked.ok, false)
  assert.ok(blocked.blockers.some((blocker) => blocker.code === 'cost-exceeds-budget'))
  assert.ok(!blocked.warnings.some((warning) => warning.code === 'cost-expensive'))

  const warned = catalog.preflight('expensive')
  assert.equal(warned.ok, true)
  assert.ok(warned.warnings.some((warning) => warning.code === 'cost-expensive'))
})

test('preflight blocks missing permissions and accepts coverage', () => {
  const catalog = createCatalog([
    makeCap({
      id: 'writer',
      name: 'Writer',
      intents: ['write a report'],
      permissions: ['fs.read', 'fs.write', 'net.fetch'],
    }),
  ])

  const partial = catalog.preflight('writer', { grantedPermissions: ['fs.read'] })
  assert.equal(partial.ok, false)
  assert.deepEqual(partial.missingPermissions, ['fs.write', 'net.fetch'])
  assert.equal(
    partial.blockers.filter((blocker) => blocker.code === 'missing-permission').length,
    2,
  )

  const exact = catalog.preflight('writer', {
    grantedPermissions: ['fs.read', 'fs.write', 'net.fetch'],
  })
  assert.equal(exact.ok, true)
  assert.deepEqual(exact.missingPermissions, [])

  const wildcard = catalog.preflight('writer', { grantedPermissions: ['*'] })
  assert.equal(wildcard.ok, true)

  const prefixed = catalog.preflight('writer', {
    grantedPermissions: ['fs.*', 'net.fetch'],
  })
  assert.equal(prefixed.ok, true)

  assert.equal(permissionCovered('fs.read', ['fs.*']), true)
  assert.equal(permissionCovered('net.fetch', ['fs.*']), false)
  assert.equal(permissionCovered('anything', ['*']), true)
  assert.equal(permissionCovered('fs.read', []), false)

  const permissionFiltered = catalog.search('write', {
    requirePermissions: ['fs.read', 'fs.write'],
  })
  assert.equal(permissionFiltered.total, 0)
  assert.equal(
    catalog.search('write', { requirePermissions: ['fs.read', 'fs.write', 'net.fetch'] }).total,
    1,
  )
})

test('degraded health warns, down health blocks, and search hides down by default', () => {
  const catalog = createCatalog([
    makeCap({ id: 'degraded', name: 'Degraded', intents: ['diagnose'], health: 'degraded' }),
    makeCap({ id: 'down', name: 'Down', intents: ['diagnose'], health: 'down' }),
    makeCap({ id: 'healthy', name: 'Healthy', intents: ['diagnose'], health: 'ok' }),
  ])

  const degraded = catalog.preflight('degraded')
  assert.equal(degraded.ok, true)
  assert.ok(degraded.warnings.some((warning) => warning.code === 'health-degraded'))
  assert.equal(degraded.blockers.length, 0)

  const down = catalog.preflight('down')
  assert.equal(down.ok, false)
  assert.ok(down.blockers.some((blocker) => blocker.code === 'health-down'))

  const visible = catalog.search('diagnose')
  assert.deepEqual(
    visible.items.map((hit) => hit.cap.id),
    ['healthy', 'degraded'],
  )

  const all = catalog.search('diagnose', { includeDown: true })
  assert.equal(all.total, 3)
  assert.ok(all.items.some((hit) => hit.cap.id === 'down'))

  assert.deepEqual(
    catalog.search('diagnose', { health: 'down' }).items.map((hit) => hit.cap.id),
    ['down'],
  )
  assert.deepEqual(
    catalog.search('diagnose', { health: 'degraded' }).items.map((hit) => hit.cap.id),
    ['degraded'],
  )
})

test('no matches return an empty items array plus browse suggestions', () => {
  const catalog = createCatalog([
    makeCap({
      id: 'pdf.convert',
      name: 'PDF convert',
      intents: ['convert markdown to pdf'],
      inputs: ['markdown'],
    }),
  ])

  const miss = catalog.search('quantum entanglement')
  assert.deepEqual(miss.items, [])
  assert.equal(miss.total, 0)
  assert.equal(miss.suggestions.length, 1)
  assert.equal(miss.suggestions[0].id, 'pdf.convert')
  assert.deepEqual(miss.suggestions[0].intents, ['convert markdown to pdf'])

  const empty = createCatalog().search('anything')
  assert.deepEqual(empty.items, [])
  assert.deepEqual(empty.suggestions, [])
})

test('blank intent browses candidates and unknown preflight ids are blockers', () => {
  const catalog = createCatalog([
    makeCap({ id: 'a', name: 'Alpha', intents: ['do alpha'] }),
    makeCap({ id: 'b', name: 'Beta', intents: ['do beta'] }),
  ])

  const browse = catalog.search('   ')
  assert.equal(browse.total, 2)
  assert.deepEqual(
    browse.items.map((hit) => hit.cap.id),
    ['a', 'b'],
  )
  assert.deepEqual(browse.items[0].why, ['browse: empty intent'])

  const unknown = catalog.preflight('does.not.exist')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.blockers[0].code, 'unknown-capability')
  assert.deepEqual(unknown.warnings, [])
  assert.equal(unknown.health, null)
})
