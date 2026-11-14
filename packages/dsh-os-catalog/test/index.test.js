import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'

function fakeContext() {
  /** @type {Map<string, any>} */
  const tools = new Map()
  return {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    toolsMap: tools,
  }
}

test('apply registers exactly the three catalog tools', () => {
  const ctx = fakeContext()
  apply(ctx)

  assert.deepEqual(
    [...ctx.toolsMap.keys()].sort(),
    ['capability_preflight', 'capability_register', 'capability_search'],
  )
  for (const definition of ctx.toolsMap.values()) {
    assert.ok(definition.description.length > 0)
    assert.ok(definition.parameters)
    assert.ok(definition.output?.schema)
  }
})

test('register, search, and preflight work through the tool layer', async () => {
  const ctx = fakeContext()
  apply(ctx)

  const register = ctx.toolsMap.get('capability_register')
  const search = ctx.toolsMap.get('capability_search')
  const preflight = ctx.toolsMap.get('capability_preflight')

  const registered = await register.execute({
    id: 'pdf.convert',
    name: 'PDF convert',
    kind: 'tool',
    intents: ['convert markdown to pdf'],
    inputs: ['markdown'],
    outputs: ['pdf'],
    permissions: ['fs.read', 'fs.write'],
    cost: 'cheap',
    meta: { owner: 'docs-team' },
  })
  assert.equal(registered.registered, true)
  assert.equal(registered.capability.id, 'pdf.convert')
  assert.deepEqual(registered.capability.meta, { owner: 'docs-team' })

  const found = await search.execute({ intent: 'convert markdown' })
  assert.equal(found.total, 1)
  assert.equal(found.items[0].cap.id, 'pdf.convert')
  assert.ok(found.items[0].why.length > 0)

  const blocked = await preflight.execute({ id: 'pdf.convert', grantedPermissions: ['fs.read'] })
  assert.equal(blocked.ok, false)
  assert.deepEqual(blocked.missingPermissions, ['fs.write'])

  const ok = await preflight.execute({
    id: 'pdf.convert',
    grantedPermissions: ['fs.read', 'fs.write'],
    maxCost: 'cheap',
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.blockers, [])

  await assert.rejects(
    register.execute({ id: 'pdf.convert', kind: 'tool' }),
    /already registered/,
  )
})

test('config capabilities seed the catalog at apply time', async () => {
  const ctx = fakeContext()
  apply(ctx, {
    capabilities: [
      {
        id: 'mcp.github',
        name: 'GitHub MCP',
        kind: 'mcp',
        intents: ['open a pull request'],
        permissions: ['net.fetch'],
        cost: 'expensive',
        health: 'degraded',
      },
    ],
  })

  const found = await ctx.toolsMap.get('capability_search').execute({ intent: 'pull request' })
  assert.equal(found.total, 1)
  assert.equal(found.items[0].cap.kind, 'mcp')

  const preflight = await ctx.toolsMap
    .get('capability_preflight')
    .execute({ id: 'mcp.github', grantedPermissions: ['net.fetch'] })
  assert.equal(preflight.ok, true)
  assert.ok(preflight.warnings.some((warning) => warning.code === 'health-degraded'))
})
