/**
 * Filesystem applier for dsh-os-lease patchsets.
 *
 * `core.js` records *intent* only. This module is the opt-in executor: it
 * writes a prepared patchset under one explicit `root`, keeps a recoverable
 * journal of the pre-images, and can put the tree back the way it was.
 *
 * Safety model
 * ------------
 * - Every target path is normalized by `core.normalizePath` (no absolute
 *   paths, no drive letters, no `.`/`..` segments) and then re-checked to be
 *   inside the canonical `root`.
 * - Symbolic links anywhere on the target chain are refused. A link that
 *   points outside `root` is reported as PATH_ESCAPE; a link that points
 *   inside is still refused, because renaming over a link would replace the
 *   link rather than the file the caller meant to edit.
 * - Each file is written to a sibling temporary file, fsynced, then renamed
 *   over the target. A failure mid-apply triggers a best-effort restore of the
 *   entries already journaled.
 * - Concurrent applies that touch the same normalized path are excluded by a
 *   pluggable {@link LockProvider}. The default is a `FileLockProvider` over
 *   `<root>/.dsh-os-lease/locks`, which uses `fs.open(path, 'wx')` lock files
 *   containing `owner`/`expiresAt`, and reclaims expired records. Pass a
 *   custom provider (Redis, SQL, a lock daemon, ...) with `lockProvider` for
 *   other coordination semantics. These are time-based locks, not strong
 *   distributed locks; see `docs/cross-host-locks.md`.
 * - Every successful acquire also issues a monotonic fencing token. The
 *   applier records that token in the journal and, before each target write,
 *   compares it with the provider's current fence (or the root
 *   `<root>/.dsh-os-lease/fence` file). A token older than the current fence
 *   means another holder has taken over, so the write is refused with
 *   `FENCED`. Pass an explicit `fence` when the caller acquired the lock
 *   itself. The check happens immediately before the write, but the check and
 *   the write are not atomic: a holder paused between them can still write.
 *   See §5 of `docs/cross-host-locks.md`.
 *
 * The journal lives at `<root>/.dsh-os-lease/journal/<id>/journal.json`, with
 * pre-images in `<root>/.dsh-os-lease/journal/<id>/backups/`. The manifest
 * never stores file bodies; the backups do.
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { normalizePath } from './core.js'
import {
  DEFAULT_LOCK_TTL_MS,
  FENCE_FILE_NAME,
  FileLockProvider,
  LockError,
  assertLockProvider,
  readFenceValue,
} from './lock.js'

export const STATE_DIRNAME = '.dsh-os-lease'
export const JOURNAL_DIRNAME = 'journal'
export const LOCK_DIRNAME = 'locks'
export const JOURNAL_FILE = 'journal.json'
/** Fencing counter used by `assertFence` when no provider is supplied. */
export const FENCE_FILE = FENCE_FILE_NAME
export const JOURNAL_VERSION = 1

/** Stable machine-readable error codes for filesystem operations. */
export const APPLY_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_ROOT: 'INVALID_ROOT',
  INVALID_PATH: 'INVALID_PATH',
  RESERVED_PATH: 'RESERVED_PATH',
  PATH_ESCAPE: 'PATH_ESCAPE',
  SYMLINK_NOT_ALLOWED: 'SYMLINK_NOT_ALLOWED',
  NOT_A_FILE: 'NOT_A_FILE',
  DUPLICATE_PATH: 'DUPLICATE_PATH',
  ALREADY_APPLIED: 'ALREADY_APPLIED',
  LOCKED: 'LOCKED',
  LOCK_FAILED: 'LOCK_FAILED',
  FENCED: 'FENCED',
  FENCE_FAILED: 'FENCE_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  JOURNAL_CORRUPT: 'JOURNAL_CORRUPT',
  BACKUP_MISSING: 'BACKUP_MISSING',
  BEFORE_MISMATCH: 'BEFORE_MISMATCH',
  FS_ERROR: 'FS_ERROR',
  WRITE_FAILED: 'WRITE_FAILED',
  ROLLBACK_FAILED: 'ROLLBACK_FAILED',
})

/**
 * Error thrown by the applier. `code` is intended for callers; `details` is
 * plain JSON and may carry the journal path and per-path failures.
 */
export class ApplyError extends Error {
  /**
   * @param {string} code One of {@link APPLY_ERROR_CODES}.
   * @param {string} message Human-readable explanation.
   * @param {Record<string, unknown>} [details] Optional structured context.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'ApplyError'
    /** @type {string} */
    this.code = code
    if (details !== undefined) {
      /** @type {Record<string, unknown>} */
      this.details = details
    }
  }
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {string | Buffer | Uint8Array} data */
function hashBytes(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * @param {string} root Canonical absolute root.
 * @param {string} candidate Absolute path to test.
 */
function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

/**
 * @param {string} root
 * @param {string} candidate
 * @param {Record<string, unknown>} [details]
 */
function assertInsideRoot(root, candidate, details) {
  if (!isInsideRoot(root, candidate)) {
    throw new ApplyError(
      APPLY_ERROR_CODES.PATH_ESCAPE,
      `path "${candidate}" escapes root "${root}"`,
      { root, path: candidate, ...details },
    )
  }
}

/**
 * Resolve `root` to a canonical absolute directory. The caller's spelling is
 * deliberately discarded: every later containment check uses the real path.
 *
 * @param {unknown} value
 * @returns {Promise<string>}
 */
async function resolveRoot(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApplyError(APPLY_ERROR_CODES.INVALID_ROOT, 'root must be a non-empty string')
  }
  const absolute = path.resolve(value)
  let real
  try {
    real = await fs.realpath(absolute)
  } catch (error) {
    throw new ApplyError(
      APPLY_ERROR_CODES.INVALID_ROOT,
      `root "${absolute}" cannot be resolved: ${messageOf(error)}`,
      { root: absolute, cause: error instanceof Error ? error.code : undefined },
    )
  }
  let stat
  try {
    stat = await fs.stat(real)
  } catch (error) {
    throw new ApplyError(
      APPLY_ERROR_CODES.INVALID_ROOT,
      `root "${real}" cannot be inspected: ${messageOf(error)}`,
      { root: real, cause: error instanceof Error ? error.code : undefined },
    )
  }
  if (!stat.isDirectory()) {
    throw new ApplyError(APPLY_ERROR_CODES.INVALID_ROOT, `root "${real}" is not a directory`, {
      root: real,
    })
  }
  return real
}

/**
 * @param {unknown} value
 * @param {string} [label]
 * @returns {number | null}
 */
function normalizeFence(value, label = 'fence') {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApplyError(
      APPLY_ERROR_CODES.INVALID_ARGUMENT,
      `${label} must be a positive safe integer when present`,
      { fence: value },
    )
  }
  return value
}

/**
 * Reject a stale fencing token.
 *
 * The current value comes from the lock provider's `currentFence()` when the
 * provider implements it, otherwise from `options.fencePath`, otherwise from
 * `<root>/.dsh-os-lease/fence`. A missing fence file means `0`, so an applier
 * that never issued a token accepts any token. A malformed or unreadable
 * fence file fails closed with `FENCE_FAILED`.
 *
 * This is a compare-then-write check, not an atomic test-and-set: a new token
 * can appear after the check and before the write. See
 * `docs/cross-host-locks.md` §5.
 *
 * @param {string} root Workspace root.
 * @param {number} fence Caller's fencing token.
 * @param {{ provider?: object, fencePath?: string }} [options]
 * @returns {Promise<number>} The observed current fence.
 */
