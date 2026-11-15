#!/usr/bin/env node
/**
 * Offline CLI for dsh-os-trace.
 *
 * The CLI owns argument parsing, file IO and exit codes. Span validation,
 * hash-chain sealing and OTLP/JSON mapping live in core.js and otlp.js.
 *
 * The default format is this package's v1 evidence bundle. `--format otlp`
 * switches export to OTLP/JSON, or tells import to read OTLP/JSON. Importing
 * always emits a freshly sealed v1 bundle because the CLI process is the store.
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createTraceStore, verifyBundle } from './core.js'
import { fromOtlp, toOtlp } from './otlp.js'

/** @type {string} */
let VERSION = '0.0.0'
try {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  if (typeof packageJson.version === 'string') VERSION = packageJson.version
} catch {
  // Version is cosmetic; never fail a command because package.json is absent.
}

const USAGE = `dsh-os-trace ${VERSION} - causal trace and OTLP/JSON interop

Usage:
  dsh-os-trace trace_export [input] [--format bundle|otlp] [--out <file>] [--service-name <name>]
  dsh-os-trace trace_import <input> --format otlp [--out <file>]
  dsh-os-trace trace_import <input> [--format bundle] [--out <file>]
  dsh-os-trace export ...   (alias)
  dsh-os-trace import ...   (alias)

Commands:
  trace_export  Read a v1 bundle, OTLP/JSON document, span array or JSONL and
                emit a v1 bundle (default) or an OTLP/JSON document.
  trace_import  Read a v1 bundle or OTLP/JSON document into a fresh in-memory
                store and emit the resulting v1 bundle.

Options:
  --format <bundle|otlp>  Output format for export, input format for import.
                          Default: bundle.
  --out <file>            Write JSON to this file instead of stdout.
  --service-name <name>   service.name resource attribute for OTLP export.
                          Default: dsh.
  -h, --help              Show this help.
  -V, --version           Show the version.

Input:
  Omit <input> for export, or pass "-", to read stdin. An empty input produces
  an empty export. JSONL is accepted for export when the input is not one JSON
  document.

Limits:
  OTLP/JSON only: no OTLP/gRPC, protobuf, OTel SDK, collector or W3C trace
  context propagation. Imported spans are re-sealed into this package's own
  SHA-256 chain; OTLP has no equivalent of that chain or its HMAC signature.

Exit codes: 0 success, 2 bad arguments/input/IO.
`

/**
 * @typedef {Error & { exitCode?: number }} CliError
 */

/**
 * @param {string} message
 * @param {number} [exitCode]
 * @returns {never}
 */
function fail(message, exitCode = 2) {
  /** @type {CliError} */
  const error = new Error(message)
  error.exitCode = exitCode
  throw error
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {string} file
 * @param {string} label
 * @returns {string}
 */
function readText(file, label) {
  if (file === undefined || file === '-') {
    if (process.stdin.isTTY) return ''
    try {
      return readFileSync(0, 'utf8')
    } catch (error) {
      fail(`cannot read ${label} from stdin: ${messageOf(error)}`)
    }
  }
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    fail(`cannot read ${label} "${file}": ${messageOf(error)}`)
    return ''
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripBom(text) {
  return text.replace(/^\uFEFF/, '')
}

/**
 * @param {string} text
 * @param {string} label
 * @returns {unknown[]}
 */
function readExportSpans(text, label) {
  const trimmed = stripBom(text).trim()
  if (trimmed.length === 0) return []

  let value
  try {
    value = JSON.parse(trimmed)
  } catch (jsonError) {
    // Accept JSONL as a convenience for raw span dumps. If that also fails,
    // report the original JSON problem plus the failing line.
    const lines = trimmed.split(/\r?\n/)
    /** @type {unknown[]} */
    const spans = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (line.length === 0) continue
      try {
        spans.push(JSON.parse(line))
      } catch (lineError) {
        fail(
          `${label} is not valid JSON (${messageOf(jsonError)}); ` +
            `line ${index + 1} also fails: ${messageOf(lineError)}`,
        )
      }
    }
    return spans
  }

  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value)
    if (Array.isArray(record.spans)) return record.spans
    if (Array.isArray(record.resourceSpans) || Array.isArray(record.scopeSpans)) {
      try {
        return fromOtlp(record)
      } catch (error) {
        fail(`input is not valid OTLP/JSON: ${messageOf(error)}`)
      }
    }
  }
  fail(`${label} must be a v1 bundle, an OTLP/JSON document, a span array or JSONL`)
  return []
}

