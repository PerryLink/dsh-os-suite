/**
 * Pure lease and patchset logic for dsh-os-lease.
 *
 * This module deliberately has **no** `@deepseek-ai/*` imports and never
 * touches the filesystem. A `LeaseManager` only records intent: which agent
 * reserved which workspace paths until when, and which staged file bodies a
 * caller plans to write. The host (or a future applier) is responsible for
 * actually reading and writing files.
 *
 * Paths are workspace-relative, POSIX-style strings. Backslashes are accepted
 * as a portability convenience and normalized to `/`. Absolute paths, `.`
 * segments, and `..` segments are rejected so a lease can never escape its
 * workspace.
 */

/** Default lease lifetime: 15 minutes. */
export const DEFAULT_TTL_MS = 15 * 60 * 1000

/**
 * Stable machine-readable error codes. Tools may surface these to agents.
 * @readonly
 */
export const LEASE_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_PATH: 'INVALID_PATH',
  NOT_FOUND: 'NOT_FOUND',
  DUPLICATE_PATH: 'DUPLICATE_PATH',
  PATH_NOT_LEASED: 'PATH_NOT_LEASED',
  CONFLICT: 'CONFLICT',
  PATCHSET_CONFLICT: 'PATCHSET_CONFLICT',
  LEASE_EXPIRED: 'LEASE_EXPIRED',
  LEASE_RELEASED: 'LEASE_RELEASED',
  ALREADY_RELEASED: 'ALREADY_RELEASED',
  ALREADY_COMMITTED: 'ALREADY_COMMITTED',
  ALREADY_ROLLED_BACK: 'ALREADY_ROLLED_BACK',
})

/**
 * Error thrown by every manager precondition failure.
 */
export class LeaseError extends Error {
  /**
   * @param {string} code One of {@link LEASE_ERROR_CODES}.
   * @param {string} message Human-readable explanation.
   * @param {Record<string, unknown>} [details] Optional structured context.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'LeaseError'
    /** @type {string} */
    this.code = code
    if (details !== undefined) {
      /** @type {Record<string, unknown>} */
      this.details = details
    }
  }
}

/**
 * @typedef {'active' | 'expired' | 'released'} LeaseStatus
 * @typedef {'prepared' | 'committed' | 'rolledBack'} PatchsetStatus
 */

/**
 * @typedef {object} Lease
 * @property {string} id Caller-visible lease id, unique within one manager.
 * @property {string} workspace Normalized workspace key.
 * @property {string[]} paths Normalized, deduplicated workspace-relative paths.
 * @property {string} owner Free-form owner label, e.g. an agent name.
 * @property {number} ttlMs Lifetime granted by the latest acquire/renew.
 * @property {number} expiresAt Epoch ms; at `now >= expiresAt` the lease is stale.
 * @property {LeaseStatus} status
 * @property {number} createdAt Epoch ms.
 */

/**
 * @typedef {object} PatchFile
 * @property {string} path Normalized workspace-relative path.
 * @property {string} [before] Pre-image supplied by the caller; never read from disk.
 * @property {string} after Intended post-image.
 */

/**
 * @typedef {object} Patchset
 * @property {string} id Caller-visible patchset id, unique within one manager.
 * @property {string} leaseId Lease that authorizes the files.
 * @property {PatchFile[]} files Normalized, path-unique files.
 * @property {PatchsetStatus} status
 * @property {number} createdAt Epoch ms.
 * @property {number} [committedAt] Epoch ms.
 * @property {number} [rolledBackAt] Epoch ms.
 */

/**
 * @typedef {object} Conflict
 * @property {string} leaseId Active lease that owns the overlapping path.
 * @property {string} owner
 * @property {string} path Requested (normalized) path.
 * @property {string} leasePath Path held by the other lease.
 * @property {'exact' | 'prefix'} reason
 */

/**
 * @typedef {object} CheckConflictResult
 * @property {string} workspace Normalized workspace key.
 * @property {string[]} paths Normalized requested paths.
 * @property {boolean} conflict
 * @property {Conflict[]} conflicts
 * @property {number} checkedAt Epoch ms.
 */

