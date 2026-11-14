import { defineTool } from '@deepseek-ai/dsh-tools'
import { COSTS, HEALTHS, KINDS, createCatalog } from './core.js'

export const name = 'dsh-os-catalog'
export const inject = ['tools']

/**
 * Shared JSON text renderer. The catalog returns plain JSON values only.
 * @param {unknown} _args
 * @param {unknown} value
 */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: renderJson,
}

/**
 * Register the catalog tools and seed the in-memory catalog.
 *
 * Config (all optional):
 * - `capabilities`: array of capability manifests to register at load time.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ capabilities?: object[] }} [config]
 */
export function apply(ctx, config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('dsh-os-catalog: config must be an object')
  }
  const seeds = config.capabilities ?? []
  if (!Array.isArray(seeds)) {
    throw new TypeError('dsh-os-catalog: config.capabilities must be an array')
  }

  const catalog = createCatalog(seeds)

  ctx.tools.register(
    defineTool({
      name: 'capability_search',
      description:
        'Find DSH capabilities (tools, plugins, MCP servers, skills, commands) by intent. ' +
        'Use this when you know what you want to do but not which capability implements it. ' +
        'Ranks exact intent matches before prefixes and substrings, and returns permissions, ' +
        'cost, health, and match reasons. Down capabilities are hidden unless includeDown is true.',
      parameters: {
        intent: {
          type: 'string',
          required: true,
          description:
            'What you want to do, in natural language, e.g. "convert markdown to pdf".',
        },
        kind: {
          type: 'string',
          enum: KINDS,
          description: 'Only return this capability kind.',
        },
        maxCost: {
          type: 'string',
          enum: COSTS,
          description: 'Only return capabilities at or below this cost tier.',
        },
        requirePermissions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Permissions currently available to the caller. Only capabilities whose permissions ' +
            'are fully covered are returned. Use ["*"] to ignore permission requirements.',
        },
        health: {
          type: 'string',
          enum: HEALTHS,
          description: 'Exact health filter. By default, down capabilities are hidden.',
        },
        includeDown: {
          type: 'boolean',
          description: 'Include down capabilities in results (default false).',
        },
        limit: {
          type: 'integer',
          description: 'Maximum hits to return, from 1 to 100 (default 20).',
        },
      },
      output,
      async execute(args) {
        /** @type {import('./core.js').SearchOptions} */
        const options = {}
        if (args.kind !== undefined) options.kind = args.kind
        if (args.maxCost !== undefined) options.maxCost = args.maxCost
        if (args.requirePermissions !== undefined) {
          options.requirePermissions = args.requirePermissions
        }
        if (args.health !== undefined) options.health = args.health
        if (args.includeDown !== undefined) options.includeDown = args.includeDown
        if (args.limit !== undefined) options.limit = args.limit
        return catalog.search(args.intent, options)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'capability_preflight',
      description:
        'Check whether a registered capability can run right now. Verifies declared health, ' +
        'cost against an optional budget, and whether the caller-granted permissions cover the ' +
        'declared requirements. Returns blockers (must fix) and warnings (risk only). ' +
        'This is advisory: it does not grant permissions or execute the capability.',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'Capability id to check.',
        },
        grantedPermissions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Permissions the caller currently holds. Supports exact ids and trailing-wildcard ' +
            'grants such as "fs.*" or "*".',
        },
        maxCost: {
          type: 'string',
          enum: COSTS,
          description: 'Optional cost budget; a dearer capability becomes a blocker.',
        },
      },
      output,
      async execute(args) {
        /** @type {{ grantedPermissions?: string[], maxCost?: import('./core.js').CapabilityCost }} */
        const options = {}
        if (args.grantedPermissions !== undefined) {
          options.grantedPermissions = args.grantedPermissions
        }
        if (args.maxCost !== undefined) options.maxCost = args.maxCost
        return catalog.preflight(args.id, options)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'capability_register',
      description:
        'Register a capability manifest in this process-local catalog so agents can discover it ' +
        'by intent. Duplicate ids are rejected. Registration is in-memory only and does not ' +
        'publish, install, or execute anything.',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'Stable unique id, e.g. "pdf.convert" or "mcp.github.create_issue".',
        },
        name: {
          type: 'string',
          description: 'Human-readable name (defaults to the id).',
        },
        kind: {
          type: 'string',
          enum: KINDS,
          required: true,
          description: 'Registry family: tool, plugin, mcp, skill, or command.',
        },
        intents: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Short natural-language intents, one per item. These are the primary search signal.',
        },
        inputs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Input names or types, e.g. ["markdown", "file path"].',
        },
        outputs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Output names or types, e.g. ["pdf", "summary"].',
        },
        permissions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Permission ids required before running, e.g. ["fs.read"].',
        },
        cost: {
          type: 'string',
          enum: COSTS,
          description: 'Declared cost tier (default cheap).',
        },
        health: {
          type: 'string',
          enum: HEALTHS,
          description: 'Declared health (default ok).',
        },
        meta: {
          type: 'json',
          description:
            'Optional JSON metadata (owner, version, docs URL). Returned to agents; never put ' +
            'secrets here.',
        },
      },
      output,
      async execute(args) {
        const capability = catalog.register({
          id: args.id,
          name: args.name,
          kind: args.kind,
          intents: args.intents,
          inputs: args.inputs,
          outputs: args.outputs,
          permissions: args.permissions,
          cost: args.cost,
          health: args.health,
          ...(args.meta !== undefined ? { meta: args.meta } : {}),
        })
        return { registered: true, capability }
      },
    }),
  )
}
