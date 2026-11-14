import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../src/index.js'

/**
 * Minimal fake Cordis context: the plugin only needs `ctx.tools.register`.
 */
function fakeContext() {
  const registered = new Map()
  return {
    registered,
    ctx: {
      tools: {
        register(tool) {
          assert.equal(registered.has(tool.name), false, `duplicate tool ${tool.name}`)
          registered.set(tool.name, tool)
        },
      },
    },
  }
}

test('registers the four quota tools with schemas and renderers', () => {
  const { ctx, registered } = fakeContext()
  const governor = apply(ctx)

  assert.equal(name, 'dsh-os-quota')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof governor.admit, 'function')
  assert.deepEqual([...registered.keys()], [
    'quota_status',
    'quota_set',
    'quota_admit',
    'quota_consume',
  ])

  for (const tool of registered.values()) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }

  assert.deepEqual(registered.get('quota_set').parameters.required, ['scope'])
  assert.deepEqual(registered.get('quota_admit').parameters.required, ['scope'])
  assert.deepEqual(registered.get('quota_consume').parameters.required, ['scope'])
})

test('quota tools share one governor and report ok, soft, hard and overage', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx)
  const set = registered.get('quota_set')
  const admit = registered.get('quota_admit')
  const consume = registered.get('quota_consume')
  const status = registered.get('quota_status')

  const configured = await set.execute({ scope: 's', tokens: 100, jobs: 2, diskMb: 10 }, {})
  assert.equal(configured.limits.tokens, 100)

  const ok = await admit.execute({ scope: 's', tokens: 40 }, {})
  assert.equal(ok.allowed, true)
  assert.equal(ok.level, 'ok')

  const soft = await admit.execute({ scope: 's', tokens: 90 }, {})
  assert.equal(soft.allowed, true)
  assert.equal(soft.level, 'soft')
  assert.equal(soft.degrade, true)

  const denied = await admit.execute({ scope: 's', tokens: 120 }, {})
  assert.equal(denied.allowed, false)
  assert.equal(denied.reason, 'hard-limit')

  const booked = await consume.execute({ scope: 's', tokens: 110 }, {})
  assert.equal(booked.allowed, false)
  assert.equal(booked.used.tokens, 110)
  assert.equal(booked.overBy.tokens, 10)

  const read = await status.execute({ scope: 's' }, {})
  assert.equal(read.used.tokens, 110)
  assert.equal(read.level, 'hard')

  const all = await status.execute({}, {})
  assert.equal(all.scopes.length, 1)
  assert.equal(all.scopes[0].scope, 's')
})

test('tool output is JSON-renderable and serializes unlimited budgets as null', async () => {
  const { ctx, registered } = fakeContext()
  apply(ctx)
  const set = registered.get('quota_set')
  const status = registered.get('quota_status')

  await set.execute({ scope: 's', tokens: null, jobs: 2 }, {})
  const snapshot = await status.execute({ scope: 's' }, {})
  const rendered = status.output.render({ scope: 's' }, snapshot)

  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  const parsed = JSON.parse(rendered[0].text)
  assert.equal(parsed.scope, 's')
  assert.equal(parsed.limits.tokens, null) // Infinity -> null on the wire
  assert.equal(parsed.limits.jobs, 2)
  assert.equal(parsed.remaining.tokens, null)
  assert.equal(parsed.level, 'ok')
})