export async function assertFence(root, fence, options = {}) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new ApplyError(APPLY_ERROR_CODES.INVALID_ROOT, 'assertFence root must be a non-empty string')
  }
  const expected = normalizeFence(fence, 'fence')
  if (expected === null) {
    throw new ApplyError(APPLY_ERROR_CODES.INVALID_ARGUMENT, 'assertFence requires a fence')
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ApplyError(APPLY_ERROR_CODES.INVALID_ARGUMENT, 'assertFence options must be an object')
  }
  const provider = options.provider
  /** @type {string | undefined} */
  let fencePath
  let current
  try {
    if (
      provider !== null &&
      typeof provider === 'object' &&
      typeof (/** @type {any} */ (provider).currentFence) === 'function'
    ) {
      current = await (/** @type {any} */ (provider).currentFence())
    } else {
      fencePath =
        typeof options.fencePath === 'string' && options.fencePath !== ''
          ? path.resolve(options.fencePath)
          : path.join(path.resolve(root), STATE_DIRNAME, FENCE_FILE)
      current = await readFenceValue(fencePath)
    }
  } catch (error) {
    if (error instanceof ApplyError) throw error
    throw new ApplyError(
      APPLY_ERROR_CODES.FENCE_FAILED,
      `cannot verify fence ${expected} under "${root}": ${messageOf(error)}`,
      {
        fence: expected,
        root: path.resolve(root),
        ...(fencePath === undefined ? {} : { fencePath }),
        cause: error instanceof LockError ? error.code : undefined,
      },
    )
  }
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new ApplyError(
      APPLY_ERROR_CODES.FENCE_FAILED,
      `lock provider returned an invalid fence value ${String(current)}`,
      { fence: expected, current, root: path.resolve(root) },
    )
  }
  if (current > expected) {
    throw new ApplyError(
      APPLY_ERROR_CODES.FENCED,
      `fence ${expected} is stale: the current fence is ${current}; ` +
        'another holder acquired the workspace after this token was issued',
      {
        fence: expected,
        current,
        root: path.resolve(root),
        ...(fencePath === undefined ? {} : { fencePath }),
      },
    )
  }
  return current
}

/**
 * @param {unknown} options
 * @returns {{ root: string, verifyBefore: boolean, lockProvider: object | undefined, lockTtlMs: number, lockOwner: string, fence: number | null }}
 */
function normalizeApplyOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ApplyError(APPLY_ERROR_CODES.INVALID_ARGUMENT, 'apply options must be an object')
  }
  if (typeof options.root !== 'string' || options.root.trim() === '') {
    throw new ApplyError(APPLY_ERROR_CODES.INVALID_ROOT, 'apply options.root must be a non-empty string')
  }
  if (options.verifyBefore !== undefined && typeof options.verifyBefore !== 'boolean') {
    throw new ApplyError(
      APPLY_ERROR_CODES.INVALID_ARGUMENT,
      'apply options.verifyBefore must be a boolean when present',
    )
  }
  let lockProvider
  if (options.lockProvider !== undefined) {
    try {
      lockProvider = assertLockProvider(options.lockProvider)
    } catch (error) {
      throw new ApplyError(
        APPLY_ERROR_CODES.INVALID_ARGUMENT,
        `apply options.lockProvider is invalid: ${messageOf(error)}`,
        { cause: error instanceof LockError ? error.code : undefined },
      )
    }
  }
  let lockTtlMs = DEFAULT_LOCK_TTL_MS
  if (options.lockTtlMs !== undefined) {
    if (
      typeof options.lockTtlMs !== 'number' ||
      !Number.isFinite(options.lockTtlMs) ||
      options.lockTtlMs <= 0
    ) {
      throw new ApplyError(
        APPLY_ERROR_CODES.INVALID_ARGUMENT,
        'apply options.lockTtlMs must be a positive finite number',
      )
    }
    lockTtlMs = Math.floor(options.lockTtlMs)
    if (lockTtlMs < 1) {
      throw new ApplyError(
        APPLY_ERROR_CODES.INVALID_ARGUMENT,
        'apply options.lockTtlMs must be at least 1 millisecond',
      )
    }
  }
  let lockOwner = `apply:${process.pid}`
  if (options.lockOwner !== undefined) {
    if (
      typeof options.lockOwner !== 'string' ||
      options.lockOwner.trim() === '' ||
      options.lockOwner.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(options.lockOwner)
    ) {
      throw new ApplyError(
        APPLY_ERROR_CODES.INVALID_ARGUMENT,
        'apply options.lockOwner must be a 1-256 character string without control characters',
      )
    }
    lockOwner = options.lockOwner
  }
  return {
    root: options.root,
    verifyBefore: options.verifyBefore === true,
    lockProvider,
    lockTtlMs,
    lockOwner,
    fence: normalizeFence(options.fence, 'apply options.fence'),
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Buffer}
 */
function toContentBuffer(value, label) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw new ApplyError(
    APPLY_ERROR_CODES.INVALID_ARGUMENT,
    `${label} must be a string, Buffer, or Uint8Array`,
  )
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeJournalId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApplyError(APPLY_ERROR_CODES.INVALID_ARGUMENT, 'journal id must be a non-empty string')
  }
  const id = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new ApplyError(
      APPLY_ERROR_CODES.INVALID_ARGUMENT,
      `journal id "${id}" must match [A-Za-z0-9][A-Za-z0-9._-]* and contain no path separators`,
      { id },
    )
  }
  return id
}

/**
 * Reject paths the applier itself owns. `normalizePath` already rules out
 * traversals; this adds the state-directory reservation and a Windows
 * drive/UNC belt-and-braces check.
 *
 * @param {string} normalized
 */
function assertWritablePath(normalized) {
  if (
    path.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new ApplyError(APPLY_ERROR_CODES.INVALID_PATH, `path "${normalized}" must be relative`, {
      path: normalized,
    })
  }
  const first = normalized.split('/')[0].toLowerCase().replace(/[. ]+$/, '')
  if (first === STATE_DIRNAME) {
    throw new ApplyError(
      APPLY_ERROR_CODES.RESERVED_PATH,
      `path "${normalized}" is inside the reserved ${STATE_DIRNAME} directory`,
      { path: normalized },
    )
  }
}

/**
 * @param {string} root
 * @param {string} normalized
 * @returns {string}
 */
function resolveTarget(root, normalized) {
  const target = path.resolve(root, normalized)
  assertInsideRoot(root, target, { path: normalized })
  return target
}

/**
 * @typedef {object} PatchsetInputFile
 * @property {string} path
 * @property {string | Buffer | Uint8Array} [before]
 * @property {string | Buffer | Uint8Array} after
 */

/**
 * @param {unknown} patchset
 * @returns {{ id: string, leaseId: string | null, files: Array<{ path: string, afterBuffer: Buffer, hasBefore: boolean, beforeBuffer: Buffer | null }> }}
 */
