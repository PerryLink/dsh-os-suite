import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createTraceStore, verifyBundle } from '../src/core.js'

// Anonymized spans from real DSH runs: two top-level sessions and the session
// recorded by the subagent one of them launched. Synthetic fixtures never
// produced the sibling counts, job nesting, the error turn or the unfinished
// spans these runs contain.
const fixture = path.join(import.meta.dirname, 'fixtures', 'real-run-redacted.jsonl')
const raw = fs.readFileSync(fixture, 'utf8')
const spans = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
const byId = new Map(spans.map((span) => [span.id, span]))
const count = (list, key) =>
  list.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] ?? 0) + 1 }), {})
const children = (parent) => spans.filter((span) => span.parentId === parent.id)

function makeStore() {
  const store = createTraceStore({ now: () => 0 })
  for (const span of spans) store.ingest(span)
  return store
}

test('real-run fixture keeps its recorded shape', () => {
  assert.equal(spans.length, 637)
  assert.deepEqual(count(spans, 'kind'), { session: 3, workflow: 228, tool: 199, mcp: 26, job: 180, subagent: 1 })
  assert.deepEqual(count(spans, 'status'), { ok: 629, error: 1, running: 7 })
  assert.equal(new Set(spans.map((span) => span.sessionId)).size, 3)
  assert.equal(new Set(spans.map((span) => span.id)).size, spans.length)
})

test('real-run fixture keeps its recorded relationships', () => {
  for (const span of spans) {
    assert.ok(Number.isFinite(span.startMs), `${span.id} has startMs`)
    if (span.status === 'running') {
      assert.equal(span.endMs, undefined, `${span.id} is still running`)
    } else {
      assert.ok(Number.isFinite(span.endMs), `${span.id} finished`)
      assert.ok(span.endMs >= span.startMs, `${span.id} ends after it starts`)
    }
    if (span.parentId !== undefined) assert.ok(byId.has(span.parentId), `${span.id} points at an ingested parent`)
  }
  const error = spans.find((span) => span.status === 'error')
  assert.equal(error.kind, 'workflow')
  assert.equal(error.name, 'turn')
  for (let index = 1; index < spans.length; index += 1) {
    assert.ok(spans[index].startMs >= spans[index - 1].startMs, 'ingest order is start-time order')
  }
})

test('every span sits under the parent kind its role requires', () => {
  const expected = {
    workflow: (span, parent) =>
      span.name === 'turn' ? parent.kind === 'session' : parent.kind === 'workflow' && parent.name === 'turn',
    tool: (span, parent) => parent.kind === 'workflow' && parent.name === 'step',
    mcp: (span, parent) => parent.kind === 'workflow' && parent.name === 'step',
    job: (span, parent) => ['tool', 'mcp'].includes(parent.kind),
    subagent: (span, parent) => parent.kind === 'tool' && parent.name === 'subagent',
  }
  for (const span of spans) {
    if (span.kind === 'session') {
      if (span.parentId === undefined) continue
      assert.equal(byId.get(span.parentId).kind, 'subagent', `${span.id} is a child session`)
      continue
    }
    assert.ok(span.parentId !== undefined, `${span.id} has a parent`)
    const parent = byId.get(span.parentId)
    assert.equal(expected[span.kind](span, parent), true, `${span.id} parent is ${parent.id}`)
  }
})

test('only the session roots and the subagent bridge leave their session', () => {
  const roots = spans.filter((span) => span.parentId === undefined)
  assert.equal(roots.length, 2)
  assert.deepEqual(roots.map((span) => span.kind), ['session', 'session'])
  const sessions = spans.filter((span) => span.kind === 'session')
  const subagent = spans.find((span) => span.kind === 'subagent')
  for (const session of sessions) {
    const own = spans.filter((span) => span.sessionId === session.sessionId && span.kind === 'session')
    assert.deepEqual(own.map((span) => span.id), [session.id])
    if (session.sessionId === subagent.sessionId) assert.equal(session.parentId, subagent.id)
    else assert.equal(session.parentId, undefined)
  }
  for (const span of spans) {
    if (span.parentId === undefined) continue
    const parent = byId.get(span.parentId)
    if (span.kind === 'subagent') assert.notEqual(parent.sessionId, span.sessionId)
    else assert.equal(parent.sessionId, span.sessionId, `${span.id} stays in its session`)
  }
})

test('the recorded graph has not been rewired', () => {
  const index = new Map(spans.map((span, position) => [span.id, position]))
  // sha256 over `${index}:${parentIndex}:${kind}:${name}:${status}` joined by newlines.
  // Deliberately ignores ids, sessionIds and timestamps so re-anonymizing the same run
  // does not change it; any parent change, reorder, rename or truncation does.
  const shape = spans
    .map((span, position) => `${position}:${span.parentId ? index.get(span.parentId) : -1}:${span.kind}:${span.name}:${span.status}`)
    .join('\n')
  const fingerprint = crypto.createHash('sha256').update(shape).digest('hex')
  assert.equal(fingerprint, 'dedd14c5e43a83a6f2a9ce39d78fddcf9e476b92f0b2aea4bcc09ff24a7292ef')
})

