import { defineTool } from '@deepseek-ai/dsh-tools'
import { createGovernor } from './core.js'
import { createEnforcer } from './enforce.js'
import { attachTokenMeter, METER_DEDUPE_KEY, METER_EVENT_TYPES } from './meter.js'

export { createEnforcer, QuotaDeniedError } from './enforce.js'
export { attachTokenMeter, METER_DEDUPE_KEY, METER_EVENT_TYPES, tokensOfUsage } from './meter.js'

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

/** @param {unknown} value @returns {boolean} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Counters reported by `quota_meter_status` before the meter is attached. */
function emptyMeterCounters() {
  return { events: 0, assistantEvents: 0, consumed: 0, duplicates: 0, skipped: 0, errors: 0, tokens: 0 }
}

/**
 * Read-only meter report for profiles that leave `autoMeter` off. The shape
 * matches `attachTokenMeter(...).stats` so the status tool never changes shape.
 * @param {boolean} customScope
 * @returns {object}
 */
function detachedMeterStats(customScope) {
  return {
    attached: false,
    eventTypes: METER_EVENT_TYPES,
    dedupeKey: METER_DEDUPE_KEY,
    scopeSource: customScope ? 'scopeOf(session)' : 'session.id',
    counters: emptyMeterCounters(),
    sessions: 0,
    last: null,
    lastError: null,
  }
}

/**
 * Register the four budget tools plus `quota_enforce_status`, and attach the
 * opt-in pre-execute gate when `config.enforce` is true.
 *
 * When `config.autoMeter` is true, also subscribe to `session/event` and book
 * provider-reported usage from `assistant/message` / `assistant/attempt`.
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
 * @param {boolean | {enabled?: boolean, scope?: string, costOf?: object | Function, onDeny?: Function, throwOnDeny?: boolean, ignore?: string[]}} [config.enforce]
 *   Opt-in tool-call enforcement. `true` attaches the `tools/pre-execute`
 *   waterfall and the result-usage consumer. Pass an object to configure the
 *   same adapter inline (`enabled` defaults to true in that form).
 * @param {boolean} [config.autoMeter=false] Opt-in automatic session usage:
 *   subscribe to `session/event` and consume provider-reported token usage.
 * @param {(session: object) => string} [config.scopeOf] Optional scope resolver
 *   for auto-metered sessions; defaults to `session.id`.
 * @param {string | ((call: object) => string)} [config.scope] Scope used by the
 *   enforcement adapter when a call does not name one.
 * @param {Record<string, unknown> | ((name: string, call: object) => unknown)} [config.costOf]
 *   Per-tool cost estimate. A number means tokens; an object may contain
 *   `tokens`, `jobs` and `diskMb`.
 * @param {Record<string, unknown>} [config.costs] Convenience map used as
 *   `costOf` when `config.costOf` is absent.
 * @param {(decision: object, call: object, error: Error) => void} [config.onDeny]
 *   Observer called on every hard denial.
 * @param {boolean} [config.throwOnDeny=false] Throw instead of returning a
 *   denial object (returning is preferred by the DSH waterfall contract).
 * @param {string[]} [config.enforceIgnore] Additional tool names never gated;
 *   `quota_*` tools are always ignored.
 */
export function apply(ctx, config = {}) {
  const options = isRecord(config) ? config : {}
  const governor = createGovernor({
    now: options.now,
    limits: options.limits,
    softRatio: options.softRatio,
    windowMs: options.windowMs,
    scopes: options.scopes,
  })

  const enforceOption = options.enforce
  const enforcePolicy = isRecord(enforceOption) ? enforceOption : {}
  const enforceEnabled = enforceOption === true || (isRecord(enforceOption) && enforcePolicy.enabled !== false)
  const costs = isRecord(options.costs) ? options.costs : undefined
  const costOf = enforcePolicy.costOf
    ?? options.costOf
    ?? (costs === undefined
      ? undefined
      : (toolName) => Object.hasOwn(costs, toolName) ? costs[toolName] : costs['*'])

  const enforcer = createEnforcer({
    governor,
    enabled: enforceEnabled,
    costOf,
    scope: enforcePolicy.scope ?? options.enforceScope ?? options.scope,
    onDeny: enforcePolicy.onDeny ?? options.onDeny,
    throwOnDeny: enforcePolicy.throwOnDeny ?? options.throwOnDeny,
    ignore: enforcePolicy.ignore ?? options.enforceIgnore,
    now: options.now,
  })

  const scopeOf = typeof options.scopeOf === 'function' ? options.scopeOf : undefined
  const autoMeter = options.autoMeter === true
  const meter = autoMeter
    ? attachTokenMeter(ctx, { governor, scopeOf, now: options.now })
    : null

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
        '(soft means degraded: degrade=true), and allowed=false at hard. The tool itself is advisory; ' +
        'pre-execute enforcement is configured separately with enforce=true.',
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

  ctx.tools.register(
    defineTool({
      name: 'quota_enforce_status',
      description:
        'Report opt-in pre-execute enforcement: whether the host hook is attached, the policy/config in use, ' +
        'admission/denial/degradation counters, the last decision, and the current scope ledgers. ' +
        'Read-only; it never changes a budget and is itself never gated.',
      parameters: {
        scope: { type: 'string', description: 'Optional scope id whose ledger to include as scopeStatus.' },
      },
      output,
      isConcurrencySafe: () => true,
      async execute(args) {
        const snapshot = enforcer.status()
        return {
          ...snapshot,
          scopes: governor.list(),
          ...(typeof args.scope === 'string' && args.scope !== ''
            ? { scopeStatus: governor.status(args.scope) }
            : {}),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'quota_meter_status',
      description:
        'Report automatic session-usage metering: whether autoMeter is attached, the events/counters it observed, ' +
        'how token samples are charged, the last booking or skip, and current scope ledgers. Read-only and ' +
        'never gated. It reads committed session usage events only; it does not read token-meter pressure or ' +
        'interrupt a request.',
      parameters: {
        scope: { type: 'string', description: 'Optional scope id whose ledger to include as scopeStatus.' },
      },
      output,
      isConcurrencySafe: () => true,
      async execute(args) {
        const report = meter === null ? detachedMeterStats(scopeOf !== undefined) : meter.stats
        return {
          enabled: autoMeter,
          autoMeter,
          ...report,
          scopes: governor.list(),
          ...(typeof args.scope === 'string' && args.scope !== ''
            ? { scopeStatus: governor.status(args.scope) }
            : {}),
        }
      },
    }),
  )

  if (enforceEnabled) enforcer.attach(ctx)

  // Keep apply()'s public return value (the governor) stable while exposing the
  // adapters for embedding/tests without changing enumerable shape.
  Object.defineProperty(governor, 'enforcer', {
    value: enforcer,
    enumerable: false,
    configurable: true,
  })
  Object.defineProperty(governor, 'meter', {
    value: meter,
    enumerable: false,
    configurable: true,
  })

  return governor
}
