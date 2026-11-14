import { defineTool } from '@deepseek-ai/dsh-tools'
import { createGovernor } from './core.js'

export const name = 'dsh-os-quota'
export const inject = ['tools']

/**
 * @typedef {{ type: 'text', text: string }} TextBlock
 */

/**
 * JSON has no Infinity; the ledger uses it to mean "unlimited". Serializing
 * turns it into null, which the README documents as the wire spelling.
 * @param {unknown} value
 * @returns {TextBlock[]}
 */
function renderValue(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** @type {{ schema: object, render: (args: object, value: unknown) => TextBlock[] }} */
const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => renderValue(value),
}

const scopeParam = {
  type: 'string',
  required: true,
  description: 'Budget scope id, for example "session:abc" or "agent:lead". Scopes are isolated ledgers.',
}

const optionalLimitParams = {
  tokens: {
    oneOf: [{ type: 'number' }, { type: 'null' }],
    description: 'Token budget for this scope. null means unlimited; omit to leave unchanged.',
  },
  jobs: {
    oneOf: [{ type: 'number' }, { type: 'null' }],
    description: 'Job budget for this window (job starts or job-seconds; caller-defined). null means unlimited.',
  },
  diskMb: {
    oneOf: [{ type: 'number' }, { type: 'null' }],
    description: 'Disk budget in MB. null means unlimited; omit to leave unchanged.',
  },
}

const optionalAmountParams = {
  tokens: { type: 'number', description: 'Tokens to charge (non-negative; negative values book 0).' },
  jobs: { type: 'number', description: 'Job slots to charge (non-negative; negative values book 0).' },
  diskMb: { type: 'number', description: 'Disk MB to charge (non-negative; negative values book 0).' },
}

/**
 * Register the four quota tools.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] Optional Cordis plugin config.
 * @param {Partial<{tokens: number | null, jobs: number | null, diskMb: number | null}>} [config.limits]
 *   Default limits for newly seen scopes; omitted dimensions are unlimited.
 * @param {number} [config.softRatio] Soft threshold in (0, 1]; defaults to 0.8.
 * @param {number} [config.windowMs] Optional automatic window length.
 * @param {import('./core.js').Scope[]} [config.scopes] Optional seed scopes.
 * @param {(() => number | Date) | number | Date} [config.now] Optional clock
 *   override; intended for embedding and tests, not for normal profiles.
 */
export function apply(ctx, config = {}) {
  const options = config !== null && typeof config === 'object' ? config : {}
  const governor = createGovernor({
    now: options.now,
    limits: options.limits,
    softRatio: options.softRatio,
    windowMs: options.windowMs,
    scopes: options.scopes,
  })

  ctx.tools.register(
    defineTool({
      name: 'quota_status',
      description:
        'Read the token/job/disk ledger for one scope, or list every known scope. ' +
        'Reports limits, usage, remaining budget and level (ok/soft/hard). This is accounting only and never blocks a real call.',
      parameters: {
        scope: { type: 'string', description: 'Scope id to inspect; omit to list every known scope.' },
      },
      output,
      isConcurrencySafe: () => true,
      async execute(args) {
        if (args.scope === undefined || args.scope === '') return { scopes: governor.list() }
        return governor.status(args.scope)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'quota_set',
      description:
        'Set or lower the token/job/disk limits of a scope. Partial updates keep other dimensions unchanged. ' +
        'Use null for an unlimited dimension. Limits are inclusive: usage up to the limit is allowed.',
      parameters: {
        scope: scopeParam,
        ...optionalLimitParams,
      },
      output,
      async execute(args) {
        return governor.setLimits(args.scope, {
          tokens: args.tokens,
          jobs: args.jobs,
          diskMb: args.diskMb,
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'quota_admit',
      description:
        'Project a prospective token/job/disk spend without booking it. Returns allowed=true at ok or soft ' +
        '(soft means degraded: degrade=true), and allowed=false at hard. Advisory only in this MVP.',
      parameters: {
        scope: scopeParam,
        ...optionalAmountParams,
      },
      output,
      async execute(args) {
        return governor.admit(args)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'quota_consume',
      description:
        'Book actual token/job/disk usage for a scope. Bookings always accumulate, even past a hard limit; ' +
        'the result then has allowed=false and reports the amount over budget in overBy.',
      parameters: {
        scope: scopeParam,
        ...optionalAmountParams,
      },
      output,
      async execute(args) {
        return governor.consume(args)
      },
    }),
  )

  return governor
}