test('a session with unfinished descendants is recorded as a snapshot', () => {
  for (const session of spans.filter((span) => span.kind === 'session')) {
    const descendants = spans.filter((span) => span.sessionId === session.sessionId)
    const unfinished = descendants.filter((span) => span.status === 'running' && span.id !== session.id)
    if (unfinished.length > 0) {
      assert.equal(session.status, 'running', `${session.id} is still running`)
      assert.equal(session.endMs, undefined)
    } else {
      assert.equal(session.status, 'ok')
      assert.ok(Number.isFinite(session.endMs))
    }
  }
})

test('a background job can outlive the tool call that started it', () => {
  const pairs = spans
    .filter((span) => span.kind === 'job' && byId.get(span.parentId)?.endMs !== undefined)
    .map((span) => ({ job: span, parent: byId.get(span.parentId) }))
    .filter(({ job, parent }) => job.endMs > parent.endMs)
  assert.equal(pairs.length, 1, 'fixture keeps exactly one job that outlived its tool call')
  assert.equal(pairs[0].job.endMs - pairs[0].parent.endMs, 3000)
})

test('real-run fixture ingests into a verifiable chain', () => {
  const bundle = makeStore().exportBundle()
  assert.equal(bundle.spans.length, spans.length)
  assert.equal(verifyBundle(bundle).ok, true)
  assert.equal(verifyBundle(bundle).checked, spans.length)
})

test('trace_why walks a real step up to its turn and down through its tool calls', () => {
  const step = spans.find(
    (span) =>
      span.name === 'step' && children(span).filter((child) => child.kind === 'tool').length >= 3,
  )
  assert.ok(step, 'fixture has a step with three tool calls')

  const around = makeStore().why(step.id, 2)
  const ids = new Set(around.spans.map((span) => span.id))
  assert.ok(ids.has(step.parentId), 'parent turn is included')
  for (const tool of children(step)) {
    assert.ok(ids.has(tool.id), `${tool.id} is included`)
    for (const child of children(tool)) assert.ok(ids.has(child.id), `${child.id} is included`)
  }
  assert.equal(around.edges.length, around.spans.length - 1)
  for (const edge of around.edges) {
    assert.equal(byId.get(edge.childId).parentId, edge.parentId)
    assert.ok(ids.has(edge.parentId) && ids.has(edge.childId))
  }
  assert.deepEqual(around.missing, [])
})

test('trace_why bridges the subagent call into the child session', () => {
  const subagent = spans.find((span) => span.kind === 'subagent')
  const around = makeStore().why(subagent.parentId, 8)
  const ids = new Set(around.spans.map((span) => span.id))
  assert.ok(ids.has(subagent.id))
  const childSession = spans.find((span) => span.kind === 'session' && span.parentId === subagent.id)
  assert.ok(childSession, 'child session is recorded')
  assert.ok(ids.has(childSession.id))
  const childTool = spans.find((span) => span.sessionId === childSession.sessionId && span.kind === 'tool')
  assert.ok(ids.has(childTool.id), 'a tool inside the child session is reachable through the subagent span')
  assert.equal(around.edges.length, around.spans.length - 1)
})

test('trace_why at depth zero returns only the requested span', () => {
  const tool = spans.find((span) => span.kind === 'tool' && children(span).length > 0)
  const around = makeStore().why(tool.id, 0)
  assert.deepEqual(around.spans.map((span) => span.id), [tool.id])
  assert.deepEqual(around.edges, [])
})

test('fixture stays redacted', () => {
  const fixtureName = path.basename(fixture)
  const forbidden = [/qq/i, /@/, /https?:\/\//, /\/home\//i, /\/users\//i, /\/tmp\//i, /c:\\users/i, /\bsk-[a-z0-9]/i, /\bghp_/i, /\bakia[0-9a-z]{8}/i, /\b\d{1,3}(\.\d{1,3}){3}\b/, /password/i, /secret/i]
  for (const pattern of forbidden) assert.equal(pattern.test(raw), false, `fixture matches ${pattern}`)
  assert.equal(/[^\x00-\x7f]/.test(raw), false)
  assert.equal(/\d{4}-\d{2}-\d{2}/.test(fixtureName), false, 'fixture name carries no date')

  const allowedNames = new Set([
    'session', 'turn', 'step', 'subagent', 'bash', 'read', 'write', 'edit', 'notify',
    'push_status', 'job_output', 'list_agents', 'send_message',
    'mcp__remote__send_message', 'mcp__remote__read_state',
  ])
  const allowedKeys = new Set(['id', 'parentId', 'sessionId', 'kind', 'name', 'startMs', 'endMs', 'status'])
  for (const span of spans) {
    for (const key of Object.keys(span)) assert.equal(allowedKeys.has(key), true, `${span.id} carries ${key}`)
    assert.equal(allowedNames.has(span.name), true, `${span.id} uses an expected name`)
    assert.equal(span.startMs % 1000, 0, `${span.id} is rounded to the second`)
    assert.equal(span.endMs === undefined || span.endMs % 1000 === 0, true)
    assert.match(span.sessionId, /^s-[0-9a-f]{12}$/)
    assert.match(span.id, /^(session|tool|job|subagent)-[0-9a-f]{12}$|^s-[0-9a-f]{12}\/(turn|step)-\d+(-\d+)?$/)
  }
})
