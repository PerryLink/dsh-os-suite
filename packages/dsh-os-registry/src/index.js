import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRegistry, DEFAULT_TTL_MS, RegistryError } from './core.js'

export const name = 'dsh-os-registry'
export const inject = ['tools']

/** Default owner for tool calls that do not name one. */
const DEFAULT_OWNER = 'agent'

const serviceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Registry-local service id' },
    name: { type: 'string', required: true, description: 'Human-readable service name' },
    port: { type: 'integer', required: true, description: 'Allocated TCP port' },
    url: { type: 'string', required: true, description: 'Derived local URL' },
    owner: { type: 'string', required: true, description: 'Owner of the lease' },
    pid: { type: 'integer', description: 'Optional dev-server process id' },
    health: {
      type: 'string',
      required: true,
      enum: ['unknown', 'ok', 'down'],
      description: 'Last observed health',
    },
    ttlMs: { type: 'number', required: true, description: 'Lease duration in ms' },
    expiresAt: { type: 'number', required: true, description: 'Expiry timestamp in ms' },
    createdAt: { type: 'number', required: true, description: 'Registration timestamp in ms' },
  },
}

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true, description: 'Stable error code' },
    message: { type: 'string', required: true, description: 'Human-readable error message' },
  },
}

const registerOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    service: serviceSchema,
    error: errorSchema,
  },
}

const listOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    services: { type: 'array', items: serviceSchema },
    error: errorSchema,
  },
}

const stopOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    released: { type: 'boolean', description: 'Whether an active lease was removed' },
    error: errorSchema,
  },
}

/**
 * Convert a thrown error into a structured tool result.
 *
 * @param {unknown} error
 * @returns {{ ok: false, error: { code: string, message: string } }}
 */
function failure(error) {
  if (error instanceof RegistryError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  return {
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const registry = createRegistry()

  ctx.tools.register(
    defineTool({
      name: 'service_register',
      description:
        'Reserve a local port and register a dev-server lease before starting it. Omit port to get the lowest free port from the local pool. The returned port is safe to use until release or TTL expiry; this tool does not start the process.',
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: 'Short service name, for example "web" or "api"',
        },
        port: {
          type: 'integer',
          description: 'Preferred port; omit to allocate the lowest free pool port',
        },
        owner: {
          type: 'string',
          description: `Agent, job or session owning the lease (default "${DEFAULT_OWNER}")`,
        },
        ttlMs: {
          type: 'integer',
          description: `Lease duration in milliseconds (default ${DEFAULT_TTL_MS}, 30 minutes)`,
        },
        pid: {
          type: 'integer',
          description: 'Optional dev-server process id, recorded for debugging only',
        },
      },
      output: {
        schema: registerOutputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        try {
          return {
            ok: true,
            service: registry.register({
              name: args.name,
              port: args.port,
              owner: args.owner ?? DEFAULT_OWNER,
              ttlMs: args.ttlMs ?? DEFAULT_TTL_MS,
              pid: args.pid,
            }),
          }
        } catch (error) {
          return failure(error)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'service_list',
      description:
        'List active local service leases, sorted by port. Expired leases are reclaimed before listing. Optionally filter by owner.',
      parameters: {
        owner: {
          type: 'string',
          description: 'Only list leases owned by this agent, job or session',
        },
      },
      output: {
        schema: listOutputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        try {
          return { ok: true, services: registry.list({ owner: args.owner }) }
        } catch (error) {
          return failure(error)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'service_stop',
      description:
        'Release a local service lease by id so its port can be reused. This only removes the registry entry; it does not kill the process. Releasing an unknown id is a no-op.',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'Service id returned by service_register',
        },
      },
      output: {
        schema: stopOutputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        try {
          return { ok: true, released: registry.release(args.id) }
        } catch (error) {
          return failure(error)
        }
      },
    }),
  )
}
