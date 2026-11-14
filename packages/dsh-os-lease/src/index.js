import { defineTool } from '@deepseek-ai/dsh-tools'
import { createLeaseManager, LeaseError } from './core.js'

export const name = 'dsh-os-lease'
export const inject = ['tools']

/** @type {{ type: 'object', additionalProperties: true }} */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
}

/**
 * @param {() => unknown} run
 * @returns {unknown}
 */
function runCore(run) {
  try {
    return run()
  } catch (error) {
    if (error instanceof LeaseError) {
      const wrapped = new Error(`${error.code}: ${error.message}`)
      wrapped.code = error.code
      if (error.details !== undefined) wrapped.details = error.details
      throw wrapped
    }
    throw error
  }
}

/**
 * @param {unknown} value
 */
function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * Register the workspace-lease tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const manager = createLeaseManager()

  ctx.tools.register(
    defineTool({
      name: 'workspace_lease',
      description:
        'Acquire, renew, release, or dry-run a workspace lease for a parallel agent. ' +
        'A lease reserves workspace-relative paths (segment-prefix overlap counts as a conflict) until ttlMs elapses. ' +
        'This MVP records intent only and never writes files.',
      parameters: {
        action: {
          type: 'string',
          enum: ['acquire', 'renew', 'release', 'check'],
          required: true,
          description: 'acquire | renew | release | check',
        },
        workspace: {
          type: 'string',
          description: 'Workspace key, required for acquire and check',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workspace-relative paths, required for acquire and check',
        },
        owner: {
          type: 'string',
          description: 'Agent/owner label, required for acquire',
        },
        ttlMs: {
          type: 'number',
          description: 'Lease lifetime in milliseconds; defaults to 900000',
        },
        id: {
          type: 'string',
          description: 'Lease id, required for renew and release',
        },
      },
      output: {
        schema: { ...OUTPUT_SCHEMA },
        render: (_args, value) => renderJson(value),
      },
      async execute(args) {
        return runCore(() => {
          switch (args.action) {
            case 'acquire':
              return {
                action: 'acquire',
                lease: manager.acquire({
                  workspace: args.workspace,
                  paths: args.paths,
                  owner: args.owner,
                  ttlMs: args.ttlMs,
                }),
              }
            case 'renew':
              return {
                action: 'renew',
                lease: manager.renew(args.id, args.ttlMs),
              }
            case 'release':
              return {
                action: 'release',
                lease: manager.release(args.id),
              }
            case 'check':
              return {
                action: 'check',
                ...manager.checkConflict({
                  workspace: args.workspace,
                  paths: args.paths,
                }),
              }
            default:
              throw new Error(`unknown workspace_lease action "${args.action}"`)
          }
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workspace_apply',
      description:
        'Prepare or commit a multi-file patchset under a live lease. ' +
        'prepare validates the lease, path coverage, and conflicts and records before/after bodies; ' +
        'commit returns the path-sorted write set. No files are written by this MVP, and a patchset cannot be committed twice.',
      parameters: {
        action: {
          type: 'string',
          enum: ['prepare', 'commit'],
          required: true,
          description: 'prepare | commit',
        },
        leaseId: {
          type: 'string',
          description: 'Authorizing lease id, required for prepare',
        },
        patchsetId: {
          type: 'string',
          description: 'Patchset id, required for commit',
        },
        files: {
          type: 'array',
          description: 'Planned files, required for prepare; paths must be covered by the lease',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: {
                type: 'string',
                required: true,
                description: 'Workspace-relative path',
              },
              before: {
                type: 'string',
                description: 'Optional pre-image recorded by the caller',
              },
              after: {
                type: 'string',
                required: true,
                description: 'Intended post-image',
              },
            },
          },
        },
      },
      output: {
        schema: { ...OUTPUT_SCHEMA },
        render: (_args, value) => renderJson(value),
      },
      async execute(args) {
        return runCore(() => {
          switch (args.action) {
            case 'prepare':
              return {
                action: 'prepare',
                patchset: manager.preparePatchset(args.leaseId, args.files),
              }
            case 'commit':
              return {
                action: 'commit',
                patchsetId: args.patchsetId,
                status: 'committed',
                writes: manager.commitPatchset(args.patchsetId),
              }
            default:
              throw new Error(`unknown workspace_apply action "${args.action}"`)
          }
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workspace_rollback',
      description:
        'Roll back a prepared or committed patchset and return its recorded pre-images sorted by path. ' +
        'Files staged without a before body are returned without one (new-file intent). ' +
        'This MVP returns a restore plan; it does not restore files, and a patchset cannot be rolled back twice.',
      parameters: {
        patchsetId: {
          type: 'string',
          required: true,
          description: 'Patchset id to roll back',
        },
      },
      output: {
        schema: { ...OUTPUT_SCHEMA },
        render: (_args, value) => renderJson(value),
      },
      async execute(args) {
        return runCore(() => ({
          patchsetId: args.patchsetId,
          status: 'rolledBack',
          restores: manager.rollbackPatchset(args.patchsetId),
        }))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workspace_status',
      description:
        'Report lease and patchset state: every lease with expiry/status, path-only patchset summaries, and counts. ' +
        'Stale leases are marked expired before the snapshot is returned.',
      parameters: {},
      output: {
        schema: { ...OUTPUT_SCHEMA },
        render: (_args, value) => renderJson(value),
      },
      async execute() {
        return runCore(() => manager.status())
      },
    }),
  )
}
