import test from 'node:test'
import assert from 'node:assert/strict'
import { createGovernor } from '../src/core.js'
import { createEnforcer, describeDenial, findUsage, QuotaDeniedError } from '../src/enforce.js'

/**
 * Minimal Cordis-like event bus. `on` returns a disposer, exactly like Cordis.
 */
function fakeCtx() {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      handlers,
      tools: { register() {} },
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
    },
  }
}

/** Run the registered `tools/pre-execute` chain with a default allow tail. */
async function runWaterfall(handlers, event, call) {
  const chain = [...(handlers.get(event) ?? [])]
  const step = async (index) => {
    if (index >= chain.length) return { kind: 'allow' }
    return chain[index](...call, () => step(index + 1))
  }
  return step(0)
}

/** Synchronous emit helper for result observers. */
function emit(handlers, event, ...args) {
  for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
}

/** Governor seeded with a scope at `used` against a token limit. */
function seededGovernor(used, limit = 100) {
  return createGovernor({
    now: 1000,
    limits: { tokens: limit },
    scopes: [{ id: 'default', used: { tokens: used } }],
  })
}

const allow = async () => ({ kind: 'allow' })

test('preExecute delegates to next exactly once on an ok projection', async () => {
  const governor = createGovernor({ now: 1000, limits: { tokens: 100 } })
  const enforcer = createEnforcer({ governor, now: 1000, costOf: { shell: 10 } })
  let calls = 0
  const downstream = { kind: 'allow', note: 'downstream' }

  const result = await enforcer.preExecute({ name: 'shell', callId: 'c1' }, async () => {
    calls += 1
    return downstream
  })

  assert.equal(calls, 1)
  assert.equal(result, downstream)
  const status = enforcer.status()
  assert.equal(status.counters.preExecute, 1)
  assert.equal(status.counters.allowed, 1)
  assert.equal(status.counters.denied, 0)
  assert.equal(status.last.kind, 'allow')
  assert.equal(status.last.tool, 'shell')
})

test('hard projection returns a DSH denial object and never calls next', async () => {
  const governor = seededGovernor(95)
  const observed = []
  const enforcer = createEnforcer({
    governor,
    now: 1000,
    costOf: { shell: 10 },
    onDeny: (...args) => observed.push(args),
  })
  let calls = 0

  const result = await enforcer.preExecute({ name: 'shell', callId: 'c1' }, async () => {
    calls += 1
    return { kind: 'allow' }
  })

  assert.equal(calls, 0)
  assert.equal(result.kind, 'deny')
  assert.equal(result.allow, false)
  assert.match(result.reason, /hard limit/i)
  assert.match(result.reason, /tokens 105 > limit 100/)
  assert.match(result.reason, /shell/)

  assert.equal(observed.length, 1)
  assert.equal(observed[0][0].level, 'hard')
  assert.equal(observed[0][0].reason, 'hard-limit')
  assert.equal(observed[0][1].name, 'shell')
  assert.ok(observed[0][2] instanceof QuotaDeniedError)

  // admit() is a projection: a denial must not book usage.
  assert.equal(governor.status('default').used.tokens, 95)
  assert.equal(enforcer.status().counters.denied, 1)
  assert.equal(enforcer.status().counters.allowed, 0)
})

test('soft projection delegates and marks degrade on the downstream allow', async () => {
  const governor = seededGovernor(85)
  const enforcer = createEnforcer({ governor, now: 1000, costOf: { shell: 10 } })

  const result = await enforcer.preExecute({ name: 'shell', callId: 'c1' }, async () => ({
    kind: 'allow',
    note: 'kept',
  }))

  assert.equal(result.kind, 'allow')
  assert.equal(result.allow, true)
  assert.equal(result.degrade, true)
  assert.equal(result.note, 'kept')
  assert.equal(enforcer.status().counters.degraded, 1)
  assert.equal(enforcer.status().last.kind, 'degrade')
})

test('a downstream deny is not rewritten into an allow by a soft projection', async () => {
  const governor = seededGovernor(85)
  const enforcer = createEnforcer({ governor, now: 1000, costOf: { shell: 10 } })

  const downstream = { kind: 'deny', reason: 'other policy' }
  const result = await enforcer.preExecute({ name: 'shell' }, async () => downstream)

  assert.equal(result, downstream)
  assert.equal(result.degrade, undefined)
})

