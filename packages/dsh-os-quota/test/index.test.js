import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name, QuotaDeniedError } from '../src/index.js'

/**
 * Minimal fake Cordis context: tool registration plus the event bus seam used
 * by the optional enforcement adapter.
 */
function fakeContext() {
  const registered = new Map()
  const handlers = new Map()
  const ctx = {
    registered,
    handlers,
    tools: {
      register(tool) {
        assert.equal(registered.has(tool.name), false, `duplicate tool ${tool.name}`)
        registered.set(tool.name, tool)
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
        return index >= 0
      }
    },
    off(event, handler) {
      const list = handlers.get(event) ?? []
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
      return index >= 0
    },
  }
  return { registered, handlers, ctx }
}

/** Run a `tools/pre-execute` waterfall chain in registration order. */
async function runPreExecute(handlers, call) {
  const chain = [...(handlers.get('tools/pre-execute') ?? [])]
  const step = async (index) => {
    if (index >= chain.length) return { kind: 'allow' }
    return chain[index](call, () => step(index + 1))
  }
  return step(0)
}

/** Synchronous emit helper for result observers. */
function emit(handlers, event, ...args) {
  for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
}

test('registers the four quota tools plus quota_enforce_status', () => {
  const { ctx, registered } = fakeContext()
  const governor = apply(ctx)

  assert.equal(name, 'dsh-os-quota')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof governor.admit, 'function')
  assert.equal(typeof governor.enforcer.preExecute, 'function')
  assert.deepEqual([...registered.keys()], [
    'quota_status',
    'quota_set',
    'quota_admit',
    'quota_consume',
    'quota_enforce_status',
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
  assert.equal(registered.get('quota_enforce_status').parameters.required, undefined)
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

test('enforce is off by default: no hooks attached and status reports detached', async () => {
  const { ctx, registered, handlers } = fakeContext()
  const governor = apply(ctx, { limits: { tokens: 100 } })

  assert.equal(handlers.size, 0)
  assert.equal(typeof governor.enforcer.attach, 'function')

  const status = await registered.get('quota_enforce_status').execute({}, {})
  assert.equal(status.enabled, false)
  assert.equal(status.attached, false)
  assert.equal(status.hooks.preExecute, false)
  assert.equal(status.counters.preExecute, 0)
})

test('enforce:true attaches a waterfall that denies hard calls and bypasses quota tools', async () => {
  const { ctx, registered, handlers } = fakeContext()
  apply(ctx, {
    now: 1000,
    enforce: true,
    limits: { tokens: 100 },
    costOf: { shell: 20 },
    scopes: [{ id: 'default', used: { tokens: 90 } }],
  })

  assert.equal(typeof handlers.get('tools/pre-execute')?.[0], 'function')

  const denied = await runPreExecute(handlers, { name: 'shell', callId: 'c1' })
  assert.equal(denied.kind, 'deny')
  assert.equal(denied.allow, false)
  assert.match(denied.reason, /hard limit/i)
  assert.match(denied.reason, /shell/)

  const bypassed = await runPreExecute(handlers, { name: 'quota_status', callId: 'c2' })
  assert.equal(bypassed.kind, 'allow')

  const status = await registered.get('quota_enforce_status').execute({}, {})
  assert.equal(status.enabled, true)
  assert.equal(status.attached, true)
  assert.equal(status.hooks.preExecute, true)
  assert.equal(status.counters.denied, 1)
  assert.equal(status.counters.bypassed, 1)
  assert.equal(status.scopes.length, 1)
  assert.equal(status.scopes[0].used.tokens, 90)
})

test('enforce object config consumes usage.tokens from tool results into its scope', async () => {
  const { ctx, registered, handlers } = fakeContext()
  const governor = apply(ctx, {
    now: 1000,
    enforce: { enabled: true, scope: 'team', costOf: { shell: 5 } },
  })

  emit(handlers, 'tools/result', { name: 'metered', callId: 'r1' }, { usage: { tokens: 11 } })
  assert.equal(governor.status('team').used.tokens, 11)

  emit(handlers, 'tools/result', { name: 'metered', callId: 'r2' }, { content: [] })
  assert.equal(governor.status('team').used.tokens, 11)

  const status = await registered.get('quota_enforce_status').execute({ scope: 'team' }, {})
  assert.equal(status.scopeStatus.used.tokens, 11)
  assert.equal(status.counters.consumed, 1)
  assert.equal(status.counters.skipped, 1)

  governor.enforcer.detach()
  emit(handlers, 'tools/result', { name: 'metered', callId: 'r3' }, { usage: { tokens: 7 } })
  assert.equal(governor.status('team').used.tokens, 11)
})

test('enforce object can throw QuotaDeniedError and expose the enforcer on governor', async () => {
  const { ctx, handlers } = fakeContext()
  const governor = apply(ctx, {
    now: 1000,
    enforce: { enabled: true, throwOnDeny: true },
    limits: { tokens: 0 },
    scopes: [{ id: 'default', used: { tokens: 1 } }],
  })

  await assert.rejects(
    runPreExecute(handlers, { name: 'shell', callId: 'c1' }),
    (error) => error instanceof QuotaDeniedError
      && error.code === 'QUOTA_HARD_LIMIT'
      && error.allow === false
      && error.scope === 'default',
  )
  assert.equal(governor.enforcer.attached, true)
  governor.enforcer.detach()
  assert.equal(governor.enforcer.attached, false)
})
