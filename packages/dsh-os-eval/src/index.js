import { defineTool } from '@deepseek-ai/dsh-tools'
import { createEvalStore } from './core.js'

export const name = 'dsh-os-eval'
export const inject = ['tools']

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * @typedef {object} EvalPluginConfig
 * @property {import('./core.js').EvalCase[]} [cases] Cases loaded at activation.
 * @property {import('./core.js').Baseline[]} [baselines] Baselines loaded at activation.
 * @property {(evalCase: import('./core.js').EvalCase) => object} [runner] Optional
 *   synchronous host runner. When absent, `eval_run` uses its mock argument.
 */

/**
 * Register the eval tools. All execution is delegated to the pure store in
 * `core.js`; this module only adapts tool arguments.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis context with `tools`.
 * @param {EvalPluginConfig} [config] Plugin config from the bundle row.
 */
export function apply(ctx, config = {}) {
  const options = config ?? {}
  const store = createEvalStore()

  for (const evalCase of options.cases ?? []) store.defineCase(evalCase)
  for (const baseline of options.baselines ?? []) store.setBaseline(baseline)

  if (options.runner !== undefined && typeof options.runner !== 'function') {
    throw new TypeError('dsh-os-eval: config.runner must be a synchronous function')
  }

  ctx.tools.register(defineTool({
    name: 'eval_run',
    description:
      'Run one eval case through an injected mock runner, grade it, and record the latest run. '
      + 'Never calls a model or reads a session.',
    parameters: {
      caseId: {
        type: 'string',
        required: true,
        description: 'Id of a configured case, or of the optional inline case.',
      },
      case: {
        type: 'json',
        description:
          'Optional inline Case { id, name, input, expect, tags? }. Defining an existing id is an error.',
      },
      mock: {
        type: 'object',
        additionalProperties: false,
        description:
          'Mock runner result. Used only when apply() did not inject a host runner. '
          + 'Defaults: output echoes the case input, steps/tokens/latencyMs are 0.',
        properties: {
          output: { type: 'json', description: 'Mock output; defaults to the case input as text.' },
          steps: { type: 'number', description: 'Mock step count.' },
          tokens: { type: 'number', description: 'Mock token count.' },
          latencyMs: { type: 'number', description: 'Mock latency in milliseconds.' },
        },
      },
      baseline: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional baseline to store and compare with this run.',
        properties: {
          passRate: {
            type: 'number',
            required: true,
            description: 'Historical pass rate in [0, 1].',
          },
          p50Tokens: {
            type: 'number',
            required: true,
            description: 'Historical median token usage.',
          },
        },
      },
    },
    output,
    async execute(args) {
      if (args.case !== undefined) store.defineCase(args.case)

      const mock = args.mock ?? {}
      const runner = options.runner ?? ((evalCase) => createMockRun(evalCase, mock))
      const run = store.runCase(args.caseId, runner)

      let comparison = null
      if (args.baseline !== undefined) {
        comparison = store.compareToBaseline(args.caseId, {
          caseId: args.caseId,
          passRate: args.baseline.passRate,
          p50Tokens: args.baseline.p50Tokens,
        })
      }

      return { run, comparison }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'eval_gate',
    description:
      'Evaluate stored eval runs against CI policy and return PASS, WARN, or FAIL with the affected '
      + 'case ids and reasons. Does not execute cases.',
    parameters: {
      maxFailRatio: {
        type: 'number',
        description: 'Allowed fraction of failed runs in [0, 1]. Default 0 (any failure fails).',
      },
      maxTokenRegression: {
        type: 'number',
        description: 'Allowed fractional token increase over baseline p50. Default 0.2 (+20%).',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only evaluate cases carrying every listed tag.',
      },
    },
    output,
    async execute(args) {
      return store.gate(args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'eval_report',
    description:
      'Summarise eval cases and their latest runs as counts, tokens, status, and failure reasons. '
      + 'Never includes raw runner output.',
    parameters: {
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include cases carrying every listed tag.',
      },
    },
    output,
    async execute(args) {
      return store.report(args)
    },
  }))
}

/**
 * Deterministic mock runner used when the host injected no runner. It is a
 * test fixture, not a model adapter.
 *
 * @param {import('./core.js').EvalCase} evalCase Case being run.
 * @param {object} mock Mock values supplied through the `eval_run` tool.
 * @returns {{ output: unknown, steps: number, tokens: number, latencyMs: number }} Mock run result.
 */
function createMockRun(evalCase, mock) {
  return {
    output: Object.hasOwn(mock, 'output') ? mock.output : inputAsText(evalCase.input),
    steps: mock.steps ?? 0,
    tokens: mock.tokens ?? 0,
    latencyMs: mock.latencyMs ?? 0,
  }
}

/**
 * @param {unknown} input Case input.
 * @returns {string} Text form used by the default mock.
 */
function inputAsText(input) {
  if (typeof input === 'string') return input
  if (input === undefined) return ''
  try {
    const text = JSON.stringify(input)
    return text === undefined ? String(input) : text
  } catch {
    return String(input)
  }
}
