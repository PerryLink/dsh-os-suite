import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyBundle } from '../src/core.js'

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url))
const T0 = 1_700_000_000_000

/**
 * @param {string} id
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function span(id, overrides = {}) {
  return {
    id,
    sessionId: 'session-1',
    kind: 'tool',
    name: 'read_file',
    startMs: T0,
    status: 'ok',
    ...overrides,
  }
}

/**
 * @param {string[]} args
 * @param {{ input?: string, cwd?: string }} [options]
 */
function run(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    ...options,
  })
}

test('CLI trace_export defaults to a v1 bundle and accepts OTLP/JSON output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-os-trace-cli-'))
  try {
    const spansFile = join(directory, 'spans.json')
    const spans = [
      span('root', { kind: 'workflow', name: 'run' }),
      span('tool-1', { parentId: 'root', startMs: T0 + 10 }),
    ]
    writeFileSync(spansFile, JSON.stringify(spans), 'utf8')

    const bundleResult = run(['trace_export', spansFile])
    assert.equal(bundleResult.status, 0, bundleResult.stderr)
    const bundle = JSON.parse(bundleResult.stdout)
    assert.equal(bundle.format, 'dsh-os-trace/bundle')
    assert.equal(bundle.spanCount, 2)
    assert.equal(verifyBundle(bundle).ok, true)
    assert.deepEqual(
      bundle.spans.map((entry) => entry.id),
      ['root', 'tool-1'],
    )

    const otlpResult = run(['trace_export', spansFile, '--format', 'otlp'])
    assert.equal(otlpResult.status, 0, otlpResult.stderr)
    const otlp = JSON.parse(otlpResult.stdout)
    const exportedSpans = otlp.resourceSpans[0].scopeSpans[0].spans
    assert.equal(exportedSpans.length, 2)
    assert.equal(exportedSpans[1].parentSpanId, exportedSpans[0].spanId)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('CLI trace_import --format otlp reads OTLP into the store and re-seals a bundle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-os-trace-cli-'))
  try {
    const spansFile = join(directory, 'spans.json')
    const otlpFile = join(directory, 'traces.json')
    const bundleFile = join(directory, 'bundle.json')
    const spans = [
      span('root', { kind: 'workflow', name: 'run' }),
      span('tool-1', { parentId: 'root', startMs: T0 + 10, status: 'error' }),
    ]
    writeFileSync(spansFile, JSON.stringify(spans), 'utf8')

    const exported = run(['trace_export', spansFile, '--format', 'otlp', '--out', otlpFile])
    assert.equal(exported.status, 0, exported.stderr)
    assert.equal(exported.stdout, '')

    const imported = run(['trace_import', otlpFile, '--format', 'otlp', '--out', bundleFile])
    assert.equal(imported.status, 0, imported.stderr)

    const bundle = JSON.parse(readFileSync(bundleFile, 'utf8'))
    assert.equal(bundle.format, 'dsh-os-trace/bundle')
    assert.equal(bundle.spanCount, 2)
    assert.equal(verifyBundle(bundle).ok, true)
    assert.deepEqual(
      bundle.spans.map((entry) => entry.id),
      ['root', 'tool-1'],
    )
    assert.equal(bundle.spans[1].parentId, 'root')
    assert.equal(bundle.spans[1].status, 'error')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('CLI trace_export reads stdin and CLI trace_import defaults to v1 bundle input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-os-trace-cli-'))
  try {
    const bundleFile = join(directory, 'bundle.json')
    const spans = [span('root', { kind: 'workflow', name: 'run' })]

    const fromStdin = run(['trace_export', '--format', 'otlp'], {
      input: JSON.stringify(spans),
    })
    assert.equal(fromStdin.status, 0, fromStdin.stderr)
    const otlp = JSON.parse(fromStdin.stdout)
    assert.equal(otlp.resourceSpans[0].scopeSpans[0].spans.length, 1)

    const bundleResult = run(['trace_export', '--out', bundleFile], {
      input: JSON.stringify(spans),
    })
    assert.equal(bundleResult.status, 0, bundleResult.stderr)

    const imported = run(['trace_import', bundleFile])
    assert.equal(imported.status, 0, imported.stderr)
    const bundle = JSON.parse(imported.stdout)
    assert.equal(bundle.spanCount, 1)
    assert.equal(verifyBundle(bundle).ok, true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('CLI rejects bad JSON with exit code 2 and no stack trace', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-os-trace-cli-'))
  try {
    const badFile = join(directory, 'bad.json')
    writeFileSync(badFile, '{not json', 'utf8')
    const result = run(['trace_import', badFile, '--format', 'otlp'])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /not valid JSON/)
    assert.equal(result.stdout, '')
    assert.equal(/^\s+at /m.test(result.stderr), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('CLI exposes help and version', () => {
  const help = run(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /trace_export/)
  assert.match(help.stdout, /OTLP\/JSON only/)

  const version = run(['--version'])
  assert.equal(version.status, 0)
  assert.match(version.stdout, /dsh-os-trace \d+\.\d+\.\d+/)
})