function normalizePatchset(patchset) {
  let files
  let id
  let leaseId = null
  if (Array.isArray(patchset)) {
    files = patchset
  } else if (patchset !== null && typeof patchset === 'object') {
    files = patchset.files
    if (patchset.id !== undefined) id = sanitizeJournalId(patchset.id)
    if (patchset.leaseId !== undefined) {
      if (typeof patchset.leaseId !== 'string' || patchset.leaseId.trim() === '') {
        throw new ApplyError(
          APPLY_ERROR_CODES.INVALID_ARGUMENT,
          'patchset.leaseId must be a non-empty string when present',
        )
      }
      leaseId = patchset.leaseId
    }
  } else {
    throw new ApplyError(
      APPLY_ERROR_CODES.INVALID_ARGUMENT,
      'patchset must be an object with files, or an array of files',
    )
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new ApplyError(APPLY_ERROR_CODES.INVALID_ARGUMENT, 'patchset.files must be a non-empty array')
  }
  if (id === undefined) {
    id = `patchset-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  }

  const normalizedFiles = []
  const seen = new Set()
  for (const [index, file] of files.entries()) {
    if (file === null || typeof file !== 'object' || Array.isArray(file)) {
      throw new ApplyError(APPLY_ERROR_CODES.INVALID_ARGUMENT, `files[${index}] must be an object`)
    }
    let normalized
    try {
      normalized = normalizePath(file.path)
    } catch (error) {
      throw new ApplyError(
        APPLY_ERROR_CODES.INVALID_PATH,
        `files[${index}].path: ${messageOf(error)}`,
        { path: file.path, cause: error instanceof Error ? error.code : undefined },
      )
    }
    assertWritablePath(normalized)
    if (seen.has(normalized)) {
      throw new ApplyError(
        APPLY_ERROR_CODES.DUPLICATE_PATH,
        `files[${index}] duplicates path "${normalized}"`,
        { path: normalized },
      )
    }
    seen.add(normalized)
    const hasBefore = file.before !== undefined && file.before !== null
    normalizedFiles.push({
      path: normalized,
      afterBuffer: toContentBuffer(file.after, `files[${index}].after`),
      hasBefore,
      beforeBuffer: hasBefore
        ? toContentBuffer(file.before, `files[${index}].before`)
        : null,
    })
  }
  return { id, leaseId, files: normalizedFiles }
}

/**
 * Create a directory and refuse to accept a symlink in its place. `mkdir`
 * with `recursive` follows an existing link, so the lstat afterwards is the
 * actual check.
 *
 * @param {string} target
 * @param {{ mode?: number, label?: string }} [options]
 * @returns {Promise<string>}
 */
async function ensureDirectory(target, options = {}) {
  const mode = options.mode ?? 0o700
  const label = options.label ?? 'directory'
  try {
    await fs.mkdir(target, { recursive: true, mode })
  } catch (error) {
    throw new ApplyError(
      APPLY_ERROR_CODES.FS_ERROR,
      `cannot create ${label} "${target}": ${messageOf(error)}`,
      { path: target, cause: error instanceof Error ? error.code : undefined },
    )
  }
  let stat
  try {
    stat = await fs.lstat(target)
  } catch (error) {
    throw new ApplyError(
      APPLY_ERROR_CODES.FS_ERROR,
      `cannot inspect ${label} "${target}": ${messageOf(error)}`,
      { path: target, cause: error instanceof Error ? error.code : undefined },
    )
  }
  if (stat.isSymbolicLink()) {
    throw new ApplyError(
      APPLY_ERROR_CODES.PATH_ESCAPE,
      `${label} "${target}" is a symbolic link; refusing to use it`,
      { path: target },
    )
  }
  if (!stat.isDirectory()) {
    throw new ApplyError(
      APPLY_ERROR_CODES.FS_ERROR,
      `${label} "${target}" exists but is not a directory`,
      { path: target },
    )
  }
  return target
}

/**
 * Create `<journalRoot>/<id>` with a non-recursive mkdir. Its atomicity is what
 * prevents two applies from writing the same journal id.
 *
 * @param {string} journalRoot
 * @param {string} id
 * @returns {Promise<string>}
 */
async function createJournalDirectory(journalRoot, id) {
  const journalDir = path.join(journalRoot, id)
  assertInsideRoot(journalRoot, journalDir)
  let stat = null
  try {
    stat = await fs.lstat(journalDir)
  } catch (error) {
    if (error instanceof Error && error.code !== 'ENOENT') {
      throw new ApplyError(
        APPLY_ERROR_CODES.FS_ERROR,
        `cannot inspect journal directory "${journalDir}": ${messageOf(error)}`,
        { path: journalDir, cause: error.code },
      )
    }
  }
  if (stat !== null) {
    if (stat.isSymbolicLink()) {
      throw new ApplyError(
        APPLY_ERROR_CODES.PATH_ESCAPE,
        `journal directory "${journalDir}" is a symbolic link`,
        { path: journalDir },
      )
    }
    throw new ApplyError(
      APPLY_ERROR_CODES.ALREADY_APPLIED,
      `journal "${id}" already exists at "${journalDir}"; use a fresh patchset id`,
      { id, journalPath: journalDir },
    )
  }
  try {
    await fs.mkdir(journalDir, { mode: 0o700 })
  } catch (error) {
    if (error instanceof Error && error.code === 'EEXIST') {
      throw new ApplyError(
        APPLY_ERROR_CODES.ALREADY_APPLIED,
        `journal "${id}" was created concurrently; use a fresh patchset id`,
        { id, journalPath: journalDir },
      )
    }
    throw new ApplyError(
      APPLY_ERROR_CODES.FS_ERROR,
      `cannot create journal directory "${journalDir}": ${messageOf(error)}`,
      { path: journalDir, cause: error instanceof Error ? error.code : undefined },
    )
  }
  return journalDir
}

/**
 * Write a sibling temp file, fsync it, then rename over the target. The
 * directory fsync is best-effort because some platforms/filesystems refuse to
 * open a directory for fsync.
 *
 * @param {string} target
 * @param {Buffer} data
 * @param {{ mode?: number, syncDirectory?: boolean }} [options]
 */
async function writeFileAtomic(target, data, options = {}) {
  const mode = options.mode ?? 0o644
  const syncDirectory = options.syncDirectory !== false
  const directory = path.dirname(target)
  const temp = path.join(
    directory,
    `.dsh-os-lease-tmp-${randomBytes(8).toString('hex')}`,
  )
  let handle = null
  try {
    handle = await fs.open(temp, 'wx', mode & 0o7777)
    await handle.writeFile(data)
    await handle.chmod(mode & 0o7777)
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temp, target)
    if (syncDirectory) await syncDirectoryBestEffort(directory)
  } catch (error) {
    if (handle !== null) {
      try {
        await handle.close()
      } catch {
        // The original error is the useful one.
      }
    }
    try {
      await fs.unlink(temp)
    } catch {
      // The temp file may not have been created, or may already be gone.
    }
    throw error
  }
}

/** @param {string} directory */
async function syncDirectoryBestEffort(directory) {
  let handle = null
  try {
    handle = await fs.open(directory, 'r')
    await handle.sync()
  } catch {
    // Windows and several network filesystems do not support directory fsync.
  } finally {
    if (handle !== null) {
      try {
        await handle.close()
      } catch {
        // Nothing useful to do.
      }
    }
  }
}

/**
 * Walk every component of `normalized` under `root`. Missing components are
 * fine; symlinks and non-directory parents are not.
 *
 * @param {string} root
 * @param {string} normalized
 * @returns {Promise<{ exists: boolean, stat: import('node:fs').Stats | null }>}
 */
async function inspectTarget(root, normalized) {
  const segments = normalized.split('/')
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment)
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if (error instanceof Error && error.code === 'ENOENT') {
        return { exists: false, stat: null }
      }
      throw new ApplyError(
        APPLY_ERROR_CODES.FS_ERROR,
        `cannot inspect "${normalized}": ${messageOf(error)}`,
        { path: normalized, cause: error instanceof Error ? error.code : undefined },
      )
    }
    if (stat.isSymbolicLink()) {
      let real = null
      try {
        real = await fs.realpath(current)
      } catch {
        // A broken link is still a link; report it the same way.
      }
      if (real !== null && real !== root && !isInsideRoot(root, real)) {
        throw new ApplyError(
          APPLY_ERROR_CODES.PATH_ESCAPE,
          `symbolic link "${normalized}" resolves outside root "${root}"`,
          { path: normalized, link: current, resolved: real },
        )
      }
      throw new ApplyError(
        APPLY_ERROR_CODES.SYMLINK_NOT_ALLOWED,
        `symbolic link "${normalized}" is not allowed for writes`,
        { path: normalized, link: current, resolved: real },
      )
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new ApplyError(
        APPLY_ERROR_CODES.NOT_A_FILE,
        `path "${normalized}" has a non-directory parent "${segments.slice(0, index + 1).join('/')}"`,
        { path: normalized },
      )
    }
    if (index === segments.length - 1) return { exists: true, stat }
  }
  return { exists: false, stat: null }
}

/**
 * Create missing parent directories one component at a time, recording the
 * ones this apply created so rollback can remove them when empty.
 *
 * @param {string} root
 * @param {string} normalized
 * @param {string[]} createdDirs
 */
async function ensureParentDirs(root, normalized, createdDirs) {
  const segments = normalized.split('/')
  segments.pop()
  let current = root
  let relative = ''
  for (const segment of segments) {
    current = path.join(current, segment)
    relative = relative === '' ? segment : `${relative}/${segment}`
    let stat = null
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if (!(error instanceof Error) || error.code !== 'ENOENT') {
        throw new ApplyError(
          APPLY_ERROR_CODES.FS_ERROR,
          `cannot inspect parent directory "${relative}": ${messageOf(error)}`,
          { path: relative, cause: error instanceof Error ? error.code : undefined },
        )
      }
      try {
        await fs.mkdir(current, { mode: 0o755 })
      } catch (mkdirError) {
        if (!(mkdirError instanceof Error) || mkdirError.code !== 'EEXIST') {
          throw new ApplyError(
            APPLY_ERROR_CODES.WRITE_FAILED,
            `cannot create parent directory "${relative}": ${messageOf(mkdirError)}`,
            { path: relative, cause: mkdirError instanceof Error ? mkdirError.code : undefined },
          )
        }
      }
      if (!createdDirs.includes(relative)) createdDirs.push(relative)
      stat = await fs.lstat(current)
    }
    if (stat.isSymbolicLink()) {
      throw new ApplyError(
        APPLY_ERROR_CODES.PATH_ESCAPE,
        `parent directory "${relative}" is a symbolic link`,
        { path: relative },
      )
    }
    if (!stat.isDirectory()) {
      throw new ApplyError(
        APPLY_ERROR_CODES.NOT_A_FILE,
        `parent "${relative}" exists but is not a directory`,
        { path: relative },
      )
    }
  }
}

/** @param {string} relative */
function depthOf(relative) {
  return relative.split('/').length
}

/**
 * Remove directories created by this journal, deepest first. Only empty
 * directories are removed; anything else is left for its owner.
 *
 * @param {string} root
 * @param {string[]} dirs
 */
async function removeEmptyDirs(root, dirs) {
  const ordered = [...new Set(dirs)].sort((left, right) => {
    const byDepth = depthOf(right) - depthOf(left)
    return byDepth !== 0 ? byDepth : left < right ? 1 : left > right ? -1 : 0
  })
  for (const relative of ordered) {
    try {
      const target = resolveTarget(root, normalizePath(relative))
      await fs.rmdir(target)
    } catch {
      // ENOENT/ENOTEMPTY/EACCES: best effort only.
    }
  }
}

/**
 * @param {string} root
 * @param {string} pathValue
 * @param {string | undefined} backup
 */
function resolveBackupPath(root, pathValue, backup) {
  const backupsRoot = path.join(root, 'backups')
  const absolute = path.resolve(root, backup)
  if (!isInsideRoot(backupsRoot, absolute)) {
    throw new ApplyError(
      APPLY_ERROR_CODES.JOURNAL_CORRUPT,
      `backup path "${backup}" for "${pathValue}" is outside the journal backups directory`,
      { path: pathValue, backup },
    )
  }
  return absolute
}

/**
 * Read one entry's pre-image back and write it over the target atomically.
 *
 * @param {string} root
 * @param {string} journalDir
 * @param {{ path: string, existed: boolean, mode: number, backup: string | null }} entry
 * @param {(() => Promise<unknown>) | undefined} [guard] Fence check run
 *   immediately before each restore write or delete.
 */
async function restoreEntry(root, journalDir, entry, guard) {
  const target = resolveTarget(root, entry.path)
  const inspection = await inspectTarget(root, entry.path)
  if (entry.existed) {
    if (inspection.exists && inspection.stat !== null && !inspection.stat.isFile()) {
      throw new ApplyError(
        APPLY_ERROR_CODES.NOT_A_FILE,
        `cannot restore "${entry.path}": the target is not a regular file`,
        { path: entry.path },
      )
    }
    if (typeof entry.backup !== 'string' || entry.backup === '') {
      throw new ApplyError(
        APPLY_ERROR_CODES.JOURNAL_CORRUPT,
        `journal entry "${entry.path}" has no backup path`,
        { path: entry.path },
      )
    }
    const backupPath = resolveBackupPath(journalDir, entry.path, entry.backup)
    let backupStat
    try {
      backupStat = await fs.lstat(backupPath)
    } catch (error) {
      if (error instanceof Error && error.code === 'ENOENT') {
        throw new ApplyError(
          APPLY_ERROR_CODES.BACKUP_MISSING,
          `backup for "${entry.path}" is missing at "${backupPath}"`,
          { path: entry.path, backupPath },
        )
      }
      throw new ApplyError(
        APPLY_ERROR_CODES.FS_ERROR,
        `cannot inspect backup for "${entry.path}": ${messageOf(error)}`,
        { path: entry.path, backupPath, cause: error instanceof Error ? error.code : undefined },
      )
    }
    if (backupStat.isSymbolicLink() || !backupStat.isFile()) {
      throw new ApplyError(
        APPLY_ERROR_CODES.BACKUP_MISSING,
        `backup for "${entry.path}" is not a regular file at "${backupPath}"`,
        { path: entry.path, backupPath },
      )
    }
    let data
    try {
      data = await fs.readFile(backupPath)
    } catch (error) {
      throw new ApplyError(
        APPLY_ERROR_CODES.FS_ERROR,
        `cannot read backup for "${entry.path}": ${messageOf(error)}`,
        { path: entry.path, backupPath, cause: error instanceof Error ? error.code : undefined },
      )
    }
    await ensureParentDirs(root, entry.path, [])
    try {
      if (guard !== undefined) await guard()
      await writeFileAtomic(target, data, { mode: entry.mode })
    } catch (error) {
      throw new ApplyError(
        APPLY_ERROR_CODES.WRITE_FAILED,
        `cannot restore "${entry.path}": ${messageOf(error)}`,
        { path: entry.path, cause: error instanceof Error ? error.code : undefined },
      )
    }
    return
  }

  if (!inspection.exists) return
  if (inspection.stat === null || !inspection.stat.isFile()) {
    throw new ApplyError(
      APPLY_ERROR_CODES.NOT_A_FILE,
      `refusing to delete "${entry.path}": it is not a regular file`,
      { path: entry.path },
    )
  }
  try {
    if (guard !== undefined) await guard()
    await fs.unlink(target)
  } catch (error) {
    if (error instanceof ApplyError) throw error
    if (!(error instanceof Error) || error.code !== 'ENOENT') {
      throw new ApplyError(
        APPLY_ERROR_CODES.WRITE_FAILED,
        `cannot delete newly added "${entry.path}": ${messageOf(error)}`,
        { path: entry.path, cause: error instanceof Error ? error.code : undefined },
      )
    }
  }
}

/**
 * Restore every journal entry in reverse order. Per-path failures are
 * collected instead of aborting, so one missing backup does not block the
 * others; the caller decides whether to report an aggregate failure.
 *
 * @param {{ files: Array<any>, createdDirs?: string[] }} manifest
 * @param {{ root: string, journalDir: string, guard?: () => Promise<unknown> }} context
 * @returns {Promise<Array<{ path: string, code: string, message: string }>>}
 */
async function restoreEntries(manifest, context) {
  const failures = []
  const files = [...manifest.files].reverse()
  for (const entry of files) {
    try {
      await restoreEntry(context.root, context.journalDir, entry, context.guard)
      entry.restored = true
      delete entry.error
    } catch (error) {
      const failure = {
        path: entry.path,
        code: error instanceof ApplyError ? error.code : 'ERROR',
        message: messageOf(error),
      }
      failures.push(failure)
      entry.error = { code: failure.code, message: failure.message }
    }
  }
  await removeEmptyDirs(context.root, manifest.createdDirs ?? [])
  return failures
}

/**
 * @param {{ root: string, files: Array<{ path: string, afterBuffer: Buffer, hasBefore: boolean, beforeBuffer: Buffer | null }>, journalDir: string, verifyBefore: boolean, createdDirs: string[] }} input
 */
async function preparePlan(input) {
  const plan = []
  for (const [index, file] of input.files.entries()) {
    const target = resolveTarget(input.root, file.path)
    const inspection = await inspectTarget(input.root, file.path)
    if (inspection.exists && inspection.stat !== null && !inspection.stat.isFile()) {
      throw new ApplyError(
        APPLY_ERROR_CODES.NOT_A_FILE,
        `target "${file.path}" exists but is not a regular file`,
        { path: file.path },
      )
    }
    const existed = inspection.exists
    const mode = existed && inspection.stat !== null ? inspection.stat.mode & 0o777 : 0o644
    let beforeBuffer = null
    let backup = null
    if (existed) {
      try {
        beforeBuffer = await fs.readFile(target)
      } catch (error) {
        throw new ApplyError(
          APPLY_ERROR_CODES.FS_ERROR,
          `cannot read pre-image of "${file.path}": ${messageOf(error)}`,
          { path: file.path, cause: error instanceof Error ? error.code : undefined },
        )
      }
      if (
        input.verifyBefore &&
        file.hasBefore &&
        file.beforeBuffer !== null &&
        !beforeBuffer.equals(file.beforeBuffer)
      ) {
        throw new ApplyError(
          APPLY_ERROR_CODES.BEFORE_MISMATCH,
          `pre-image of "${file.path}" does not match the caller-supplied before body`,
          {
            path: file.path,
            expectedSha256: hashBytes(file.beforeBuffer),
            actualSha256: hashBytes(beforeBuffer),
          },
        )
      }
      backup = `backups/${String(index).padStart(4, '0')}.before`
      try {
        await writeFileAtomic(path.join(input.journalDir, backup), beforeBuffer, {
          mode: 0o600,
          syncDirectory: false,
        })
      } catch (error) {
        throw new ApplyError(
          APPLY_ERROR_CODES.WRITE_FAILED,
          `cannot write backup for "${file.path}": ${messageOf(error)}`,
          { path: file.path, cause: error instanceof Error ? error.code : undefined },
        )
      }
    }
    await ensureParentDirs(input.root, file.path, input.createdDirs)
    const beforeMatches = file.hasBefore
      ? existed && beforeBuffer !== null && beforeBuffer.equals(file.beforeBuffer)
      : null
    plan.push({
      entry: {
        path: file.path,
        existed,
        mode,
        size: beforeBuffer === null ? null : beforeBuffer.length,
        sha256: beforeBuffer === null ? null : hashBytes(beforeBuffer),
        backup,
        afterSha256: hashBytes(file.afterBuffer),
        afterSize: file.afterBuffer.length,
        beforeProvided: file.hasBefore,
        beforeMatches,
        applied: false,
        restored: false,
      },
      afterBuffer: file.afterBuffer,
      target,
    })
  }
  return plan
}

/**
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.root
 * @param {string | null} input.leaseId
 * @param {number | null} [input.fence]
 * @param {Array<{ entry: any }>} input.plan
 * @param {string[]} input.createdDirs
 */
function buildManifest(input) {
  const now = new Date().toISOString()
  return {
    version: JOURNAL_VERSION,
    id: input.id,
    root: input.root,
    patchsetId: input.id,
    leaseId: input.leaseId,
    fence: input.fence ?? null,
    createdAt: now,
    updatedAt: now,
    status: 'applying',
    files: input.plan.map((item) => item.entry),
    createdDirs: [...input.createdDirs],
  }
}

/**
 * Only known fields are persisted. Runtime-only fields (`journalPath`,
 * `backupPath`, buffers) must never leak into the manifest.
 *
 * @param {any} manifest
 */
function toManifestRecord(manifest) {
  return {
    version: manifest.version,
    id: manifest.id,
    root: manifest.root,
    patchsetId: manifest.patchsetId,
    leaseId: manifest.leaseId ?? null,
    fence: manifest.fence ?? null,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    status: manifest.status,
    files: manifest.files.map((file) => ({
      path: file.path,
      existed: file.existed === true,
      mode: file.mode,
      size: file.size,
      sha256: file.sha256,
      backup: file.backup,
      afterSha256: file.afterSha256,
      afterSize: file.afterSize,
      beforeProvided: file.beforeProvided === true,
      beforeMatches: file.beforeMatches ?? null,
      applied: file.applied === true,
      restored: file.restored === true,
      ...(file.error === undefined ? {} : { error: file.error }),
    })),
    createdDirs: [...(manifest.createdDirs ?? [])],
    ...(manifest.appliedAt === undefined ? {} : { appliedAt: manifest.appliedAt }),
    ...(manifest.rolledBackAt === undefined ? {} : { rolledBackAt: manifest.rolledBackAt }),
    ...(manifest.error === undefined ? {} : { error: manifest.error }),
    ...(manifest.rollbackError === undefined ? {} : { rollbackError: manifest.rollbackError }),
  }
}

/** @param {string} journalDir @param {any} manifest */
async function writeJournalManifest(journalDir, manifest) {
  const target = path.join(journalDir, JOURNAL_FILE)
  const body = `${JSON.stringify(toManifestRecord(manifest), null, 2)}\n`
  try {
    await writeFileAtomic(target, Buffer.from(body, 'utf8'), { mode: 0o600 })
  } catch (error) {
    throw new ApplyError(
      APPLY_ERROR_CODES.FS_ERROR,
      `cannot write journal "${target}": ${messageOf(error)}`,
      { journalPath: target, cause: error instanceof Error ? error.code : undefined },
    )
  }
}

/**
 * @param {any} manifest
 * @param {string} journalPath
 * @param {string} root
 */
function hydrateJournal(manifest, journalPath, root) {
  const record = toManifestRecord(manifest)
  const journalDir = path.dirname(journalPath)
  return {
    ...record,
    journalPath,
    dir: journalDir,
    files: record.files.map((file) => ({
      ...file,
      ...(typeof file.backup === 'string' && file.backup !== ''
        ? { backupPath: path.join(journalDir, file.backup) }
        : {}),
    })),
  }
}

/**
 * Serialize a journal manifest into a caller-visible summary.
 *
 * @param {any} manifest
 * @param {string} journalPath
 * @param {string} root
 * @param {boolean} alreadyRolledBack
 */
function rollbackResult(manifest, journalPath, root, alreadyRolledBack) {
  return {
    id: manifest.id,
    status: 'rolledBack',
    journalPath,
    alreadyRolledBack,
    restored: manifest.files.filter((file) => file.existed).map((file) => file.path),
    deleted: manifest.files.filter((file) => !file.existed).map((file) => file.path),
    fileCount: manifest.files.length,
    journal: hydrateJournal(manifest, journalPath, root),
  }
}

/**
 * Release acquired handles in reverse order. Release failures are ignored:
 * the lock's TTL is the last-resort cleanup path, and a successful apply must
 * not be reported as failed because a release raced with an expired reclaim.
 *
 * @param {{ release: (handle: any) => Promise<unknown> }} provider
 * @param {any[]} handles
 */
async function releasePathLocks(provider, handles) {
  for (const handle of [...handles].reverse()) {
    try {
      await provider.release(handle)
    } catch {
      // Best effort. An expired lock is reclaimed by the next acquire.
    }
  }
}

/**
 * Map a provider `LOCKED` into the applier's stable error vocabulary while
 * preserving the holder identity (`owner`, `expiresAt`) the caller needs to
 * decide whether to wait, pick other paths, or clear a stale lock.
 *
 * @param {unknown} error
 * @param {string} key
 */
function toApplyLockError(error, key) {
  // Custom providers need not import LockError; accept any LOCKED-shaped error
  // (a string `code` plus optional `details`) so adapters stay dependency-free.
  const code =
    error instanceof LockError
      ? error.code
      : error !== null && typeof error === 'object' && typeof (/** @type {any} */ (error).code) === 'string'
        ? /** @type {any} */ (error).code
        : undefined
  const detailValue =
    error !== null && typeof error === 'object' ? /** @type {any} */ (error).details : undefined
  const details =
    detailValue !== null && typeof detailValue === 'object' && !Array.isArray(detailValue)
      ? detailValue
      : {}
  if (code === APPLY_ERROR_CODES.LOCKED) {
    const merged = {
      ...details,
      path: key,
      owner: details.owner ?? null,
      expiresAt: details.expiresAt ?? null,
    }
    return new ApplyError(
      APPLY_ERROR_CODES.LOCKED,
      `path "${key}" is already locked${merged.owner === null ? '' : ` by "${merged.owner}"`}` +
        (merged.expiresAt === null
          ? ''
          : ` until ${new Date(/** @type {number} */ (merged.expiresAt)).toISOString()}`),
      merged,
    )
  }
  if (code === APPLY_ERROR_CODES.INVALID_ARGUMENT) {
    return new ApplyError(
      APPLY_ERROR_CODES.INVALID_ARGUMENT,
      `lock provider rejected "${key}": ${messageOf(error)}`,
      { ...details, path: key },
    )
  }
  if (code !== undefined) {
    return new ApplyError(
      APPLY_ERROR_CODES.LOCK_FAILED,
      `cannot acquire lock for "${key}": ${messageOf(error)}`,
      { ...details, path: key, cause: code },
    )
  }
  return new ApplyError(
    APPLY_ERROR_CODES.LOCK_FAILED,
    `cannot acquire lock for "${key}": ${messageOf(error)}`,
    { path: key, cause: error instanceof Error ? error.code : undefined },
  )
}

/**
 * Acquire one lock per normalized path, in sorted order, so two applies that
 * overlap always contend in the same order. On the first failure, handles
 * already acquired by this call are released before the error propagates.
 *
 * @param {{ acquire: (key: string, options: { ttlMs: number, owner: string, issueFence?: boolean }) => Promise<any>, release: Function }} provider
 * @param {string[]} normalizedPaths
 * @param {{ ttlMs: number, owner: string, issueFence?: boolean }} options
 */
async function acquirePathLocks(provider, normalizedPaths, options) {
  const ordered = [...new Set(normalizedPaths)].sort()
  /** @type {any[]} */
  const acquired = []
  let fence = null
  try {
    for (const key of ordered) {
      try {
        const handle = await provider.acquire(key, options)
        acquired.push(handle)
        if (Number.isSafeInteger(handle?.fence) && handle.fence > (fence ?? 0)) {
          fence = handle.fence
        }
      } catch (error) {
        throw toApplyLockError(error, key)
      }
    }
  } catch (error) {
    await releasePathLocks(provider, acquired)
    throw error
  }
  return {
    paths: ordered,
    fence,
    release: async () => releasePathLocks(provider, acquired),
  }
}

/**
 * Validate a parsed journal manifest before trusting any of its paths.
 *
 * @param {unknown} value
 * @param {{ root: string, journalDir: string, expectedId?: string }} context
 */
function parseJournalValue(value, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplyError(APPLY_ERROR_CODES.JOURNAL_CORRUPT, 'journal manifest must be an object')
  }
  const manifest = /** @type {any} */ (value)
  if (manifest.version !== JOURNAL_VERSION) {
    throw new ApplyError(
      APPLY_ERROR_CODES.JOURNAL_CORRUPT,
      `unsupported journal version "${String(manifest.version)}"`,
      { version: manifest.version },
    )
  }
  let id
  try {
    id = sanitizeJournalId(manifest.id)
  } catch (error) {
    throw new ApplyError(
      APPLY_ERROR_CODES.JOURNAL_CORRUPT,
      `journal has an invalid id: ${messageOf(error)}`,
      { id: manifest.id },
    )
  }
  if (context.expectedId !== undefined && id !== context.expectedId) {
    throw new ApplyError(
      APPLY_ERROR_CODES.JOURNAL_CORRUPT,
      `journal id "${id}" does not match requested id "${context.expectedId}"`,
      { id, expectedId: context.expectedId },
    )
  }
  if (typeof manifest.root !== 'string' || manifest.root !== context.root) {
    throw new ApplyError(
      APPLY_ERROR_CODES.JOURNAL_CORRUPT,
      `journal root "${String(manifest.root)}" does not match requested root "${context.root}"`,
      { root: manifest.root, expectedRoot: context.root },
    )
  }
  const statuses = new Set([
    'applying',
    'applied',
    'applyFailed',
    'rollingBack',
    'rollbackFailed',
    'rolledBack',
  ])
  if (!statuses.has(manifest.status)) {
    throw new ApplyError(
      APPLY_ERROR_CODES.JOURNAL_CORRUPT,
      `journal "${id}" has unknown status "${String(manifest.status)}"`,
      { id, status: manifest.status },
    )
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new ApplyError(
      APPLY_ERROR_CODES.JOURNAL_CORRUPT,
      `journal "${id}" has no files array`,
      { id },
    )
  }
  const createdDirs = manifest.createdDirs === undefined ? [] : manifest.createdDirs
  if (!Array.isArray(createdDirs)) {
    throw new ApplyError(
      APPLY_ERROR_CODES.JOURNAL_CORRUPT,
      `journal "${id}" createdDirs must be an array`,
      { id },
    )
  }
  const cleanDirs = []
  for (const dir of createdDirs) {
    if (typeof dir !== 'string') {
      throw new ApplyError(
        APPLY_ERROR_CODES.JOURNAL_CORRUPT,
        `journal "${id}" createdDirs contains a non-string entry`,
        { id },
      )
    }
    let normalized
    try {
      normalized = normalizePath(dir)
      assertWritablePath(normalized)
      resolveTarget(context.root, normalized)
    } catch (error) {
      throw new ApplyError(
        APPLY_ERROR_CODES.JOURNAL_CORRUPT,
        `journal "${id}" has an unsafe created directory "${dir}": ${messageOf(error)}`,
        { id, path: dir },
      )
    }
    cleanDirs.push(normalized)
  }

  let fence = null
  if (manifest.fence !== undefined && manifest.fence !== null) {
    if (!Number.isSafeInteger(manifest.fence) || manifest.fence < 1) {
      throw new ApplyError(
        APPLY_ERROR_CODES.JOURNAL_CORRUPT,
        `journal "${id}" fence must be a positive safe integer`,
        { id, fence: manifest.fence },
      )
    }
    fence = manifest.fence
  }

  const files = []
  const seenPaths = new Set()
  for (const [index, file] of manifest.files.entries()) {
    if (file === null || typeof file !== 'object' || Array.isArray(file)) {
      throw new ApplyError(
        APPLY_ERROR_CODES.JOURNAL_CORRUPT,
        `journal "${id}" files[${index}] is not an object`,
        { id },
      )
    }
    if (typeof file.path !== 'string') {
      throw new ApplyError(
        APPLY_ERROR_CODES.JOURNAL_CORRUPT,
        `journal "${id}" files[${index}].path must be a string`,
        { id },
      )
    }
    let normalized
    try {
      normalized = normalizePath(file.path)
      assertWritablePath(normalized)
      resolveTarget(context.root, normalized)
    } catch (error) {
      throw new ApplyError(
        APPLY_ERROR_CODES.JOURNAL_CORRUPT,
        `journal "${id}" has an unsafe path "${file.path}": ${messageOf(error)}`,
        { id, path: file.path },
      )
    }
    if (typeof file.existed !== 'boolean') {
      throw new ApplyError(
        APPLY_ERROR_CODES.JOURNAL_CORRUPT,
        `journal "${id}" files[${index}].existed must be a boolean`,
        { id, path: normalized },
      )
    }
    if (seenPaths.has(normalized)) {
      throw new ApplyError(
        APPLY_ERROR_CODES.JOURNAL_CORRUPT,
        `journal "${id}" contains duplicate path "${normalized}"`,
        { id, path: normalized },
      )
    }
    seenPaths.add(normalized)
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
      throw new ApplyError(
        APPLY_ERROR_CODES.JOURNAL_CORRUPT,
        `journal "${id}" files[${index}].mode is not a valid permission mode`,
        { id, path: normalized },
      )
    }
    let backup = null
    if (file.existed) {
      if (typeof file.backup !== 'string' || file.backup === '') {
        throw new ApplyError(
          APPLY_ERROR_CODES.JOURNAL_CORRUPT,
          `journal "${id}" files[${index}] is missing its backup path`,
          { id, path: normalized },
        )
      }
      try {
        backup = normalizePath(file.backup)
      } catch (error) {
        throw new ApplyError(
          APPLY_ERROR_CODES.JOURNAL_CORRUPT,
          `journal "${id}" has an invalid backup path: ${messageOf(error)}`,
          { id, path: normalized },
        )
      }
      if (!backup.startsWith('backups/')) {
        throw new ApplyError(
          APPLY_ERROR_CODES.JOURNAL_CORRUPT,
          `journal "${id}" backup path "${backup}" is not under backups/`,
          { id, path: normalized },
        )
      }
      resolveBackupPath(context.journalDir, normalized, backup)
    } else if (file.backup !== null && file.backup !== undefined) {
      throw new ApplyError(
        APPLY_ERROR_CODES.JOURNAL_CORRUPT,
        `journal "${id}" files[${index}] has a backup but was not an existing file`,
        { id, path: normalized },
      )
    }
    files.push({
      path: normalized,
      existed: file.existed,
      mode: file.mode,
      size: typeof file.size === 'number' ? file.size : null,
      sha256: typeof file.sha256 === 'string' ? file.sha256 : null,
      backup,
      afterSha256: typeof file.afterSha256 === 'string' ? file.afterSha256 : null,
      afterSize: typeof file.afterSize === 'number' ? file.afterSize : null,
      beforeProvided: file.beforeProvided === true,
      beforeMatches: typeof file.beforeMatches === 'boolean' ? file.beforeMatches : null,
      applied: file.applied === true,
      restored: file.restored === true,
      ...(file.error !== undefined && file.error !== null ? { error: file.error } : {}),
    })
  }
  return {
    version: JOURNAL_VERSION,
    id,
    root: context.root,
    patchsetId: typeof manifest.patchsetId === 'string' ? manifest.patchsetId : id,
    leaseId: typeof manifest.leaseId === 'string' ? manifest.leaseId : null,
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
    updatedAt: typeof manifest.updatedAt === 'string' ? manifest.updatedAt : null,
    status: manifest.status,
    fence,
    files,
    createdDirs: cleanDirs,
    ...(typeof manifest.appliedAt === 'string' ? { appliedAt: manifest.appliedAt } : {}),
    ...(typeof manifest.rolledBackAt === 'string' ? { rolledBackAt: manifest.rolledBackAt } : {}),
    ...(manifest.error !== undefined && manifest.error !== null ? { error: manifest.error } : {}),
    ...(manifest.rollbackError !== undefined && manifest.rollbackError !== null
      ? { rollbackError: manifest.rollbackError }
      : {}),
  }
}

/**
 * Read and parse one manifest from disk without trusting its paths.
 *
 * @param {string} journalPath
 * @param {string} journalDir
 * @param {{ expectedId?: string, requestedRoot?: string }} [options]
 */
async function readJournalFile(journalPath, journalDir, options = {}) {
  let stat
  try {
    stat = await fs.lstat(journalPath)
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') {
      throw new ApplyError(
        APPLY_ERROR_CODES.NOT_FOUND,
        `journal manifest "${journalPath}" does not exist`,
        { journalPath, missing: 'journal.json' },
      )
    }
    throw new ApplyError(
      APPLY_ERROR_CODES.FS_ERROR,
      `cannot inspect journal "${journalPath}": ${messageOf(error)}`,
      { journalPath, cause: error instanceof Error ? error.code : undefined },
    )
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ApplyError(
      APPLY_ERROR_CODES.JOURNAL_CORRUPT,
      `journal manifest "${journalPath}" is not a regular file`,
      { journalPath },
    )
  }
  let raw
  try {
    raw = await fs.readFile(journalPath, 'utf8')
  } catch (error) {
    throw new ApplyError(
      APPLY_ERROR_CODES.FS_ERROR,
      `cannot read journal "${journalPath}": ${messageOf(error)}`,
      { journalPath, cause: error instanceof Error ? error.code : undefined },
    )
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new ApplyError(
      APPLY_ERROR_CODES.JOURNAL_CORRUPT,
      `journal "${journalPath}" is not valid JSON: ${messageOf(error)}`,
      { journalPath },
    )
  }
  if (value === null || typeof value !== 'object' || typeof value.root !== 'string') {
    throw new ApplyError(
      APPLY_ERROR_CODES.JOURNAL_CORRUPT,
      `journal "${journalPath}" has no root`,
      { journalPath },
    )
  }
  let root
  try {
    root = await resolveRoot(value.root)
  } catch (error) {
    throw new ApplyError(
      APPLY_ERROR_CODES.JOURNAL_CORRUPT,
      `journal "${journalPath}" root cannot be resolved: ${messageOf(error)}`,
      { journalPath },
    )
  }
  if (options.requestedRoot !== undefined) {
    const requested = await resolveRoot(options.requestedRoot)
    if (requested !== root) {
      throw new ApplyError(
        APPLY_ERROR_CODES.INVALID_ROOT,
        `journal root "${root}" does not match requested root "${requested}"`,
        { journalPath, root, requestedRoot: requested },
      )
    }
  }
  const manifest = parseJournalValue(value, {
    root,
    journalDir,
    expectedId: options.expectedId,
  })
  return { manifest, root, journalPath, journalDir }
}

/**
 * Apply a patchset under an explicit root.
 *
 * The patchset is usually the object returned by
 * `createLeaseManager().preparePatchset()`. A bare array of
 * `{ path, before?, after }` entries is also accepted; a journal id is
 * generated when `patchset.id` is absent.
 *
 * Locks are acquired through `options.lockProvider` when supplied, otherwise
 * through a `FileLockProvider` over `<root>/.dsh-os-lease/locks`. The lock TTL
 * must outlive the apply; a lock that expires mid-apply can be reclaimed by a
 * second process. Use `lockTtlMs` to tune it and `lockOwner` to make the
 * holder identifiable in `LOCKED` errors (the default is `apply:<pid>`).
 *
 * Fencing: every successful acquire issues a monotonic token. When the caller
 * passes `fence` (from a handle it acquired itself), the applier verifies that
 * token and does not consume a new one for its internal path locks. Without
 * `fence`, the applier uses the tokens issued by its own acquisitions, so the
 * journal's `fence` is the last token it holds. Before every target write the
 * token is compared with the current fence; a newer current value throws
 * `FENCED`. The journal records the token used (`null` for providers that
 * issue none).
 *
 * @param {{ id?: string, leaseId?: string, files: PatchsetInputFile[] } | PatchsetInputFile[]} patchset
 * @param {{ root: string, verifyBefore?: boolean, lockProvider?: object, lockTtlMs?: number, lockOwner?: string, fence?: number }} options
 * @returns {Promise<any>} The journal, hydrated with `journalPath` and `dir`.
 */
export async function applyPatchset(patchset, options) {
  const settings = normalizeApplyOptions(options)
  const root = await resolveRoot(settings.root)
  const normalized = normalizePatchset(patchset)
  const stateDir = await ensureDirectory(path.join(root, STATE_DIRNAME), {
    mode: 0o700,
    label: 'state directory',
  })
  const lockProvider =
    settings.lockProvider ??
    new FileLockProvider({
      dir: path.join(stateDir, LOCK_DIRNAME),
      fencePath: path.join(stateDir, FENCE_FILE),
    })
  const lock = await acquirePathLocks(
    lockProvider,
    normalized.files.map((file) => file.path),
    {
      ttlMs: settings.lockTtlMs,
      owner: settings.lockOwner,
      // An explicit token belongs to the caller's lease: acquiring path locks
      // must not advance the counter past it, or the caller's own write would
      // be rejected.
      issueFence: settings.fence === null,
    },
  )
  const fence = settings.fence ?? lock.fence
  const guard =
    fence === null
      ? undefined
      : async () => {
          await assertFence(root, fence, { provider: lockProvider })
        }
  let journalRoot = null
  let journalDir = null
  let manifest = null
  let manifestWritten = false
  const createdDirs = []
  try {
    // Fail before creating a journal or touching a target when the caller's
    // token is already stale.
    if (guard !== undefined) await guard()
    journalRoot = await ensureDirectory(path.join(stateDir, JOURNAL_DIRNAME), {
      mode: 0o700,
      label: 'journal directory',
    })
    journalDir = await createJournalDirectory(journalRoot, normalized.id)
    await ensureDirectory(path.join(journalDir, 'backups'), {
      mode: 0o700,
      label: 'backup directory',
    })
    const plan = await preparePlan({
      root,
      files: normalized.files,
      journalDir,
      verifyBefore: settings.verifyBefore,
      createdDirs,
    })
    manifest = buildManifest({
      id: normalized.id,
      root,
      leaseId: normalized.leaseId,
      fence,
      plan,
      createdDirs,
    })
    await writeJournalManifest(journalDir, manifest)
    manifestWritten = true
    const journalPath = path.join(journalDir, JOURNAL_FILE)

    try {
      for (const item of plan) {
        // Re-check immediately before each write: another holder may have
        // acquired (and advanced the fence) since the previous file.
        if (guard !== undefined) await guard()
        try {
          await writeFileAtomic(item.target, item.afterBuffer, { mode: item.entry.mode })
        } catch (error) {
          throw new ApplyError(
            APPLY_ERROR_CODES.WRITE_FAILED,
            `cannot atomically replace "${item.entry.path}": ${messageOf(error)}`,
            {
              path: item.entry.path,
              journalPath,
              cause: error instanceof Error ? error.code : undefined,
            },
          )
        }
        item.entry.applied = true
      }
      manifest.status = 'applied'
      manifest.appliedAt = new Date().toISOString()
      manifest.updatedAt = manifest.appliedAt
      await writeJournalManifest(journalDir, manifest)
      return {
        ...hydrateJournal(manifest, journalPath, root),
        applied: true,
      }
    } catch (error) {
      const failures = await restoreEntries(manifest, { root, journalDir, guard })
      if (failures.length === 0) {
        await removeEmptyDirs(root, createdDirs)
        if (journalRoot !== null) {
          try {
            await fs.rm(journalDir, { recursive: true, force: true })
          } catch {
            // The tree is restored; a leftover empty journal is harmless.
          }
        }
        const wrapped =
          error instanceof ApplyError
            ? error
            : new ApplyError(APPLY_ERROR_CODES.WRITE_FAILED, messageOf(error))
        wrapped.details = {
          ...(wrapped.details ?? {}),
          journalPath: null,
          recovered: true,
        }
        throw wrapped
      }
      manifest.status = 'applyFailed'
      manifest.updatedAt = new Date().toISOString()
      manifest.error = {
        code: error instanceof ApplyError ? error.code : 'ERROR',
        message: messageOf(error),
        failures,
      }
      try {
        await writeJournalManifest(journalDir, manifest)
      } catch {
        // The original message already points at the retained journal.
      }
      const failedCode =
        error instanceof ApplyError && error.code === APPLY_ERROR_CODES.FENCED
          ? APPLY_ERROR_CODES.FENCED
          : APPLY_ERROR_CODES.WRITE_FAILED
      throw new ApplyError(
        failedCode,
        `apply failed and automatic recovery failed for ${failures.length} path(s); ` +
          `journal retained at "${journalPath}"`,
        {
          journalPath,
          fence,
          cause: error instanceof Error ? error.code : undefined,
          failures,
        },
      )
    }
  } catch (error) {
    if (!manifestWritten && journalDir !== null) {
      await removeEmptyDirs(root, createdDirs)
      if (journalRoot !== null) {
        try {
          await fs.rm(journalDir, { recursive: true, force: true })
        } catch {
          // Preparation never wrote a target, so a leftover journal dir is inert.
        }
      }
    }
    throw error
  } finally {
    await lock.release()
  }
}

/**
 * Read one journal by id from `<root>/.dsh-os-lease/journal/<id>/journal.json`.
 *
 * @param {string} id
 * @param {{ root: string }} options
 * @returns {Promise<any>}
 */
export async function readJournal(id, options) {
  const journalId = sanitizeJournalId(id)
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ApplyError(APPLY_ERROR_CODES.INVALID_ARGUMENT, 'readJournal options must be an object')
  }
  const root = await resolveRoot(options.root)
  let current = root
  for (const segment of [STATE_DIRNAME, JOURNAL_DIRNAME, journalId]) {
    current = path.join(current, segment)
    assertInsideRoot(root, current)
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if (error instanceof Error && error.code === 'ENOENT') {
        throw new ApplyError(
          APPLY_ERROR_CODES.NOT_FOUND,
          `journal "${journalId}" does not exist under "${root}"`,
          { id: journalId, root, missing: 'journalDir' },
        )
      }
      throw new ApplyError(
        APPLY_ERROR_CODES.FS_ERROR,
        `cannot inspect journal "${journalId}": ${messageOf(error)}`,
        { id: journalId, root, cause: error instanceof Error ? error.code : undefined },
      )
    }
    if (stat.isSymbolicLink()) {
      throw new ApplyError(
        APPLY_ERROR_CODES.PATH_ESCAPE,
        `journal path "${current}" is a symbolic link`,
        { id: journalId, journalPath: current },
      )
    }
    if (!stat.isDirectory()) {
      throw new ApplyError(
        APPLY_ERROR_CODES.JOURNAL_CORRUPT,
        `journal path "${current}" is not a directory`,
        { id: journalId, journalPath: current },
      )
    }
  }
  const journalDir = current
  const located = await readJournalFile(path.join(journalDir, JOURNAL_FILE), journalDir, {
    expectedId: journalId,
  })
  return hydrateJournal(located.manifest, located.journalPath, located.root)
}

/**
 * Locate a journal from a path or a previously returned journal object.
 *
 * @param {string | object} reference
 * @param {{ root?: string }} options
 */
async function locateJournal(reference, options) {
  if (typeof reference === 'string') {
    let absolute
    try {
      absolute = path.resolve(reference)
    } catch (error) {
      throw new ApplyError(
        APPLY_ERROR_CODES.INVALID_ARGUMENT,
        `journal path "${reference}" is invalid: ${messageOf(error)}`,
      )
    }
    let stat
    try {
      stat = await fs.lstat(absolute)
    } catch (error) {
      if (error instanceof Error && error.code === 'ENOENT') {
        throw new ApplyError(
          APPLY_ERROR_CODES.NOT_FOUND,
          `journal "${absolute}" does not exist`,
          { journalPath: absolute },
        )
      }
      throw new ApplyError(
        APPLY_ERROR_CODES.FS_ERROR,
        `cannot inspect journal "${absolute}": ${messageOf(error)}`,
        { journalPath: absolute, cause: error instanceof Error ? error.code : undefined },
      )
    }
    if (stat.isSymbolicLink()) {
      throw new ApplyError(
        APPLY_ERROR_CODES.SYMLINK_NOT_ALLOWED,
        `journal "${absolute}" is a symbolic link`,
        { journalPath: absolute },
      )
    }
    const journalPath = stat.isDirectory() ? path.join(absolute, JOURNAL_FILE) : absolute
    const journalDir = stat.isDirectory() ? absolute : path.dirname(absolute)
    let dirStat
    try {
      dirStat = await fs.lstat(journalDir)
    } catch (error) {
      throw new ApplyError(
        APPLY_ERROR_CODES.NOT_FOUND,
        `journal directory "${journalDir}" is not readable: ${messageOf(error)}`,
        { journalPath: journalDir },
      )
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new ApplyError(
        APPLY_ERROR_CODES.JOURNAL_CORRUPT,
        `journal directory "${journalDir}" is not a real directory`,
        { journalPath: journalDir },
      )
    }
    return readJournalFile(journalPath, journalDir, {
      requestedRoot: options.root,
    })
  }

  if (reference === null || typeof reference !== 'object' || Array.isArray(reference)) {
    throw new ApplyError(
      APPLY_ERROR_CODES.INVALID_ARGUMENT,
      'rollback expects a journal path or a journal object',
    )
  }
  if (typeof reference.journalPath === 'string') {
    return locateJournal(reference.journalPath, options)
  }
  if (typeof reference.dir === 'string') {
    return locateJournal(path.join(reference.dir, JOURNAL_FILE), options)
  }
  const rootValue = options.root ?? reference.root
  if (typeof reference.id === 'string' && typeof rootValue === 'string') {
    const root = await resolveRoot(rootValue)
    const journal = await readJournal(reference.id, { root })
    return {
      manifest: journal,
      root,
      journalPath: journal.journalPath,
      journalDir: journal.dir,
    }
  }
  throw new ApplyError(
    APPLY_ERROR_CODES.INVALID_ARGUMENT,
    'journal object must include journalPath, dir, or id plus root',
  )
}

/**
 * Restore all files recorded in a journal, in reverse apply order.
 *
 * The operation is idempotent: a journal already marked `rolledBack` is a
 * no-op, and repeating a partially completed rollback restores from the same
 * backups again. Failures are collected and reported with the journal path.
 *
 * Passing `fence` turns on fencing: the token is checked with
 * {@link assertFence} before the journal is marked as rolling back and again
 * immediately before each restored or deleted file. A stale token throws
 * `FENCED` and leaves the journal untouched. Without `fence` the previous
 * behavior (no fencing) is preserved.
 *
 * @param {string | object} journalPathOrJournal
 * @param {{ root?: string, fence?: number, fencePath?: string }} [options]
 * @returns {Promise<any>}
 */
export async function rollback(journalPathOrJournal, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ApplyError(APPLY_ERROR_CODES.INVALID_ARGUMENT, 'rollback options must be an object')
  }
  if (
    options.root !== undefined &&
    (typeof options.root !== 'string' || options.root.trim() === '')
  ) {
    throw new ApplyError(APPLY_ERROR_CODES.INVALID_ROOT, 'rollback options.root must be a non-empty string')
  }
  const fence = normalizeFence(options.fence, 'rollback options.fence')
  const located = await locateJournal(journalPathOrJournal, options)
  const { manifest, root, journalPath, journalDir } = located
  const guard =
    fence === null
      ? undefined
      : async () => {
          await assertFence(root, fence, { fencePath: options.fencePath })
        }
  if (guard !== undefined) await guard()

  if (manifest.status === 'rolledBack') {
    return rollbackResult(manifest, journalPath, root, true)
  }

  manifest.status = 'rollingBack'
  manifest.updatedAt = new Date().toISOString()
  try {
    await writeJournalManifest(journalDir, manifest)
  } catch (error) {
    throw new ApplyError(
      APPLY_ERROR_CODES.ROLLBACK_FAILED,
      `cannot mark journal "${manifest.id}" as rolling back: ${messageOf(error)}`,
      { journalPath, cause: error instanceof Error ? error.code : undefined },
    )
  }

  const failures = await restoreEntries(manifest, { root, journalDir, guard })
  if (failures.length > 0) {
    manifest.status = 'rollbackFailed'
    manifest.updatedAt = new Date().toISOString()
    manifest.rollbackError = {
      at: manifest.updatedAt,
      failures,
    }
    try {
      await writeJournalManifest(journalDir, manifest)
    } catch (error) {
      failures.push({
        path: JOURNAL_FILE,
        code: 'JOURNAL_WRITE_FAILED',
        message: messageOf(error),
      })
    }
    throw new ApplyError(
      APPLY_ERROR_CODES.ROLLBACK_FAILED,
      `rollback of journal "${manifest.id}" failed for ${failures.length} path(s): ` +
        failures.map((failure) => `"${failure.path}" (${failure.code})`).join(', '),
      { journalPath, fence, failures },
    )
  }

  manifest.status = 'rolledBack'
  manifest.rolledBackAt = new Date().toISOString()
  manifest.updatedAt = manifest.rolledBackAt
  delete manifest.rollbackError
  delete manifest.error
  try {
    await writeJournalManifest(journalDir, manifest)
  } catch (error) {
    throw new ApplyError(
      APPLY_ERROR_CODES.ROLLBACK_FAILED,
      `files were restored but journal "${manifest.id}" could not be marked rolled back: ` +
        messageOf(error),
      { journalPath, cause: error instanceof Error ? error.code : undefined },
    )
  }
  return rollbackResult(manifest, journalPath, root, false)
}