/**
 * @typedef {object} LeaseManagerOptions
 * @property {() => number} [now] Injectable clock returning epoch milliseconds.
 * @property {number} [defaultTtlMs] TTL used when acquire omits `ttlMs`.
 */

/**
 * @typedef {object} LeaseManager
 * @property {(input: { workspace: string, paths: string[], owner: string, ttlMs?: number }) => Lease} acquire
 * @property {(id: string, ttlMs?: number) => Lease} renew
 * @property {(id: string) => Lease} release
 * @property {() => { now: number, defaultTtlMs: number, leases: Lease[], patchsets: PatchsetSummary[], counts: Record<string, Record<string, number>> }} status
 * @property {(input: { workspace: string, paths: string[] }) => CheckConflictResult} checkConflict
 * @property {(leaseId: string, files: Array<{ path: string, before?: string, after: string }>) => Patchset} preparePatchset
 * @property {(id: string) => Patchset} getPatchset
 * @property {(id: string) => Array<{ path: string, after: string }>} commitPatchset
 * @property {(id: string) => Array<{ path: string, before?: string }>} rollbackPatchset
 */

/**
 * @typedef {object} PatchsetSummary
 * @property {string} id
 * @property {string} leaseId
 * @property {PatchsetStatus} status
 * @property {string[]} paths
 * @property {number} fileCount
 * @property {number} createdAt
 * @property {number} [committedAt]
 * @property {number} [rolledBackAt]
 */

const CONTROL_CHARS = /[\u0000-\u001f]/
const ABSOLUTE_POSIX = /^\//
const ABSOLUTE_DRIVE = /^[A-Za-z]:(?:\/|$)/

/**
 * Normalize a workspace key for equality checks.
 *
 * Backslashes become `/`, surrounding whitespace is trimmed, and trailing
 * slashes are removed. Case is preserved: the manager treats workspaces as
 * opaque keys rather than resolving them through the host filesystem.
 *
 * @param {unknown} workspace
 * @returns {string}
 * @throws {LeaseError} INVALID_ARGUMENT for a missing/blank workspace.
 */
export function normalizeWorkspace(workspace) {
  if (typeof workspace !== 'string') {
    throw new LeaseError(LEASE_ERROR_CODES.INVALID_ARGUMENT, 'workspace must be a string')
  }
  let normalized = workspace.trim().replace(/\\/g, '/')
  if (normalized === '') {
    throw new LeaseError(LEASE_ERROR_CODES.INVALID_ARGUMENT, 'workspace must not be blank')
  }
  if (CONTROL_CHARS.test(normalized)) {
    throw new LeaseError(
      LEASE_ERROR_CODES.INVALID_ARGUMENT,
      'workspace must not contain control characters',
    )
  }
  normalized = normalized.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return normalized === '' ? '/' : normalized
}

/**
 * Normalize one workspace-relative path.
 *
 * Accepted:
 * - `src/a.js`
 * - `./src/a.js`
 * - `src\\a.js` (Windows-style separators)
 * - `src//a.js` and `src/a.js/` (redundant separators)
 *
 * Rejected: non-strings, blank strings, absolute paths, drive-letter paths,
 * control characters, and paths containing `.` or `..` segments.
 *
 * @param {unknown} value
 * @returns {string}
 * @throws {LeaseError} INVALID_PATH for any rejected path.
 */
export function normalizePath(value) {
  if (typeof value !== 'string') {
    throw new LeaseError(LEASE_ERROR_CODES.INVALID_PATH, 'path must be a string', { path: value })
  }
  let normalized = value.trim().replace(/\\/g, '/')
  if (normalized === '') {
    throw new LeaseError(LEASE_ERROR_CODES.INVALID_PATH, 'path must not be blank', { path: value })
  }
  if (CONTROL_CHARS.test(normalized)) {
    throw new LeaseError(
      LEASE_ERROR_CODES.INVALID_PATH,
      'path must not contain control characters',
      { path: value },
    )
  }
  normalized = normalized.replace(/\/{2,}/g, '/')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  normalized = normalized.replace(/\/+$/, '')
  if (normalized === '') {
    throw new LeaseError(LEASE_ERROR_CODES.INVALID_PATH, 'path must not be the workspace root', {
      path: value,
    })
  }
  if (ABSOLUTE_POSIX.test(normalized) || ABSOLUTE_DRIVE.test(normalized)) {
    throw new LeaseError(
      LEASE_ERROR_CODES.INVALID_PATH,
      'path must be workspace-relative',
      { path: value },
    )
  }
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new LeaseError(
        LEASE_ERROR_CODES.INVALID_PATH,
        'path must not contain empty, "." or ".." segments',
        { path: value },
      )
    }
  }
  return normalized
}