test('throwOnDeny throws QuotaDeniedError and skips the downstream chain', async () => {
  const governor = seededGovernor(95)
  const enforcer = createEnforcer({
    governor,
    now: 1000,
    costOf: { shell: 10 },
    throwOnDeny: true,
  })
  let calls = 0

  await assert.rejects(
    enforcer.preExecute({ name: 'shell', callId: 'c1' }, async () => {
      calls += 1
      return { kind: 'allow' }
    }),
    (error) => error instanceof QuotaDeniedError
      && error.name === 'QuotaDeniedError'
      && error.code === 'QUOTA_HARD_LIMIT'
      && error.scope === 'default'
      && error.allow === false
      && error.decision.level === 'hard'
      && /hard limit/i.test(error.reason),
  )
  assert.equal(calls, 0)
})

test('cost estimates merge costOf, call.cost and direct call fields in order', async () => {
  const real = createGovernor({ now: 1000, limits: { tokens: 100 } })
  const requests = []
  const governor = {
    admit(request) {
      requests.push({ ...request })
      return real.admit(request)
    },
    consume(request) {
      return real.consume(request)
    },
    status(scope) {
      return real.status(scope)
    },
  }
  const enforcer = createEnforcer({ governor, now: 1000, costOf: { shell: 10, '*': 2 } })

  await enforcer.preExecute({ name: 'shell', cost: { tokens: 70 } }, allow)
  await enforcer.preExecute({ name: 'other' }, allow)
  await enforcer.preExecute({ name: 'shell', tokens: 30, jobs: 2, diskMb: 3 }, allow)

  assert.deepEqual(
    requests.map((request) => [request.scope, request.tokens, request.jobs, request.diskMb]),
    [
      ['default', 70, 0, 0],
      ['default', 2, 0, 0],
      ['default', 30, 2, 3],
    ],
  )
})

test('scope resolution prefers config, then call.scope, then arguments.scope', async () => {
  const requests = []
  const governor = {
    admit(request) {
      requests.push(request.scope)
      return { allowed: true, level: 'ok', degrade: false, scope: request.scope }
    },
    consume() {},
  }

  const fixed = createEnforcer({ governor, now: 1000, scope: 'fixed' })
  await fixed.preExecute({ name: 'x', scope: 'call', arguments: { scope: 'args' } }, allow)

  const perCall = createEnforcer({ governor, now: 1000 })
  await perCall.preExecute({ name: 'x', scope: 'call', arguments: { scope: 'args' } }, allow)
  await perCall.preExecute({ name: 'x', arguments: { scope: 'args' } }, allow)
  await perCall.preExecute({ name: 'x' }, allow)

  const resolved = createEnforcer({ governor, now: 1000, scope: (call) => `agent:${call.name}` })
  await resolved.preExecute({ name: 'lead' }, allow)

  assert.deepEqual(requests, ['fixed', 'call', 'args', 'default', 'agent:lead'])
})

test('quota_* tools and explicitly ignored tools bypass admission', async () => {
  const governor = seededGovernor(95)
  const enforcer = createEnforcer({ governor, now: 1000, costOf: { shell: 10 }, ignore: ['private_tool'] })
  let calls = 0
  const next = async () => {
    calls += 1
    return { kind: 'allow' }
  }

  assert.equal((await enforcer.preExecute({ name: 'quota_status' }, next)).kind, 'allow')
  assert.equal((await enforcer.preExecute({ name: 'quota_enforce_status' }, next)).kind, 'allow')
  assert.equal((await enforcer.preExecute({ name: 'private_tool' }, next)).kind, 'allow')
  assert.equal(calls, 3)
  assert.equal(enforcer.status().counters.bypassed, 3)

  const denied = await enforcer.preExecute({ name: 'shell' }, next)
  assert.equal(denied.kind, 'deny')
  assert.equal(calls, 3)
})

