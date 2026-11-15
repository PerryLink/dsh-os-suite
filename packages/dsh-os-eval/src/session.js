/**
 * Read-only replay of an exported DSH session JSONL log.
 *
 * This module deliberately performs no model call, no network access, and no
 * session-service lookup. It reads one explicit JSONL file, parses the events
 * it understands, pairs tool calls with results, and turns the recording into
 * the same run shape the pure store in `core.js` already grades.
 *
 * Supported input is the plain-text session generation written by the DSH
 * session-persistence JSONL backend (`compression: 'none'`), or the equivalent
 * raw export (`/api/session.export`). Zstandard frames, session directories,
 * live sessions, OTel spans, and session-query are intentionally out of scope.
 */

import { readFileSync } from 'node:fs'
import { createEvalStore, EvalError } from './core.js'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

const KNOWN_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'tool/call',
  'tool/result',
  'assistant/message',
  'assistant/attempt',
])

const EVENT_TYPE_ALIASES = new Map([
  ['tool_call', 'tool/call'],
  ['tool-result', 'tool/result'],
  ['tool_result', 'tool/result'],
  ['assistant_message', 'assistant/message'],
  ['turn-start', 'turn/start'],
  ['turn_start', 'turn/start'],
  ['turn-end', 'turn/end'],
  ['turn_end', 'turn/end'],
  ['step-start', 'step/start'],
  ['step_start', 'step/start'],
  ['step-end', 'step/end'],
  ['step_end', 'step/end'],
])

/**
 * Parse an exported DSH session JSONL document.
 *
 * The parser is intentionally permissive: blank lines, malformed JSON lines,
 * unknown event types, unknown fields, flat events (payload fields next to
 * `type`), and events tagged with `kind` instead of `type` are all tolerated.
 * The header line (`type: "session"`) supplies the session id. Only events the
 * evaluator understands are interpreted; everything else is skipped.
 *
 * @param {string} text UTF-8 JSONL contents of one exported session.
 * @returns {{
 *   id: string|null,
 *   turns: number,
 *   toolCalls: object[],
 *   messages: object[],
 * }} Parsed session. `turns` counts distinct turn numbers when present,
 * otherwise turn-boundary events.
 */
export function parseSessionJsonl(text) {
  if (typeof text !== 'string') {
    throw new EvalError('INVALID_SESSION', 'session JSONL must be a string')
  }

  /** @type {object[]} */
  const toolCalls = []
  /** @type {Map<string, object>} */
  const callsById = new Map()
  /** @type {Map<string, object>} */
  const pendingResults = new Map()
  /** @type {object[]} */
  const messages = []
  /** @type {Set<number>} */
  const turnNumbers = new Set()
  let turnBoundaries = 0
  let id = null

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue

    let record
    try {
      record = JSON.parse(line)
    } catch {
      // A torn tail line is expected after a crash; tolerate it.
      continue
    }
    if (!isPlainObject(record)) continue

    const type = eventTypeOf(record)
    if (type === 'session') {
      if (id === null) id = readSessionId(record)
      continue
    }

    const data = payloadOf(record)
    const turn = readInteger(data.turn ?? record.turn)
    if (turn !== null) turnNumbers.add(turn)
    if (type === 'turn/start' || type === 'turn/end') turnBoundaries += 1
    if (type === null) continue

    if (type === 'tool/call') {
      const callId = readCallId(data)
      const call = {
        callId,
        tool: readToolName(data),
        args: readArguments(data),
        turn,
        step: readInteger(data.step ?? record.step),
        result: null,
        hasResult: false,
        isError: null,
        time: readTime(record.time ?? data.time),
      }
      if (callId !== null && pendingResults.has(callId)) {
        applyResult(call, pendingResults.get(callId))
        pendingResults.delete(callId)
      }
      toolCalls.push(call)
      if (callId !== null) callsById.set(callId, call)
      continue
    }

    if (type === 'tool/result') {
      const result = {
        result: readToolResultValue(data),
        isError: readResultError(data),
        time: readTime(record.time ?? data.time),
      }
      const callId = readCallId(data)
      if (callId === null) continue
      if (callsById.has(callId)) applyResult(callsById.get(callId), result)
      else pendingResults.set(callId, result)
      continue
    }

    if (type === 'assistant/message') {
      const message = readAssistantMessage(data, record)
      if (message !== null) messages.push(message)
    }
  }

  return {
    id,
    turns: turnNumbers.size > 0 ? turnNumbers.size : turnBoundaries,
    toolCalls,
    messages,
  }
}