/**
 * Whether two normalized paths overlap on a segment boundary.
 * `src/a` overlaps `src/a`, `src/a/b`, and `src/a/b/c`, but not `src/ab`.
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function overlapsNormalized(left, right) {
  if (left === right) return true
  return left.startsWith(right + '/') || right.startsWith(left + '/')
}

/**
 * Segment-aware prefix overlap check for workspace-relative paths.
 * Both inputs are normalized first.
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 * @throws {LeaseError} INVALID_PATH if either input is invalid.
 */
export function pathsOverlap(left, right) {
  return overlapsNormalized(normalizePath(left), normalizePath(right))
}

/**
 * Whether one file path falls inside a set of leased roots. A lease on
 * `src/a` covers `src/a` and `src/a/b.ts`; it does not cover `src/ab`.
 * @param {string} path
 * @param {string[]} roots
 * @returns {boolean}
 * @throws {LeaseError} INVALID_PATH if any input path is invalid.
 */
export function isPathCovered(path, roots) {
  const normalized = normalizePath(path)
  if (!Array.isArray(roots)) {
    throw new LeaseError(LEASE_ERROR_CODES.INVALID_ARGUMENT, 'roots must be an array of paths')
  }
  return roots.some((root) => {
    const normalizedRoot = normalizePath(root)
    return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + '/')
  })
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LeaseError(LEASE_ERROR_CODES.INVALID_ARGUMENT, `${name} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function resolveTtl(value, fallback) {
  const ttl = value === undefined ? fallback : value
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
    throw new LeaseError(LEASE_ERROR_CODES.INVALID_ARGUMENT, 'ttlMs must be a positive finite number')
  }
  return ttl
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string[]}
 */
function requirePathArray(value, name) {
  if (!Array.isArray(value)) {
    throw new LeaseError(LEASE_ERROR_CODES.INVALID_ARGUMENT, `${name} must be an array of paths`)
  }
  return value.map((path) => normalizePath(path))
}

/**
 * @param {Lease} lease
 * @returns {Lease}
 */
function snapshotLease(lease) {
  return {
    id: lease.id,
    workspace: lease.workspace,
    paths: [...lease.paths],
    owner: lease.owner,
    ttlMs: lease.ttlMs,
    expiresAt: lease.expiresAt,
    status: lease.status,
    createdAt: lease.createdAt,
  }
}

/**
 * @param {Patchset} patchset
 * @returns {Patchset}
 */
function snapshotPatchset(patchset) {
  return {
    id: patchset.id,
    leaseId: patchset.leaseId,
    files: patchset.files.map((file) => ({
      path: file.path,
      ...(file.before === undefined ? {} : { before: file.before }),
      after: file.after,
    })),
    status: patchset.status,
    createdAt: patchset.createdAt,
    ...(patchset.committedAt === undefined ? {} : { committedAt: patchset.committedAt }),
    ...(patchset.rolledBackAt === undefined ? {} : { rolledBackAt: patchset.rolledBackAt }),
  }
}

/**
 * @param {Patchset} patchset
 * @returns {PatchsetSummary}
 */
function summarizePatchset(patchset) {
  return {
    id: patchset.id,
    leaseId: patchset.leaseId,
    status: patchset.status,
    paths: patchset.files.map((file) => file.path),
    fileCount: patchset.files.length,
    createdAt: patchset.createdAt,
    ...(patchset.committedAt === undefined ? {} : { committedAt: patchset.committedAt }),
    ...(patchset.rolledBackAt === undefined ? {} : { rolledBackAt: patchset.rolledBackAt }),
  }
}

/**
 * @param {Array<{ path: string }>} files
 * @returns {number}
 */
function compareByPath(left, right) {
  if (left.path < right.path) return -1
  if (left.path > right.path) return 1
  return 0
}

/**
 * Create an isolated lease manager. All state lives in this closure; there is
 * no module-level singleton and no filesystem access.
 *
 * @param {LeaseManagerOptions} [options]
 * @returns {LeaseManager}
 */
export function createLeaseManager(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new LeaseError(LEASE_ERROR_CODES.INVALID_ARGUMENT, 'options must be an object')
  }
  const now = options.now === undefined ? Date.now : options.now
  if (typeof now !== 'function') {
    throw new LeaseError(LEASE_ERROR_CODES.INVALID_ARGUMENT, 'now must be a function')
  }
  const defaultTtlMs = resolveTtl(options.defaultTtlMs, DEFAULT_TTL_MS)

  /** @type {Map<string, Lease>} */
  const leases = new Map()
  /** @type {Map<string, Patchset>} */
  const patchsets = new Map()
  let leaseSequence = 0
  let patchsetSequence = 0

  /**
   * @returns {number}
   */
  function readNow() {
    const at = now()
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      throw new LeaseError(
        LEASE_ERROR_CODES.INVALID_ARGUMENT,
        'now() must return a finite epoch-millisecond number',
      )
    }
    return at
  }

  /**
   * Lazily expire stale leases so conflict checks never observe stale locks.
   * @param {number} at
   */
  function expireStaleLeases(at) {
    for (const lease of leases.values()) {
      if (lease.status === 'active' && at >= lease.expiresAt) {
        lease.status = 'expired'
      }
    }
  }

  /**
   * @param {string} workspace
   * @param {string[]} paths Normalized paths.
   * @param {string} [excludeLeaseId]
   * @returns {Conflict[]}
   */
  function findLeaseConflicts(workspace, paths, excludeLeaseId) {
    const conflicts = []
    for (const lease of leases.values()) {
      if (lease.status !== 'active') continue
      if (lease.workspace !== workspace) continue
      if (lease.id === excludeLeaseId) continue
      for (const path of paths) {
        for (const leasePath of lease.paths) {
          if (!overlapsNormalized(path, leasePath)) continue
          conflicts.push({
            leaseId: lease.id,
            owner: lease.owner,
            path,
            leasePath,
            reason: path === leasePath ? 'exact' : 'prefix',
          })
        }
      }
    }
    conflicts.sort((left, right) => {
      if (left.leaseId !== right.leaseId) return left.leaseId < right.leaseId ? -1 : 1
      if (left.path !== right.path) return left.path < right.path ? -1 : 1
      return 0
    })
    return conflicts
  }

  /**
   * Two prepared patchsets may not touch the same or prefix-overlapping paths:
   * committing both would make the resulting content order-dependent.
   * @param {string} workspace
   * @param {string[]} paths Normalized paths.
   * @param {string} [excludePatchsetId]
   * @returns {Array<{ patchsetId: string, path: string, otherPath: string }>}
   */
  function findPreparedPatchsetConflicts(workspace, paths, excludePatchsetId) {
    const conflicts = []
    for (const patchset of patchsets.values()) {
      if (patchset.status !== 'prepared') continue
      if (patchset.id === excludePatchsetId) continue
      const lease = leases.get(patchset.leaseId)
      if (lease === undefined || lease.workspace !== workspace) continue
      for (const file of patchset.files) {
        for (const path of paths) {
          if (!overlapsNormalized(path, file.path)) continue
          conflicts.push({ patchsetId: patchset.id, path, otherPath: file.path })
        }
      }
    }
    return conflicts
  }

  /**
   * @param {string} id
   * @returns {Lease}
   */
  function requireLease(id) {
    const leaseId = requireNonEmptyString(id, 'lease id')
    const lease = leases.get(leaseId)
    if (lease === undefined) {
      throw new LeaseError(LEASE_ERROR_CODES.NOT_FOUND, `lease "${leaseId}" does not exist`, {
        leaseId,
      })
    }
    return lease
  }

  /**
   * @param {string} id
   * @returns {Patchset}
   */
  function requirePatchset(id) {
    const patchsetId = requireNonEmptyString(id, 'patchset id')
    const patchset = patchsets.get(patchsetId)
    if (patchset === undefined) {
      throw new LeaseError(
        LEASE_ERROR_CODES.NOT_FOUND,
        `patchset "${patchsetId}" does not exist`,
        { patchsetId },
      )
    }
    return patchset
  }

  /**
   * Acquire a lease after checking every active lease in the same workspace.
   * Duplicate requested paths are deduplicated; empty path lists are rejected.
   * @param {{ workspace: string, paths: string[], owner: string, ttlMs?: number }} input
   * @returns {Lease}
   */
  function acquire(input) {
    if (input === null || typeof input !== 'object') {
      throw new LeaseError(
        LEASE_ERROR_CODES.INVALID_ARGUMENT,
        'acquire input must be an object',
      )
    }
    const workspace = normalizeWorkspace(input.workspace)
    const owner = requireNonEmptyString(input.owner, 'owner')
    const requested = requirePathArray(input.paths, 'paths')
    if (requested.length === 0) {
      throw new LeaseError(LEASE_ERROR_CODES.INVALID_ARGUMENT, 'paths must not be empty')
    }
    const paths = [...new Set(requested)]
    const ttlMs = resolveTtl(input.ttlMs, defaultTtlMs)
    const at = readNow()
    expireStaleLeases(at)
    const conflicts = findLeaseConflicts(workspace, paths)
    if (conflicts.length > 0) {
      throw new LeaseError(
        LEASE_ERROR_CODES.CONFLICT,
        `paths conflict with active lease "${conflicts[0].leaseId}" in workspace "${workspace}"`,
        { conflicts },
      )
    }
    leaseSequence += 1
    /** @type {Lease} */
    const lease = {
      id: `lease-${leaseSequence}`,
      workspace,
      paths,
      owner,
      ttlMs,
      expiresAt: at + ttlMs,
      status: 'active',
      createdAt: at,
    }
    leases.set(lease.id, lease)
    return snapshotLease(lease)
  }

  /**
   * Extend a live lease from the current clock, not from its old expiry.
   * Expired and released leases cannot be renewed.
   * @param {string} id
   * @param {number} [ttlMs] Omit to reuse the lease's current TTL.
   * @returns {Lease}
   */
  function renew(id, ttlMs) {
    const lease = requireLease(id)
    const at = readNow()
    expireStaleLeases(at)
    if (lease.status === 'released') {
      throw new LeaseError(
        LEASE_ERROR_CODES.LEASE_RELEASED,
        `lease "${lease.id}" was released and cannot be renewed`,
        { leaseId: lease.id },
      )
    }
    if (lease.status === 'expired') {
      throw new LeaseError(
        LEASE_ERROR_CODES.LEASE_EXPIRED,
        `lease "${lease.id}" expired and cannot be renewed`,
        { leaseId: lease.id },
      )
    }
    const nextTtlMs = resolveTtl(ttlMs, lease.ttlMs)
    lease.ttlMs = nextTtlMs
    lease.expiresAt = at + nextTtlMs
    return snapshotLease(lease)
  }

  /**
   * Mark a lease released. Releasing an already-expired lease is allowed and
   * converts its final status to `released`; releasing twice is an error.
   * @param {string} id
   * @returns {Lease}
   */
  function release(id) {
    const lease = requireLease(id)
    const at = readNow()
    expireStaleLeases(at)
    if (lease.status === 'released') {
      throw new LeaseError(
        LEASE_ERROR_CODES.ALREADY_RELEASED,
        `lease "${lease.id}" is already released`,
        { leaseId: lease.id },
      )
    }
    lease.status = 'released'
    return snapshotLease(lease)
  }

  /**
   * Check paths against active leases in one workspace without acquiring.
   * An empty path list is legal and always reports no conflict.
   * @param {{ workspace: string, paths: string[] }} input
   * @returns {CheckConflictResult}
   */
  function checkConflict(input) {
    if (input === null || typeof input !== 'object') {
      throw new LeaseError(
        LEASE_ERROR_CODES.INVALID_ARGUMENT,
        'checkConflict input must be an object',
      )
    }
    const workspace = normalizeWorkspace(input.workspace)
    const requested = requirePathArray(input.paths, 'paths')
    const paths = [...new Set(requested)]
    const at = readNow()
    expireStaleLeases(at)
    const conflicts = findLeaseConflicts(workspace, paths)
    return {
      workspace,
      paths,
      conflict: conflicts.length > 0,
      conflicts,
      checkedAt: at,
    }
  }

  /**
   * Validate and stage a multi-file patchset. This does not write anything and
   * does not commit: it records the intended before/after bodies so commit can
   * return a deterministic write set and rollback can return pre-images.
   *
   * @param {string} leaseId
   * @param {Array<{ path: string, before?: string, after: string }>} files
   * @returns {Patchset}
   */
  function preparePatchset(leaseId, files) {
    const lease = requireLease(leaseId)
    const at = readNow()
    expireStaleLeases(at)
    if (lease.status === 'released') {
      throw new LeaseError(
        LEASE_ERROR_CODES.LEASE_RELEASED,
        `lease "${lease.id}" was released`,
        { leaseId: lease.id },
      )
    }
    if (lease.status === 'expired') {
      throw new LeaseError(
        LEASE_ERROR_CODES.LEASE_EXPIRED,
        `lease "${lease.id}" expired`,
        { leaseId: lease.id },
      )
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw new LeaseError(
        LEASE_ERROR_CODES.INVALID_ARGUMENT,
        'files must be a non-empty array',
      )
    }

    /** @type {PatchFile[]} */
    const staged = []
    const seen = new Set()
    for (const [index, file] of files.entries()) {
      if (file === null || typeof file !== 'object' || Array.isArray(file)) {
        throw new LeaseError(
          LEASE_ERROR_CODES.INVALID_ARGUMENT,
          `files[${index}] must be an object`,
        )
      }
      const path = normalizePath(file.path)
      if (seen.has(path)) {
        throw new LeaseError(
          LEASE_ERROR_CODES.DUPLICATE_PATH,
          `files[${index}] duplicates path "${path}"`,
          { path },
        )
      }
      seen.add(path)
      if (typeof file.after !== 'string') {
        throw new LeaseError(
          LEASE_ERROR_CODES.INVALID_ARGUMENT,
          `files[${index}].after must be a string`,
          { path },
        )
      }
      if (file.before !== undefined && typeof file.before !== 'string') {
        throw new LeaseError(
          LEASE_ERROR_CODES.INVALID_ARGUMENT,
          `files[${index}].before must be a string when present`,
          { path },
        )
      }
      if (!isPathCovered(path, lease.paths)) {
        throw new LeaseError(
          LEASE_ERROR_CODES.PATH_NOT_LEASED,
          `path "${path}" is not covered by lease "${lease.id}"`,
          { path, leaseId: lease.id, leasePaths: [...lease.paths] },
        )
      }
      staged.push({
        path,
        ...(file.before === undefined ? {} : { before: file.before }),
        after: file.after,
      })
    }

    // The lease should already have excluded competing leases, but re-checking
    // keeps the invariant explicit if a manager's state is ever reused oddly.
    const leaseConflicts = findLeaseConflicts(lease.workspace, [...seen], lease.id)
    if (leaseConflicts.length > 0) {
      throw new LeaseError(
        LEASE_ERROR_CODES.CONFLICT,
        `patchset paths conflict with active lease "${leaseConflicts[0].leaseId}"`,
        { conflicts: leaseConflicts },
      )
    }
    const patchsetConflicts = findPreparedPatchsetConflicts(lease.workspace, [...seen])
    if (patchsetConflicts.length > 0) {
      throw new LeaseError(
        LEASE_ERROR_CODES.PATCHSET_CONFLICT,
        `patchset paths conflict with prepared patchset "${patchsetConflicts[0].patchsetId}"`,
        { conflicts: patchsetConflicts },
      )
    }

    patchsetSequence += 1
    /** @type {Patchset} */
    const patchset = {
      id: `patchset-${patchsetSequence}`,
      leaseId: lease.id,
      files: staged,
      status: 'prepared',
      createdAt: at,
    }
    patchsets.set(patchset.id, patchset)
    return snapshotPatchset(patchset)
  }

  /**
   * Return a snapshot of a patchset, including its recorded before/after
   * bodies. This is a read-only accessor for appliers; it never changes state.
   *
   * @param {string} id
   * @returns {Patchset}
   */
  function getPatchset(id) {
    return snapshotPatchset(requirePatchset(id))
  }

  /**
   * Commit a prepared patchset and return its write set sorted by path.
   * A commit is a one-way transition: repeated commits throw
   * ALREADY_COMMITTED, and a commit requires the authorizing lease to still be
   * active. No file is written by this function.
   *
   * @param {string} id
   * @returns {Array<{ path: string, after: string }>}
   */
  function commitPatchset(id) {
    const patchset = requirePatchset(id)
    if (patchset.status === 'committed') {
      throw new LeaseError(
        LEASE_ERROR_CODES.ALREADY_COMMITTED,
        `patchset "${patchset.id}" is already committed`,
        { patchsetId: patchset.id },
      )
    }
    if (patchset.status === 'rolledBack') {
      throw new LeaseError(
        LEASE_ERROR_CODES.ALREADY_ROLLED_BACK,
        `patchset "${patchset.id}" was rolled back and cannot be committed`,
        { patchsetId: patchset.id },
      )
    }
    const lease = requireLease(patchset.leaseId)
    const at = readNow()
    expireStaleLeases(at)
    if (lease.status === 'released') {
      throw new LeaseError(
        LEASE_ERROR_CODES.LEASE_RELEASED,
        `lease "${lease.id}" was released before commit`,
        { leaseId: lease.id, patchsetId: patchset.id },
      )
    }
    if (lease.status === 'expired') {
      throw new LeaseError(
        LEASE_ERROR_CODES.LEASE_EXPIRED,
        `lease "${lease.id}" expired before commit`,
        { leaseId: lease.id, patchsetId: patchset.id },
      )
    }
    patchset.status = 'committed'
    patchset.committedAt = at
    return patchset.files
      .map((file) => ({ path: file.path, after: file.after }))
      .sort(compareByPath)
  }

  /**
   * Roll back a prepared or committed patchset and return the recorded
   * pre-images sorted by path. The result is a plan only; no file is restored.
   * Files that were staged without `before` appear without a `before` key
   * (meaning: this path is intended to be a new file).
   *
   * Rollback is intentionally allowed after lease expiry or release so cleanup
   * is never blocked by a stale lease.
   *
   * @param {string} id
   * @returns {Array<{ path: string, before?: string }>}
   */
  function rollbackPatchset(id) {
    const patchset = requirePatchset(id)
    if (patchset.status === 'rolledBack') {
      throw new LeaseError(
        LEASE_ERROR_CODES.ALREADY_ROLLED_BACK,
        `patchset "${patchset.id}" is already rolled back`,
        { patchsetId: patchset.id },
      )
    }
    const at = readNow()
    patchset.status = 'rolledBack'
    patchset.rolledBackAt = at
    return patchset.files
      .map((file) => ({
        path: file.path,
        ...(file.before === undefined ? {} : { before: file.before }),
      }))
      .sort(compareByPath)
  }

  /**
   * Snapshot all state after lazily expiring stale leases. Patchsets are
   * summarized by path only so status output does not echo file bodies.
   * @returns {{ now: number, defaultTtlMs: number, leases: Lease[], patchsets: PatchsetSummary[], counts: Record<string, Record<string, number>> }}
   */
  function status() {
    const at = readNow()
    expireStaleLeases(at)
    const leaseList = [...leases.values()].map(snapshotLease)
    const patchsetList = [...patchsets.values()].map(summarizePatchset)
    const counts = {
      leases: { active: 0, expired: 0, released: 0 },
      patchsets: { prepared: 0, committed: 0, rolledBack: 0 },
    }
    for (const lease of leaseList) counts.leases[lease.status] += 1
    for (const patchset of patchsetList) counts.patchsets[patchset.status] += 1
    return {
      now: at,
      defaultTtlMs,
      leases: leaseList,
      patchsets: patchsetList,
      counts,
    }
  }

  return {
    acquire,
    renew,
    release,
    status,
    checkConflict,
    preparePatchset,
    getPatchset,
    commitPatchset,
    rollbackPatchset,
  }
}