test('attach registers the waterfall and detach removes it and revives pass-through', async () => {
  const { ctx, handlers } = fakeCtx()
  const governor = seededGovernor(95)
  const enforcer = createEnforcer({ governor, now: 1000, costOf: { shell: 10 } })

  enforcer.attach(ctx)
  assert.equal(enforcer.attached, true)
  assert.equal(handlers.get('tools/pre-execute').length, 1)
  assert.equal(handlers.get('tools/result').length, 1)
  assert.equal(handlers.get('tool/result').length, 1)
  assert.equal(handlers.get('session/event').length, 1)

  const denied = await runWaterfall(handlers, 'tools/pre-execute', [
    { name: 'shell', callId: 'c1' },
  ])
  assert.equal(denied.kind, 'deny')
  assert.equal(denied.allow, false)

  enforcer.attach(ctx) // idempotent
  assert.equal(handlers.get('tools/pre-execute').length, 1)

  const stale = handlers.get('tools/pre-execute')[0]
  enforcer.detach()
  assert.equal(enforcer.attached, false)
  for (const event of ['tools/pre-execute', 'tools/result', 'tool/result', 'session/event']) {
    assert.equal(handlers.get(event).length, 0)
  }

  const allowed = await stale({ name: 'shell', callId: 'c2' }, allow)
  assert.equal(allowed.kind, 'allow')
  assert.equal(enforcer.status().hooks.preExecute, false)
})

test('attach falls back to ctx.tools.preExecute when ctx.on is absent', async () => {
  const registered = []
  let disposed = 0
  const ctx = {
    tools: {
      register() {},
      preExecute(handler) {
        registered.push(handler)
        return () => {
          disposed += 1
        }
      },
    },
  }
  const governor = seededGovernor(95)
  const enforcer = createEnforcer({ governor, now: 1000, costOf: { shell: 10 } })

  enforcer.attach(ctx)
  assert.equal(registered.length, 1)
  assert.equal(enforcer.attached, true)
  assert.equal(enforcer.status().hooks.preExecute, true)

  const denied = await registered[0]({ name: 'shell' }, allow)
  assert.equal(denied.kind, 'deny')

  enforcer.detach()
  assert.equal(disposed, 1)
  const allowed = await registered[0]({ name: 'shell' }, allow)
  assert.equal(allowed.kind, 'allow')
})

test('result usage.tokens is booked; results without usage are skipped', async () => {
  const { ctx, handlers } = fakeCtx()
  const governor = createGovernor({ now: 1000, limits: { tokens: 100 } })
  const enforcer = createEnforcer({ governor, now: 1000, scope: 'team' })
  enforcer.attach(ctx)

  emit(handlers, 'tools/result',
    { name: 'metered', callId: 'c1' },
    { usage: { tokens: 7, jobs: 1, diskMb: 2 } })
  assert.deepEqual(governor.status('team').used, { tokens: 7, jobs: 1, diskMb: 2 })

  emit(handlers, 'tools/result', { name: 'metered', callId: 'c2' }, { content: [{ type: 'text', text: 'ok' }] })
  assert.deepEqual(governor.status('team').used, { tokens: 7, jobs: 1, diskMb: 2 })

  const status = enforcer.status()
  assert.equal(status.counters.results, 2)
  assert.equal(status.counters.consumed, 1)
  assert.equal(status.counters.skipped, 1)
  assert.equal(status.counters.tokensConsumed, 7)
})

test('nested meta/value usage is booked and aliased result events are de-duplicated', async () => {
  const { ctx, handlers } = fakeCtx()
  const governor = createGovernor({ now: 1000 })
  const enforcer = createEnforcer({ governor, now: 1000, scope: 'team' })
  enforcer.attach(ctx)

  emit(handlers, 'tools/result', { name: 'a', callId: 'a1' }, { meta: { usage: { tokens: 4 } } })
  emit(handlers, 'tools/result', { name: 'a', callId: 'a2' }, { value: { usage: { tokens: 3 } } })
  assert.equal(governor.status('team').used.tokens, 7)

  const exec = { name: 'a', callId: 'a3' }
  const result = { usage: { tokens: 5 } }
  emit(handlers, 'tools/result', exec, result)
  emit(handlers, 'tool/result', exec, result)
  assert.equal(governor.status('team').used.tokens, 12)
  assert.equal(enforcer.status().counters.duplicates, 1)
})

test('session/event tool/result with meta.usage is booked once under the pending scope', async () => {
  const { ctx, handlers } = fakeCtx()
  const governor = createGovernor({ now: 1000 })
  const enforcer = createEnforcer({ governor, now: 1000 })
  enforcer.attach(ctx)

  await enforcer.preExecute({ name: 'shell', callId: 's1', scope: 'special' }, allow)
  emit(handlers, 'session/event', {}, { type: 'assistant/message' })
  assert.equal(governor.status('special').used.tokens, 0)

  emit(handlers, 'session/event', {}, {
    type: 'tool/result',
    message: { toolCallId: 's1' },
    meta: { usage: { tokens: 6 } },
  })
  assert.equal(governor.status('special').used.tokens, 6)

  // A replayed duplicate of the same callId must not book twice.
  emit(handlers, 'session/event', {}, {
    type: 'tool/result',
    message: { toolCallId: 's1' },
    meta: { usage: { tokens: 6 } },
  })
  assert.equal(governor.status('special').used.tokens, 6)
  assert.equal(enforcer.status().counters.duplicates, 1)
})