/**
 * Build the ordered step sequence of a session by pairing tool calls with tool
 * results on `callId`.
 *
 * `parseSessionJsonl` already pairs calls and results while scanning, but this
 * function accepts either shape: a parsed session whose calls carry `result`,
 * or a hand-built session whose entries are separate `tool/call` and
 * `tool/result` records. An unanswered call stays in the trajectory with
 * `result: null` and `hasResult: false`.
 *
 * @param {{ id?: string|null, turns?: number, toolCalls?: object[], messages?: object[] }} session Parsed session.
 * @returns {{
 *   index: number,
 *   callId: string|null,
 *   tool: string,
 *   args: unknown,
 *   result: unknown,
 *   hasResult: boolean,
 *   isError: boolean|null,
 *   turn: number|null,
 *   step: number|null,
 * }[]} Tool steps in log order.
 */
export function trajectoryOf(session) {
  const normalized = normalizeSession(session)
  /** @type {object[]} */
  const steps = []
  /** @type {Map<string, object>} */
  const results = new Map()

  for (const entry of normalized.toolCalls) {
    if (!isPlainObject(entry)) continue

    if (isResultEntry(entry)) {
      const callId = readCallId(entry)
      if (callId !== null) results.set(callId, entry)
      continue
    }

    const step = {
      index: steps.length,
      callId: readCallId(entry),
      tool: readToolName(entry) ?? 'unknown',
      args: readArguments(entry),
      result: null,
      hasResult: false,
      isError: null,
      turn: readInteger(entry.turn),
      step: readInteger(entry.step),
    }

    if (entry.hasResult === true
      || (Object.hasOwn(entry, 'result') && entry.result !== undefined && entry.result !== null)) {
      step.result = Object.hasOwn(entry, 'result') ? entry.result : null
      step.hasResult = true
      step.isError = entry.isError === true
    }

    steps.push(step)
  }

  for (const step of steps) {
    if (step.hasResult || step.callId === null) continue
    const found = results.get(step.callId)
    if (found === undefined) continue
    step.result = toolResultValue(found)
    step.hasResult = true
    step.isError = readResultError(found)
  }

  return steps
}

/**
 * Replay recorded tool steps through a caller-supplied synchronous runner.
 *
 * The runner is invoked once per tool step with `{ tool, args, result }` and
 * may return a score, a verdict, or any other JSON value. It is a pure local
 * callback: this function never calls a model or a network service. When no
 * runner is supplied, each step's recorded result is collected instead.
 *
 * @param {{ id?: string|null, turns?: number, toolCalls?: object[], messages?: object[] }} session Parsed session.
 * @param {{ runner?: (step: { tool: string, args: unknown, result: unknown }) => unknown }} [options]
 *   Optional replayer. Its return values are exposed as `results`.
 * @returns {{
 *   sessionId: string|null,
 *   output: string,
 *   steps: number,
 *   tokens: number,
 *   latencyMs: number,
 *   results: unknown[],
 *   trajectory: object[],
 * }} Replay result. `output` is the final non-empty assistant text.
 */