/**
 * @param {string} text
 * @param {string} label
 * @returns {unknown[]}
 */
function readImportBundle(text, label) {
  let value
  try {
    value = JSON.parse(stripBom(text))
  } catch (error) {
    fail(`${label} is not valid JSON: ${messageOf(error)}`)
  }
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value)
    if (Array.isArray(record.spans)) {
      const result = verifyBundle(record)
      if (!result.ok) {
        const reason = result.firstBad === null ? 'unknown error' : result.firstBad.reason
        fail(`${label} is not a valid v1 bundle: ${reason}`)
      }
      return record.spans
    }
  }
  fail(`${label} must be a v1 bundle with a spans array`)
  return []
}

/**
 * @param {unknown[]} spans
 * @returns {ReturnType<typeof createTraceStore>}
 */
function sealIntoStore(spans) {
  if (!Array.isArray(spans)) fail('input spans must be an array')
  const store = createTraceStore()
  for (let index = 0; index < spans.length; index += 1) {
    try {
      store.ingest(/** @type {Record<string, unknown>} */ (spans[index]))
    } catch (error) {
      fail(`input span ${index + 1} is invalid: ${messageOf(error)}`)
    }
  }
  return store
}

/**
 * @param {unknown} value
 * @param {string|undefined} out
 * @returns {void}
 */
function writeJson(value, out) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (out === undefined || out === '-') {
    process.stdout.write(text)
    return
  }
  try {
    writeFileSync(out, text, 'utf8')
  } catch (error) {
    fail(`cannot write "${out}": ${messageOf(error)}`)
  }
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv = process.argv.slice(2)) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: 'string', default: 'bundle' },
        out: { type: 'string' },
        'service-name': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    })
  } catch (error) {
    fail(messageOf(error))
  }

  if (parsed.values.version === true) {
    process.stdout.write(`dsh-os-trace ${VERSION}\n`)
    return 0
  }
  if (parsed.values.help === true) {
    process.stdout.write(USAGE)
    return 0
  }

  const positionals = parsed.positionals
  const command = positionals[0]
  if (command === undefined) fail('missing command; use --help for usage')
  if (command === 'trace_export') {
    // handled below
  } else if (command === 'trace_import') {
    // handled below
  } else if (command !== 'export' && command !== 'import') {
    fail(`unknown command "${command}"; use --help for usage`)
  }

  const input = positionals[1]
  if (positionals.length > 2) fail(`unexpected argument "${positionals[2]}"`)

  const format = parsed.values.format
  if (format !== 'bundle' && format !== 'otlp') {
    fail(`--format must be "bundle" or "otlp", got "${String(format)}"`)
  }
  const out = parsed.values.out
  const serviceName = parsed.values['service-name']

  if (command === 'trace_export' || command === 'export') {
    const text = readText(input, 'input')
    const spans = readExportSpans(text, 'input')
    const store = sealIntoStore(spans)
    if (format === 'otlp') {
      let document
      try {
        document = toOtlp(spans, serviceName === undefined ? {} : { serviceName })
      } catch (error) {
        fail(messageOf(error))
      }
      writeJson(document, out)
    } else {
      writeJson(store.exportBundle(), out)
    }
    return 0
  }

  if (input === undefined) fail('trace_import requires an input file (or "-" for stdin)')
  const text = readText(input, 'input')
  let spans
  try {
    spans = format === 'otlp' ? fromOtlp(text) : readImportBundle(text, 'input')
  } catch (error) {
    fail(messageOf(error))
  }
  const store = sealIntoStore(spans)
  writeJson(store.exportBundle(), out)
  return 0
}

const isEntry =
  process.argv[1] !== undefined &&
  (() => {
    try {
      const invoked = realpathSync(resolve(process.argv[1]))
      const self = realpathSync(fileURLToPath(import.meta.url))
      return process.platform === 'win32'
        ? invoked.toLowerCase() === self.toLowerCase()
        : invoked === self
    } catch {
      return false
    }
  })()

if (isEntry) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`dsh-os-trace: ${messageOf(error)}\n`)
    process.exitCode =
      typeof (/** @type {CliError} */ (error).exitCode) === 'number'
        ? /** @type {CliError} */ (error).exitCode
        : 1
  }
}