test('detach stops result consumption as well as gating', async () => {
  const { ctx, handlers } = fakeCtx()
  const governor = createGovernor({ now: 1000 })
  const enforcer = createEnforcer({ governor, now: 1000, scope: 'team' })
  enforcer.attach(ctx)
  const resultHandler = handlers.get('tools/result')[0]

  emit(handlers, 'tools/result', { name: 'a', callId: 'c1' }, { usage: { tokens: 5 } })
  assert.equal(governor.status('team').used.tokens, 5)

  enforcer.detach()
  resultHandler({ name: 'a', callId: 'c2' }, { usage: { tokens: 5 } })
  assert.equal(governor.status('team').used.tokens, 5)
})

test('admission errors fail open and onDeny errors cannot change a denial', async () => {
  const brokenGovernor = {
    admit() {
      throw new Error('admission exploded')
    },
    consume() {},
  }
  const broken = createEnforcer({ governor: brokenGovernor, now: 1000 })
  const passed = await broken.preExecute({ name: 'shell' }, allow)
  assert.equal(passed.kind, 'allow')
  assert.equal(broken.status().counters.errors, 1)
  assert.match(broken.status().lastError, /admission exploded/)

  const governor = seededGovernor(95)
  const observed = createEnforcer({
    governor,
    now: 1000,
    costOf: { shell: 10 },
    onDeny() {
      throw new Error('observer exploded')
    },
  })
  const denied = await observed.preExecute({ name: 'shell' }, allow)
  assert.equal(denied.kind, 'deny')
  assert.equal(observed.status().counters.denied, 1)
  assert.equal(observed.status().counters.errors, 1)
})

test('createEnforcer validates its inputs and exports helpers', () => {
  assert.throws(() => createEnforcer(), TypeError)
  assert.throws(() => createEnforcer({ governor: {} }), /governor\.admit/)
  assert.throws(
    () => createEnforcer({ governor: createGovernor(), onDeny: 'nope' }),
    /onDeny/,
  )
  assert.throws(
    () => createEnforcer({ governor: createGovernor(), costOf: 42 }),
    /costOf/,
  )

  assert.deepEqual(findUsage({ usage: { tokens: 3 } }), { tokens: 3, jobs: 0, diskMb: 0 })
  assert.equal(findUsage({ usage: { jobs: 1 } }), null)
  assert.match(
    describeDenial({ scope: 's', projected: { tokens: 9 }, limits: { tokens: 5 }, exceeded: ['tokens'] }, null, 'shell'),
    /scope "s".*tokens 9 > limit 5.*shell/,
  )
})

test('createEnforcer accepts settings nested under config', async () => {
  const requests = []
  const governor = {
    admit(request) {
      requests.push(request)
      return {
        scope: request.scope,
        allowed: false,
        level: 'hard',
        reason: 'hard-limit',
        projected: { tokens: request.tokens, jobs: 0, diskMb: 0 },
        limits: { tokens: 0, jobs: 0, diskMb: 0 },
        exceeded: ['tokens'],
      }
    },
    consume() {},
  }
  const enforcer = createEnforcer({
    governor,
    config: { costOf: { shell: 5 }, scope: 'cfg', now: 1000 },
  })

  const denied = await enforcer.preExecute({ name: 'shell' }, allow)
  assert.equal(denied.kind, 'deny')
  assert.equal(denied.allow, false)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].scope, 'cfg')
  assert.equal(requests[0].tokens, 5)
  assert.equal(enforcer.status().policy.scope, 'cfg')
})

test('createEnforcer accepts a separate settings argument', () => {
  const governor = createGovernor({ now: 1000 })
  const enforcer = createEnforcer({ governor }, { costOf: { shell: 1 }, scope: 'separate', now: 1000 })
  assert.equal(enforcer.status().policy.scope, 'separate')
  assert.equal(enforcer.status().policy.costOf, true)
})