export function replay(session, options = {}) {
  const opts = options ?? {}
  if (!isPlainObject(opts)) {
    throw new EvalError('INVALID_OPTIONS', 'replay options must be a plain object')
  }
  if (opts.runner !== undefined && typeof opts.runner !== 'function') {
    throw new EvalError('INVALID_RUNNER', 'replay runner must be a synchronous function')
  }

  const summary = summarizeSession(session)
  const trajectory = trajectoryOf(session)
  /** @type {unknown[]} */
  const results = []

  for (const step of trajectory) {
    if (opts.runner === undefined) {
      results.push(step.result)
      continue
    }
    const value = opts.runner({ tool: step.tool, args: step.args, result: step.result })
    if (isThenable(value)) {
      throw new EvalError(
        'ASYNC_RUNNER_UNSUPPORTED',
        'replay runner returned a Promise; dsh-os-eval only supports synchronous runners',
      )
    }
    results.push(value)
  }

  return {
    sessionId: summary.sessionId,
    output: summary.output,
    steps: summary.steps,
    tokens: summary.tokens,
    latencyMs: summary.latencyMs,
    results,
    trajectory,
  }
}

/**
 * Evaluate one recorded session against a list of cases.
 *
 * Cases use the same `expect` contract as the eval store: `contains` and
 * `equals` grade the session's final non-empty assistant message, `maxSteps`
 * grades the number of paired tool steps, and `maxTokens` grades summed
 * assistant-message usage. The store performs the actual grading so recorded
 * sessions and injected runners cannot drift apart.
 *
 * @param {{ id?: string|null, turns?: number, toolCalls?: object[], messages?: object[] }} session Parsed session.
 * @param {import('./core.js').EvalCase[]} cases Cases to grade.
 * @returns {{
 *   sessionId: string|null,
 *   total: number,
 *   passed: number,
 *   failed: number,
 *   steps: number,
 *   tokens: number,
 *   latencyMs: number,
 *   output: string,
 *   trajectory: object,
 *   cases: object[],
 * }} Per-case grades plus session trajectory summary.
 */
export function evaluate(session, cases) {
  if (!Array.isArray(cases)) {
    throw new EvalError('INVALID_CASES', 'cases must be an array')
  }

  const summary = summarizeSession(session)
  const store = createEvalStore()
  for (const evalCase of cases) store.defineCase(evalCase)

  /** @type {object[]} */
  const results = []
  for (const evalCase of cases) {
    const run = store.runCase(evalCase.id, () => ({
      output: summary.output,
      steps: summary.steps,
      tokens: summary.tokens,
      latencyMs: summary.latencyMs,
    }))
    results.push({ ...run, name: evalCase.name })
  }

  return {
    sessionId: summary.sessionId,
    total: results.length,
    passed: results.filter((run) => run.status === 'PASS').length,
    failed: results.filter((run) => run.status === 'FAIL').length,
    steps: summary.steps,
    tokens: summary.tokens,
    latencyMs: summary.latencyMs,
    output: summary.output,
    trajectory: summarizeTrajectory(session),
    cases: results,
  }
}

/**
 * Read and parse one exported plain-text session JSONL file.
 *
 * Only the path supplied by the caller is touched: no directory listing, no
 * session-root discovery, no subagent archive traversal. Zstandard-compressed
 * logs are refused with a clear error instead of being parsed as garbage.
 *
 * @param {string} filePath Path to one exported, uncompressed `.jsonl` file.
 * @returns {ReturnType<typeof parseSessionJsonl>} Parsed session.
 */
export function readSessionFile(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new EvalError('INVALID_SESSION_FILE', 'sessionFile must be a non-empty path string')
  }

  /** @type {Buffer} */
  let bytes
  try {
    bytes = readFileSync(filePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new EvalError('SESSION_READ_FAILED', `cannot read session file "${filePath}": ${message}`)
  }

  if (bytes.length >= ZSTD_MAGIC.length
    && ZSTD_MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new EvalError(
      'UNSUPPORTED_SESSION_FILE',
      `session file "${filePath}" is Zstandard-compressed; export plain JSONL instead of .jsonl.zstd`,
    )
  }

  return parseSessionJsonl(bytes.toString('utf8'))
}

