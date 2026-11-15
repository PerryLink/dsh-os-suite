import { defineTool } from '@deepseek-ai/dsh-tools'
import { createLeaseManager, LeaseError } from './core.js'
import {
  APPLY_ERROR_CODES,
  ApplyError,
  applyPatchset,
  readJournal,
  rollback,
} from './apply.js'

export const name = 'dsh-os-lease'
export const inject = ['tools']

/** @type {{ type: 'object', additionalProperties: true }} */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
}

/**
 * @param {unknown} error
 * @returns {unknown}
 */
function toToolError(error) {
  if (error instanceof LeaseError || error instanceof ApplyError) {
    const wrapped = new Error(`${error.code}: ${error.message}`)
    wrapped.code = error.code
    if (error.details !== undefined) wrapped.details = error.details
    return wrapped
  }
  return error
}

/**
 * @param {() => unknown} run
 * @returns {unknown}
 */
function runCore(run) {
  try {
    return run()
  } catch (error) {
    throw toToolError(error)
  }
}

/**
 * @param {() => Promise<unknown>} run
 * @returns {Promise<unknown>}
 */
async function runCoreAsync(run) {
  try {
    return await run()
  } catch (error) {
    throw toToolError(error)
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
 *
 * By default the plugin is **dry-run only**: commit and rollback return plans
 * and never touch the filesystem. Setting `config.apply === true` together
 * with an explicit `config.root` turns commit into a real applier and makes
 * rollback restore the matching journal. `config.verifyBefore` additionally
 * rejects a write when the caller's `before` body does not match the file on
 * disk.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ apply?: boolean, root?: string, verifyBefore?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('dsh-os-lease: config must be an object')
  }
  if (config.apply !== undefined && typeof config.apply !== 'boolean') {
    throw new TypeError('dsh-os-lease: config.apply must be a boolean')
  }
  if (config.verifyBefore !== undefined && typeof config.verifyBefore !== 'boolean') {
    throw new TypeError('dsh-os-lease: config.verifyBefore must be a boolean')
  }
  if (
    config.root !== undefined &&
    (typeof config.root !== 'string' || config.root.trim() === '')
  ) {
    throw new TypeError('dsh-os-lease: config.root must be a non-empty string')
  }
  const writeEnabled = config.apply === true
  const writeRoot = typeof config.root === 'string' ? config.root : undefined
  const verifyBefore = config.verifyBefore === true
  if (writeEnabled && writeRoot === undefined) {
    throw new TypeError('dsh-os-lease: config.apply=true requires config.root')
  }

  const manager = createLeaseManager()

  ctx.tools.register(
    defineTool({
      name: 'workspace_lease',
      description:
        'Acquire, renew, release, or dry-run a workspace lease for a parallel agent. ' +
        'A lease reserves workspace-relative paths (segment-prefix overlap counts as a conflict) until ttlMs elapses. ' +
        'This tool records intent only and never writes files.',
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
        'commit returns the path-sorted write set. This is dry-run by default and never writes files. ' +
        'When the plugin is configured with apply:true and root, commit also writes each file atomically under root, ' +
        'backs up pre-images under .dsh-os-lease/journal/<patchsetId>/, and returns the journal. ' +
        'A patchset cannot be committed twice.',
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
        return runCoreAsync(async () => {
          switch (args.action) {
            case 'prepare':
              return {
                action: 'prepare',
                patchset: manager.preparePatchset(args.leaseId, args.files),
              }
            case 'commit': {
              // Snapshot before the one-way transition: the applier needs the
              // before/after bodies, which commit's path-only write set omits.
              const patchset = manager.getPatchset(args.patchsetId)
              const writes = manager.commitPatchset(args.patchsetId)
              const result = {
                action: 'commit',
                patchsetId: args.patchsetId,
                status: 'committed',
                writes,
              }
              if (!writeEnabled) return result
              try {
                const journal = await applyPatchset(patchset, {
                  root: writeRoot,
                  verifyBefore,
                })
                return { ...result, applied: true, journal }
              } catch (error) {
                if (error instanceof ApplyError) {
                  if (error.code === APPLY_ERROR_CODES.ALREADY_APPLIED) {
                    // No target was written: createJournalDirectory runs before
                    // any backup or write. Keep the in-memory patchset aligned
                    // with the untouched tree so the caller can retry with a
                    // fresh patchset id.
                    try {
                      manager.rollbackPatchset(args.patchsetId)
                    } catch {
                      // Best effort; the original error is more useful.
                    }
                    error.details = {
                      ...(error.details ?? {}),
                      patchsetId: args.patchsetId,
                      hint: 'journal id already exists; use a fresh patchset id',
                    }
                  } else {
                    error.details = {
                      ...(error.details ?? {}),
                      patchsetId: args.patchsetId,
                      hint:
                        'the patchset is committed; call workspace_rollback to restore the workspace',
                    }
                  }
                }
                throw error
              }
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
        'This is dry-run by default. When the plugin is configured with root and a matching journal exists, ' +
        'rollback also restores pre-images and deletes new files in reverse apply order, then marks the journal rolled back. ' +
        'A patchset cannot be rolled back twice.',
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
        return runCoreAsync(async () => {
          // Validate the patchset before touching disk, but keep the manager
          // transition until after the journal restore succeeds.
          const patchset = manager.getPatchset(args.patchsetId)
          let diskRollback = null
          if (writeRoot !== undefined) {
            try {
              const journal = await readJournal(patchset.id, { root: writeRoot })
              const journalPaths = journal.files.map((file) => file.path).sort()
              const patchsetPaths = patchset.files.map((file) => file.path).sort()
              if (
                journalPaths.length !== patchsetPaths.length ||
                journalPaths.some((filePath, index) => filePath !== patchsetPaths[index])
              ) {
                throw new ApplyError(
                  APPLY_ERROR_CODES.JOURNAL_CORRUPT,
                  `journal "${journal.id}" paths do not match patchset "${patchset.id}"; ` +
                    'refusing to roll back an unrelated journal',
                  {
                    patchsetId: patchset.id,
                    journalPath: journal.journalPath,
                    journalPaths,
                    patchsetPaths,
                  },
                )
              }
              diskRollback = await rollback(journal)
            } catch (error) {
              if (error instanceof ApplyError && error.code === APPLY_ERROR_CODES.NOT_FOUND) {
                // No journal means this patchset was never applied: the plan
                // below is the complete rollback.
                if (error.details?.missing !== 'journalDir') throw error
              } else {
                throw error
              }
            }
          }
          const restores = manager.rollbackPatchset(args.patchsetId)
          const result = {
            patchsetId: args.patchsetId,
            status: 'rolledBack',
            restores,
          }
          if (writeRoot === undefined) return result
          return {
            ...result,
            appliedRollback: diskRollback !== null,
            ...(diskRollback === null
              ? {}
              : {
                  journalPath: diskRollback.journalPath,
                  rollback: diskRollback,
                }),
          }
        })
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
