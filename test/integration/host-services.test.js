import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { createGovernor } from '../../packages/dsh-os-quota/src/core.js'
import { createEnforcer } from '../../packages/dsh-os-quota/src/enforce.js'
import { createTraceStore } from '../../packages/dsh-os-trace/src/core.js'
import { createIngest } from '../../packages/dsh-os-trace/src/ingest.js'
import { readLiveSession } from '../../packages/dsh-os-eval/src/live.js'

/**
 * These tests mount real `@deepseek-ai/*` services (Cordis Context, ToolRuntime,
 * NativeToolExecutor, SessionStore, SessionQuery) instead of the fake contexts
 * used by the unit suites. They do not call a model; they verify the package's
 * host seam (tools/pre-execute, tools/post-execute, sessionQuery.readSession)
 * against the pinned DSH 0.2.2-rc.3 service contracts.
 */

const echo = defineTool({
  name: 'echo',
  description: 'echo the text argument',
  parameters: { text: { type: 'string' } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args) {
    return args.text ?? ''
  },
})

const call = {
  calls: [{
    type: 'tool-call',
    id: 'call-host-1',
    name: 'echo',
    arguments: JSON.stringify({ text: 'host-ok' }),
  }],
  signal: new AbortController().signal,
}

/**
 * Mount the real DSH tool stack with one echo tool.
 * @returns {Promise<Context>} Context that must be disposed by the caller.
 */
async function toolContext() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  ctx.tools.register(echo)
  return ctx
}

test('quota denies through the real ToolRuntime pipeline', async (t) => {
  const ctx = await toolContext()
  t.after(async () => { await ctx.fiber.dispose() })

  let executed = 0
  ctx.tools.register(defineTool({
    name: 'should-not-run',
    description: 'must never execute after a hard quota denial',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() {
      executed += 1
      return 'unexpected'
    },
  }))

  const governor = createGovernor({
    limits: { tokens: 5 },
    scopes: [{ id: 'default', used: { tokens: 5 } }],
  })
  const enforcer = createEnforcer({
    governor,
    costOf: { echo: { tokens: 10 }, 'should-not-run': { tokens: 10 } },
  })
  const attached = enforcer.attach(ctx)
  t.after(() => enforcer.detach())

  assert.equal(attached.attached, true)
  assert.equal(attached.status().hooks.preExecute, true)

  const result = await ctx.tools.execute(call)
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].result.isError, true)
  assert.match(result.results[0].result.error.message, /Quota hard limit reached/)
  assert.match(result.results[0].result.error.message, /tokens 15 > limit 5/)
  assert.equal(executed, 0)
  assert.equal(enforcer.status().counters.denied, 1)

  const denied = await ctx.tools.execute({
    calls: [{
      type: 'tool-call',
      id: 'call-host-2',
      name: 'should-not-run',
      arguments: '{}',
    }],
    signal: call.signal,
  })
  assert.equal(denied.results[0].result.isError, true)
  assert.equal(executed, 0)
})

test('quota allows and the real executor returns the tool value', async (t) => {
  const ctx = await toolContext()
  t.after(async () => { await ctx.fiber.dispose() })

  const governor = createGovernor({
    limits: { tokens: 100 },
    scopes: [{ id: 'default', used: { tokens: 0 } }],
  })
  const enforcer = createEnforcer({
    governor,
    costOf: { echo: { tokens: 1 } },
  })
  enforcer.attach(ctx)
  t.after(() => enforcer.detach())

  const result = await ctx.tools.execute(call)
  assert.equal(result.results[0].result.isError, false)
  assert.equal(result.results[0].result.value, 'host-ok')
  assert.equal(enforcer.status().counters.allowed, 1)
  assert.equal(enforcer.status().counters.denied, 0)
})

test('trace ingest captures spans from the real Cordis event bus', async (t) => {
  const ctx = await toolContext()
  t.after(async () => { await ctx.fiber.dispose() })

  const ingest = createIngest({ store: createTraceStore(), now: () => 1000 })
  assert.equal(ingest.attach(ctx), true)
  t.after(() => ingest.detach())

  const result = await ctx.tools.execute(call)
  assert.equal(result.results[0].result.isError, false)

  const spans = ingest.spans()
  assert.equal(spans.length, 1)
  assert.equal(spans[0].kind, 'tool')
  assert.equal(spans[0].name, 'echo')
  assert.equal(spans[0].status, 'ok')
  assert.equal(spans[0].id, 'tool:call-host-1')
  assert.equal(spans[0].prevHash, '0'.repeat(64))

  const status = ingest.status()
  assert.equal(status.attached, true)
  assert.ok(status.events >= 3)
  assert.ok(status.mapped >= 3)
  assert.equal(status.errors, 0)
  assert.ok(status.eventsByName.some((entry) => entry.name === 'tools/pre-execute'))
  assert.ok(status.eventsByName.some((entry) => entry.name === 'tools/post-execute'))
})

test('eval reads a live session through the real SessionStore and SessionQuery', async (t) => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionQuery)
  t.after(async () => { await ctx.fiber.dispose() })

  const fixture = new URL(
    '../../packages/dsh-os-eval/test/fixtures/session-success.jsonl',
    import.meta.url,
  )
  const lines = readFileSync(fixture, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const header = lines[0]
  const events = lines.slice(1).map((event, index) => {
    // The fixture is an exported JSONL log: seq starts after the header and may
    // carry fields newer hosts ignore. Session seeds require a clean envelope
    // starting at 0, so keep only the durable keys and renumber.
    /** @type {Record<string, unknown>} */
    const out = { type: event.type, seq: index, time: event.time, data: event.data }
    if (event.type === 'assistant/message' && out.data.stream === undefined) {
      out.data = { ...out.data, stream: [] }
    }
    if (event.surfaceOp !== undefined) out.surfaceOp = event.surfaceOp
    if (event.sourceEventSeqs !== undefined) out.sourceEventSeqs = event.sourceEventSeqs
    if (event.ignorable !== undefined) out.ignorable = event.ignorable
    return out
  })

  const session = ctx.sessions.create(header.id, {
    seed: events,
    meta: { cwd: process.cwd() },
  })

  const snapshot = await ctx.sessionQuery.readSession(session.id)
  assert.equal(snapshot.session.id, header.id)
  assert.ok(snapshot.events.length >= events.length)

  const parsed = await readLiveSession(ctx, session.id)
  assert.equal(parsed.id, header.id)
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].tool, 'read')
  assert.equal(parsed.toolCalls[0].result, '# dsh-os-eval')
  assert.equal(parsed.toolCalls[0].hasResult, true)
  assert.equal(parsed.toolCalls[0].isError, false)
  assert.equal(parsed.messages.at(-1).text, 'Read the README. All checks passed.')
})