/**
 * Derive the run-shaped summary of a recorded session.
 *
 * @param {{ id?: string|null, turns?: number, toolCalls?: object[], messages?: object[] }} session Parsed session.
 * @returns {{
 *   sessionId: string|null,
 *   turns: number,
 *   messages: number,
 *   steps: number,
 *   tokens: number,
 *   latencyMs: number,
 *   output: string,
 * }} Summary suitable for a `Run`.
 */
export function summarizeSession(session) {
  const normalized = normalizeSession(session)
  const trajectory = trajectoryOf(normalized)
  const messages = normalized.messages.filter((message) => isPlainObject(message))
  const times = []

  for (const message of messages) {
    if (isNonNegativeNumber(message.time)) times.push(message.time)
  }
  for (const entry of normalized.toolCalls) {
    if (!isPlainObject(entry)) continue
    if (isNonNegativeNumber(entry.time)) times.push(entry.time)
    if (isNonNegativeNumber(entry.resultTime)) times.push(entry.resultTime)
  }

  const latencyMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0

  return {
    sessionId: normalized.id,
    turns: normalized.turns,
    messages: messages.length,
    steps: trajectory.length,
    tokens: messages.reduce((sum, message) => {
      if (isNonNegativeNumber(message.tokens)) return sum + message.tokens
      return sum + usageTokens(message.usage)
    }, 0),
    latencyMs,
    output: finalAssistantText(messages),
  }
}

/**
 * Compact, privacy-preserving trajectory summary for reports. Tool arguments
 * and raw results are never included.
 *
 * @param {{ id?: string|null, turns?: number, toolCalls?: object[], messages?: object[] }} session Parsed session.
 * @returns {{
 *   sessionId: string|null,
 *   turns: number,
 *   messages: number,
 *   steps: number,
 *   tokens: number,
 *   latencyMs: number,
 *   paired: number,
 *   toolErrors: number,
 *   tools: string[],
 * }} Summary with tool names, pairing count, and error count.
 */
export function summarizeTrajectory(session) {
  const summary = summarizeSession(session)
  const trajectory = trajectoryOf(session)
  /** @type {string[]} */
  const tools = []

  for (const step of trajectory) {
    if (!tools.includes(step.tool)) tools.push(step.tool)
  }

  return {
    sessionId: summary.sessionId,
    turns: summary.turns,
    messages: summary.messages,
    steps: summary.steps,
    tokens: summary.tokens,
    latencyMs: summary.latencyMs,
    paired: trajectory.filter((step) => step.hasResult).length,
    toolErrors: trajectory.filter((step) => step.isError === true).length,
    tools,
  }
}

/**
 * @param {unknown} value Candidate parsed line.
 * @returns {string|null} Normalised event type, `"session"` for a header, or null.
 */
function eventTypeOf(value) {
  if (!isPlainObject(value)) return null
  for (const candidate of [value.kind, value.type]) {
    if (typeof candidate !== 'string') continue
    if (candidate === 'session') return 'session'
    if (KNOWN_EVENT_TYPES.has(candidate)) return candidate
    const alias = EVENT_TYPE_ALIASES.get(candidate)
    if (alias !== undefined) return alias
  }
  return null
}

/**
 * @param {object} record Parsed JSONL line.
 * @returns {object} Nested `data` payload when present, otherwise the line itself.
 */
function payloadOf(record) {
  return isPlainObject(record.data) ? record.data : record
}

/**
 * @param {object} record Session header line.
 * @returns {string|null} Header session id.
 */
function readSessionId(record) {
  const data = isPlainObject(record.data) ? record.data : {}
  for (const candidate of [
    record.id,
    record.sessionId,
    record.session?.id,
    data.id,
    data.sessionId,
    data.session?.id,
  ]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return null
}

/**
 * @param {object} value Event payload or hand-built tool entry.
 * @returns {string|null} Paired call id.
 */
function readCallId(value) {
  if (!isPlainObject(value)) return null
  const message = isPlainObject(value.message) ? value.message : {}
  const source = isPlainObject(value.source) ? value.source : {}
  const messageSource = isPlainObject(message.source) ? message.source : {}
  const call = isPlainObject(value.call) ? value.call : {}
  for (const candidate of [
    value.callId,
    value.toolCallId,
    message.toolCallId,
    messageSource.callId,
    source.callId,
    call.id,
    value.id,
  ]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return null
}

/**
 * @param {object} value Event payload or hand-built tool entry.
 * @returns {string|null} Tool name.
 */
function readToolName(value) {
  if (!isPlainObject(value)) return null
  const call = isPlainObject(value.call) ? value.call : {}
  const message = isPlainObject(value.message) ? value.message : {}
  for (const candidate of [
    value.tool,
    value.name,
    value.toolName,
    call.name,
    message.name,
  ]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return null
}

/**
 * @param {object} value Event payload or hand-built tool entry.
 * @returns {unknown} Parsed arguments, raw string, or null.
 */
function readArguments(value) {
  if (!isPlainObject(value)) return null
  const call = isPlainObject(value.call) ? value.call : {}
  const raw = firstDefined(
    value.arguments,
    value.args,
    value.input,
    value.parameters,
    call.arguments,
    call.args,
  )
  return parseArguments(raw)
}

/**
 * @param {unknown} value Raw tool arguments.
 * @returns {unknown} Parsed JSON when possible, otherwise the original value.
 */
function parseArguments(value) {
  if (typeof value !== 'string') return value ?? null
  if (value.trim() === '') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * @param {object} data Tool-result event payload.
 * @returns {string} Model-facing result text.
 */
function readToolResultValue(data) {
  if (Object.hasOwn(data, 'result') && data.result !== null && data.result !== undefined) {
    return readTextContent(data.result)
  }
  const message = isPlainObject(data.message) ? data.message : data
  return readTextContent(firstDefined(
    message.content,
    message.text,
    message.result,
    message.output,
    data.content,
  ))
}

/**
 * @param {object} data Tool-result event payload.
 * @returns {boolean} Whether the tool reported an error.
 */
function readResultError(data) {
  const message = isPlainObject(data.message) ? data.message : {}
  return message.isError === true
    || data.isError === true
    || (data.error !== undefined && data.error !== null)
    || (message.error !== undefined && message.error !== null)
}

/**
 * @param {object} data Assistant-message event payload.
 * @param {object} record Full event line, for flat exports.
 * @returns {object|null} Normalised assistant message.
 */
function readAssistantMessage(data, record) {
  const message = isPlainObject(data.message) ? data.message : data
  const content = firstDefined(message.content, data.content, data.text)
  if (content === undefined) return null

  const usage = isPlainObject(data.usage)
    ? data.usage
    : isPlainObject(message.usage) ? message.usage : null

  return {
    role: 'assistant',
    text: readAssistantText(content),
    turn: readInteger(firstDefined(data.turn, message.turn, record.turn)),
    step: readInteger(firstDefined(data.step, message.step, record.step)),
    tokens: usageTokens(usage),
    interrupted: data.interrupted === true || message.interrupted === true,
    time: readTime(record.time ?? data.time),
  }
}

/**
 * @param {unknown} content Assistant content blocks or text.
 * @returns {string} Visible text (reasoning and tool-call blocks excluded).
 */
function readAssistantText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return readTextContent(content)
  /** @type {string[]} */
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!isPlainObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === undefined && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * @param {unknown} content Message content blocks or a plain value.
 * @returns {string} Concatenated visible text.
 */
function readTextContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    /** @type {string[]} */
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      if (!isPlainObject(block)) continue
      if (typeof block.text === 'string') {
        parts.push(block.text)
      } else if (typeof block.content === 'string') {
        parts.push(block.content)
      } else if (block.content !== undefined) {
        const nested = readTextContent(block.content)
        if (nested !== '') parts.push(nested)
      }
    }
    return parts.join('\n')
  }
  if (isPlainObject(content)) {
    if (typeof content.text === 'string') return content.text
    if (content.content !== undefined) return readTextContent(content.content)
    if (content.result !== undefined) return readTextContent(content.result)
  }
  return content === null || content === undefined ? '' : String(content)
}

/**
 * @param {unknown} usage DSH `TokenUsage` object.
 * @returns {number} Total tokens for one model call.
 */
function usageTokens(usage) {
  if (!isPlainObject(usage)) return 0
  if (isNonNegativeNumber(usage.totalTokens)) return usage.totalTokens
  return ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .reduce((sum, key) => sum + (isNonNegativeNumber(usage[key]) ? usage[key] : 0), 0)
}

/**
 * @param {object[]} messages Parsed assistant messages.
 * @returns {string} Final non-empty assistant text, or empty string.
 */
function finalAssistantText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isPlainObject(message)) continue
    const text = typeof message.text === 'string'
      ? message.text
      : readAssistantText(message.content)
    if (text.trim() !== '') return text
  }
  return ''
}

/**
 * @param {object} value Hand-built tool entry.
 * @returns {boolean} Whether the entry is a standalone result record.
 */
function isResultEntry(value) {
  if (!isPlainObject(value)) return false
  const type = eventTypeOf(value)
  if (type === 'tool/result') return true
  if (value.role === 'tool') return true
  return false
}

/**
 * @param {object} call Parsed or hand-built call.
 * @param {{ result: unknown, isError: boolean }} result Pairing result.
 * @returns {void}
 */
function applyResult(call, result) {
  call.result = result.result
  call.hasResult = true
  call.isError = result.isError === true
  if (isNonNegativeNumber(result.time)) call.resultTime = result.time
}

/**
 * @param {object} entry Standalone result record.
 * @returns {unknown} Result value.
 */
function toolResultValue(entry) {
  if (Object.hasOwn(entry, 'result') && entry.result !== undefined) return entry.result
  const data = payloadOf(entry)
  if (Object.hasOwn(data, 'result') && data.result !== undefined) return data.result
  const message = isPlainObject(data.message) ? data.message : data
  return readTextContent(firstDefined(message.content, message.text, data.content))
}

/**
 * @param {unknown} value Candidate session.
 * @returns {{ id: string|null, turns: number, toolCalls: object[], messages: object[] }} Normalised session.
 */
function normalizeSession(value) {
  if (!isPlainObject(value)) {
    throw new EvalError('INVALID_SESSION', 'session must be a plain object')
  }
  return {
    id: typeof value.id === 'string' && value.id.trim() !== '' ? value.id : null,
    turns: readInteger(value.turns) ?? 0,
    toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls : [],
    messages: Array.isArray(value.messages) ? value.messages : [],
  }
}

/**
 * @param {...unknown} values Candidates in priority order.
 * @returns {unknown} The first value that is not undefined.
 */
function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * @param {unknown} value Candidate turn or step number.
 * @returns {number|null} Non-negative integer or null.
 */
function readInteger(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

/**
 * @param {unknown} value Candidate epoch-millisecond timestamp.
 * @returns {number|null} Non-negative finite number or null.
 */
function readTime(value) {
  return isNonNegativeNumber(value) ? value : null
}

/**
 * @param {unknown} value Candidate number.
 * @returns {value is number} Whether it is a non-negative finite number.
 */
function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * @param {unknown} value Candidate value.
 * @returns {boolean} Whether it is a thenable.
 */
function isThenable(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function'
}

/**
 * @param {unknown} value Candidate value.
 * @returns {value is Record<string, unknown>} Whether it is a plain object.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
