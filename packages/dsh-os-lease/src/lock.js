/**
 * Pluggable locks for dsh-os-lease.
 *
 * The applier needs one short-lived mutual-exclusion primitive per normalized
 * path: acquire before touching the tree, release after the journal is written
 * (or the apply failed). This module defines that primitive as a small
 * provider interface so a host can choose where the coordination state lives:
 *
 * - {@link FileLockProvider} stores one lock file per key under a directory.
 *   The file is created with `wx` (atomic `O_CREAT|O_EXCL`), so two processes
 *   that agree on the directory also agree on who acquired a key. Lock files
 *   carry `owner` and `expiresAt`; once `now >= expiresAt` another holder may
 *   reclaim the key. This works across processes on one host, and across hosts
 *   only when the directory lives on a shared filesystem whose `open(..., 'wx')`
 *   and `rename` semantics are reliable. See `docs/cross-host-locks.md`.
 * - {@link MemoryLockProvider} keeps the same contract in a `Map`. It is for
 *   tests and single-process embedding; two instances never see each other.
 * - {@link LockProvider} is the interface. A deployment that already has Redis,
 *   a SQL database, etcd, or a lock service can implement it and pass the
 *   provider to `applyPatchset`; this package does not ship those adapters.
 *
 * Each successful `acquire` also issues a **monotonic fencing token**
 * (`handle.fence`). `FileLockProvider` keeps the counter in a `fence` file and
 * allocates the next value with read-increment-atomic-rename; `MemoryLockProvider`
 * uses an in-process counter. The token is only a number: the target
 * filesystem does not enforce it. `applyPatchset`/`rollback` compare it with
 * the current fence file before each target write and refuse a stale token
 * with `FENCED`. That catches "a newer token was already visible before this
 * write"; it cannot stop a holder that was paused between its fence check and
 * its write. Read `docs/cross-host-locks.md` before relying on cross-host
 * exclusion.
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Stable machine-readable lock error codes. */
export const LOCK_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  LOCKED: 'LOCKED',
  LOCK_EXPIRED: 'LOCK_EXPIRED',
  LOCK_LOST: 'LOCK_LOST',
  LOCK_FAILED: 'LOCK_FAILED',
  FENCED: 'FENCED',
  FENCE_FAILED: 'FENCE_FAILED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
})

/** Default lock lifetime used when a caller omits `ttlMs`. */
export const DEFAULT_LOCK_TTL_MS = 900_000

/** On-disk lock record version. */
export const LOCK_VERSION = 1

/** Basename of the fencing counter, relative to `FileLockProvider#dir` by default. */
export const FENCE_FILE_NAME = 'fence'

/** How often an acquire may retry after reclaiming or losing a stale file. */
const MAX_ACQUIRE_ATTEMPTS = 5

/** Bound on the read-increment-rename retry loop for fence allocation. */
const MAX_FENCE_ATTEMPTS = 200

/** Delay between fence allocation retries, in milliseconds. */
const FENCE_RETRY_DELAY_MS = 2

/**
 * A `.next-<n>` candidate older than this is assumed to belong to a crashed
 * allocator and may be removed. Reclaiming a candidate from a live-but-paused
 * allocator is safe: the paused allocator's rename then fails with `ENOENT`
 * and it retries with the newer counter value.
 */
const FENCE_CANDIDATE_STALE_MS = 30_000

/**
 * Error thrown by lock providers.
 *
 * `details` is plain JSON. For `LOCKED` it always includes `owner` and
 * `expiresAt` (`null` when the existing lock record has no expiry), plus the
 * key and, for file locks, the lock file path.
 */
export class LockError extends Error {
  /**
   * @param {string} code One of {@link LOCK_ERROR_CODES}.
   * @param {string} message Human-readable explanation.
   * @param {Record<string, unknown>} [details] Optional structured context.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'LockError'
    /** @type {string} */
    this.code = code
    if (details !== undefined) {
      /** @type {Record<string, unknown>} */
      this.details = details
    }
  }
}

/**
 * @typedef {object} LockHandle
 * @property {string} key Locked key.
 * @property {string} owner Caller-supplied owner label.
 * @property {string} token Capability token; required by `renew`/`release`.
 * @property {number | null} fence Monotonic fencing token issued by this
 *   acquire, or `null` when the provider does not issue one. Pass it to
 *   `applyPatchset({ fence })` / `rollback(journal, { fence })`.
 * @property {number} expiresAt Epoch milliseconds; the lock is reclaimable at
 *   or after this instant.
 * @property {number} acquiredAt Epoch milliseconds.
 * @property {number | null} renewedAt Epoch milliseconds, or `null`.
 * @property {string} provider Provider kind (`file`, `memory`, or custom).
 * @property {string} [lockPath] File path, for {@link FileLockProvider}.
 */

/**
 * @typedef {object} LockInspection
 * @property {string} key Inspected key.
 * @property {boolean} locked Whether a lock record currently exists.
 * @property {string | null} owner Owner in the record, if any.
 * @property {number | null} expiresAt Expiry in epoch milliseconds, if any.
 * @property {boolean} expired `true` means a record exists but may be reclaimed
 *   by the next acquirer. It is never `true` when `locked` is `false`.
 * @property {number | null} acquiredAt
 * @property {number | null} renewedAt
 * @property {number | null} [fence] Fencing token recorded with the lock.
 * @property {number | null} [pid] Process id recorded by the file provider.
 * @property {string} [lockPath]
 */

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {string} value */
function sha256(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')
}

/** @returns {string} */
function randomToken() {
  return randomBytes(16).toString('hex')
}

/**
 * Deterministic filename for a key. Hashing keeps arbitrary keys (including
 * `/` and non-ASCII text) safe on every filesystem, and keeps the filename
 * short enough for Windows path limits.
 *
 * @param {string} key
 * @returns {string}
 */
export function lockFileName(key) {
  return `${sha256(normalizeKey(key))}.lock`
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeKey(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LockError(LOCK_ERROR_CODES.INVALID_ARGUMENT, 'lock key must be a non-empty string')
  }
  if (value.length > 1024) {
    throw new LockError(LOCK_ERROR_CODES.INVALID_ARGUMENT, 'lock key must be at most 1024 characters')
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new LockError(
      LOCK_ERROR_CODES.INVALID_ARGUMENT,
      'lock key must not contain control characters',
    )
  }
  return value
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeOwner(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LockError(LOCK_ERROR_CODES.INVALID_ARGUMENT, 'lock owner must be a non-empty string')
  }
  if (value.length > 256) {
    throw new LockError(LOCK_ERROR_CODES.INVALID_ARGUMENT, 'lock owner must be at most 256 characters')
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new LockError(
      LOCK_ERROR_CODES.INVALID_ARGUMENT,
      'lock owner must not contain control characters',
    )
  }
  return value
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeTtl(value, fallback = DEFAULT_LOCK_TTL_MS) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new LockError(
      LOCK_ERROR_CODES.INVALID_ARGUMENT,
      'lock ttlMs must be a positive finite number',
    )
  }
  const ttl = Math.floor(value)
  if (ttl < 1) {
    throw new LockError(
      LOCK_ERROR_CODES.INVALID_ARGUMENT,
      'lock ttlMs must be at least 1 millisecond',
    )
  }
  return ttl
}

/**
 * @param {unknown} options
 * @returns {{ ttlMs: number, owner: string, issueFence: boolean }}
 */
function normalizeAcquireOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new LockError(
      LOCK_ERROR_CODES.INVALID_ARGUMENT,
      'acquire options must be an object',
    )
  }
  if (options.issueFence !== undefined && typeof options.issueFence !== 'boolean') {
    throw new LockError(
      LOCK_ERROR_CODES.INVALID_ARGUMENT,
      'acquire options.issueFence must be a boolean when present',
    )
  }
  return {
    ttlMs: normalizeTtl(options.ttlMs),
    owner: normalizeOwner(options.owner),
    // `issueFence: false` acquires mutual exclusion without consuming a token.
    // `applyPatchset` uses it when the caller already supplied a fence.
    issueFence: options.issueFence !== false,
  }
}

/**
 * @param {unknown} handle
 * @returns {{ key: string, token: string }}
 */
function ownedHandle(handle) {
  if (handle === null || typeof handle !== 'object' || Array.isArray(handle)) {
    throw new LockError(LOCK_ERROR_CODES.INVALID_ARGUMENT, 'lock handle must be an object')
  }
  const key = normalizeKey(/** @type {any} */ (handle).key)
  const token = /** @type {any} */ (handle).token
  if (typeof token !== 'string' || token === '') {
    throw new LockError(
      LOCK_ERROR_CODES.INVALID_ARGUMENT,
      'lock handle has no token; use the handle returned by acquire()',
    )
  }
  return { key, token }
}

/**
 * @param {object} input
 * @returns {LockHandle}
 */
function makeHandle(input) {
  return Object.freeze({
    key: input.key,
    owner: input.owner,
    token: input.token,
    fence: Number.isSafeInteger(input.fence) && input.fence >= 0 ? input.fence : null,
    expiresAt: input.expiresAt,
    acquiredAt: input.acquiredAt,
    renewedAt: input.renewedAt ?? null,
    provider: input.provider,
    ...(input.lockPath === undefined ? {} : { lockPath: input.lockPath }),
  })
}

/**
 * Accept epoch milliseconds or an ISO-8601 string. Hand-written/legacy records
 * sometimes use `new Date().toISOString()`; an unparseable value is `null`,
 * which the reader treats conservatively as "no expiry".
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Parse a lock-file body. Malformed or legacy files are not trusted for
 * ownership, but they are still treated as *held* (see `expiresAt === null`).
 *
 * @param {string} raw
 */
function parseLockRecord(raw) {
  let value = null
  try {
    value = JSON.parse(raw)
  } catch {
    // Keep the record-less view: an unreadable lock is still a lock.
  }
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    owner: typeof record.owner === 'string' && record.owner !== '' ? record.owner : null,
    token: typeof record.token === 'string' && record.token !== '' ? record.token : null,
    fence:
      Number.isSafeInteger(record.fence) && record.fence >= 0 ? record.fence : null,
    expiresAt: toEpochMs(record.expiresAt),
    acquiredAt: toEpochMs(record.acquiredAt),
    renewedAt: toEpochMs(record.renewedAt),
    pid: Number.isInteger(record.pid) ? record.pid : null,
  }
}

/**
 * @param {string} lockPath
 * @param {number} now
 */
async function readLockRecord(lockPath, now) {
  let raw
  try {
    raw = await fs.readFile(lockPath, 'utf8')
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return { exists: false }
    throw new LockError(
      LOCK_ERROR_CODES.LOCK_FAILED,
      `cannot read lock file "${lockPath}": ${messageOf(error)}`,
      { lockPath, cause: error instanceof Error ? error.code : undefined },
    )
  }
  const record = parseLockRecord(raw)
  return {
    exists: true,
    ...record,
    // A missing/invalid expiry is conservative: legacy and hand-written locks
    // are never reclaimed automatically.
    expired: record.expiresAt !== null && now >= record.expiresAt,
  }
}

/**
 * Error payload for an existing, unexpired lock. The token is deliberately
 * omitted: it is the capability that lets the holder renew or release.
 *
 * @param {string} key
 * @param {string | undefined} lockPath
 * @param {{ owner: string | null, expiresAt: number | null, acquiredAt: number | null, pid: number | null }} record
 */
function lockedError(key, lockPath, record) {
  const owner = record.owner
  const expiresAt = record.expiresAt
  const holder = owner === null ? 'an unknown owner' : `"${owner}"`
  const until =
    expiresAt === null
      ? 'with no expiry (remove the stale lock file manually)'
      : `until ${new Date(expiresAt).toISOString()}`
  return new LockError(
    LOCK_ERROR_CODES.LOCKED,
    `lock "${key}" is held by ${holder} ${until}`,
    {
      key,
      ...(lockPath === undefined ? {} : { lockPath }),
      owner,
      expiresAt,
      holder: {
        owner,
        expiresAt,
        acquiredAt: record.acquiredAt,
        pid: record.pid,
      },
    },
  )
}

/**
 * @param {string} key
 * @param {string | undefined} lockPath
 * @param {string} reason
 */
function lockLostError(key, lockPath, reason) {
  return new LockError(
    LOCK_ERROR_CODES.LOCK_LOST,
    `lock "${key}" is no longer held by this handle: ${reason}`,
    { key, ...(lockPath === undefined ? {} : { lockPath }) },
  )
}

/**
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function ensureLockDirectory(dir) {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new LockError(
      LOCK_ERROR_CODES.LOCK_FAILED,
      `cannot create lock directory "${dir}": ${messageOf(error)}`,
      { lockPath: dir, cause: error instanceof Error ? error.code : undefined },
    )
  }
  let stat
  try {
    stat = await fs.lstat(dir)
  } catch (error) {
    throw new LockError(
      LOCK_ERROR_CODES.LOCK_FAILED,
      `cannot inspect lock directory "${dir}": ${messageOf(error)}`,
      { lockPath: dir, cause: error instanceof Error ? error.code : undefined },
    )
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new LockError(
      LOCK_ERROR_CODES.LOCK_FAILED,
      `lock directory "${dir}" is not a real directory`,
      { lockPath: dir },
    )
  }
}

/**
 * Read the fencing counter at `fencePath`. A missing file is `0` (no token has
 * been issued yet). A file whose body is not a non-negative safe integer is an
 * error: silently treating it as `0` would disable fencing.
 *
 * @param {string} fencePath
 * @returns {Promise<number>}
 */
export async function readFenceValue(fencePath) {
  let raw
  try {
    raw = await fs.readFile(fencePath, 'utf8')
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return 0
    throw new LockError(
      LOCK_ERROR_CODES.FENCE_FAILED,
      `cannot read fence file "${fencePath}": ${messageOf(error)}`,
      { fencePath, cause: error instanceof Error ? error.code : undefined },
    )
  }
  const text = raw.trim()
  const value = text === '' ? Number.NaN : Number(text)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LockError(
      LOCK_ERROR_CODES.FENCE_FAILED,
      `fence file "${fencePath}" does not contain a non-negative integer`,
      { fencePath, value: text.slice(0, 64) },
    )
  }
  return value
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * fsync a directory so a completed rename survives a system crash. Several
 * platforms (Windows, some network filesystems) refuse to open a directory for
 * fsync; that failure is ignored.
 *
 * @param {string} directory
 */
async function syncDirectoryBestEffort(directory) {
  let handle = null
  try {
    handle = await fs.open(directory, 'r')
    await handle.sync()
  } catch {
    // Best effort only; the rename is still atomic.
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
 * Remove a crashed allocator's `.next-<n>` candidate once it is old enough.
 * Failure is ignored: the retry loop will report a useful error if the
 * candidate stays in the way.
 *
 * @param {string} candidate
 */
async function reclaimStaleFenceCandidate(candidate) {
  let stat
  try {
    stat = await fs.lstat(candidate)
  } catch {
    return
  }
  if (Date.now() - stat.mtimeMs < FENCE_CANDIDATE_STALE_MS) return
  try {
    await fs.unlink(candidate)
  } catch {
    // Another reclaimer won, or the owner renamed it first.
  }
}

/**
 * Allocate the next fencing token in `fencePath`.
 *
 * The counter is read, incremented, written to a deterministic candidate
 * `<fencePath>.next-<n>`, and atomically renamed over `fencePath`. The `wx`
 * create of the candidate is what serializes two concurrent allocators: both
 * may read `n`, but only one can create `.next-<n+1>`; the other retries after
 * the rename becomes visible and allocates `n+2`. The token value is never
 * handed out twice, even though the read and the rename are separate syscalls.
 * Gaps are possible when an allocator fails after creating a candidate.
 *
 * @param {string} fencePath
 * @returns {Promise<number>}
 */
export async function allocateFence(fencePath) {
  for (let attempt = 0; attempt < MAX_FENCE_ATTEMPTS; attempt += 1) {
    const current = await readFenceValue(fencePath)
    const next = current + 1
    if (!Number.isSafeInteger(next)) {
      throw new LockError(
        LOCK_ERROR_CODES.FENCE_FAILED,
        `fence counter at "${fencePath}" is exhausted`,
        { fencePath },
      )
    }
    const candidate = `${fencePath}.next-${next}`
    let created = false
    try {
      const handle = await fs.open(candidate, 'wx', 0o600)
      try {
        await handle.writeFile(`${next}\n`)
        await handle.sync()
      } finally {
        await handle.close().catch(() => {})
      }
      created = true
    } catch (error) {
      if (!(error instanceof Error) || error.code !== 'EEXIST') {
        // A partial candidate may exist (open succeeded, write/sync failed);
        // remove it so this value is not blocked until the stale timeout.
        await fs.unlink(candidate).catch(() => {})
        throw new LockError(
          LOCK_ERROR_CODES.FENCE_FAILED,
          `cannot allocate fence candidate "${candidate}": ${messageOf(error)}`,
          { fencePath, cause: error instanceof Error ? error.code : undefined },
        )
      }
      await reclaimStaleFenceCandidate(candidate)
    }
    if (!created) {
      await sleep(FENCE_RETRY_DELAY_MS)
      continue
    }
    // Re-read after creating the candidate. If the counter already reached
    // `next`, our read was stale and this candidate is a *second* copy of an
    // already-published value (another allocator can create it once our
    // predecessor renamed its own candidate away). Aborting here is what
    // makes duplicate tokens impossible.
    const observed = await readFenceValue(fencePath)
    if (observed >= next) {
      await fs.unlink(candidate).catch(() => {})
      await sleep(FENCE_RETRY_DELAY_MS)
      continue
    }
    try {
      await fs.rename(candidate, fencePath)
      await syncDirectoryBestEffort(path.dirname(fencePath))
      return next
    } catch (error) {
      // A stale-candidate reclaimer removed our file; retry from the counter.
      if (error instanceof Error && error.code === 'ENOENT') {
        await sleep(FENCE_RETRY_DELAY_MS)
        continue
      }
      await fs.unlink(candidate).catch(() => {})
      throw new LockError(
        LOCK_ERROR_CODES.FENCE_FAILED,
        `cannot publish fence "${candidate}": ${messageOf(error)}`,
        { fencePath, cause: error instanceof Error ? error.code : undefined },
      )
    }
  }
  throw new LockError(
    LOCK_ERROR_CODES.FENCE_FAILED,
    `cannot allocate a fence token at "${fencePath}" after ${MAX_FENCE_ATTEMPTS} attempts`,
    { fencePath },
  )
}

/**
 * Lock provider interface.
 *
 * Implementations must be safe to share between concurrent callers in one
 * process and must throw {@link LockError} with a stable `code`. `acquire`
 * must either create a fresh lock or throw `LOCKED`; it must never hand out a
 * second handle for the same live key. `renew` and `release` must verify the
 * handle's token so an expired holder cannot release a lock that a newer
 * owner has since acquired.
 *
 * Providers may also issue a monotonic `handle.fence` and expose
 * `currentFence()` so the applier can reject stale holders. Providers that do
 * not are still usable; `applyPatchset` falls back to the root fence file (see
 * `docs/cross-host-locks.md`).
 *
 * The base class only documents the contract; subclass it or provide a
 * duck-typed object with the same methods.
 */
export class LockProvider {
  #clock

  /**
   * @param {{ clock?: () => number }} [options] `clock` returns epoch
   *   milliseconds and is injectable for tests.
   */
  constructor(options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new LockError(
        LOCK_ERROR_CODES.INVALID_ARGUMENT,
        'lock provider options must be an object',
      )
    }
    const clock = options.clock ?? Date.now
    if (typeof clock !== 'function') {
      throw new LockError(
        LOCK_ERROR_CODES.INVALID_ARGUMENT,
        'lock provider clock must be a function returning epoch milliseconds',
      )
    }
    this.#clock = clock
  }

  /** @returns {string} */
  get kind() {
    return 'abstract'
  }

  /** @returns {number} Epoch milliseconds from the injected clock. */
  now() {
    const value = this.#clock()
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new LockError(
        LOCK_ERROR_CODES.LOCK_FAILED,
        'lock provider clock returned a non-finite value',
      )
    }
    return value
  }

  /**
   * @param {string} _key
   * @param {{ ttlMs?: number, owner: string, issueFence?: boolean }} _options
   * @returns {Promise<LockHandle>}
   */
  async acquire(_key, _options) {
    throw new LockError(LOCK_ERROR_CODES.NOT_IMPLEMENTED, 'LockProvider.acquire is abstract')
  }

  /**
   * @param {LockHandle} _handle
   * @param {{ ttlMs?: number }} [_options]
   * @returns {Promise<LockHandle>}
   */
  async renew(_handle, _options) {
    throw new LockError(LOCK_ERROR_CODES.NOT_IMPLEMENTED, 'LockProvider.renew is abstract')
  }

  /**
   * @param {LockHandle} _handle
   * @returns {Promise<{ key: string, owner: string, released: true }>}
   */
  async release(_handle) {
    throw new LockError(LOCK_ERROR_CODES.NOT_IMPLEMENTED, 'LockProvider.release is abstract')
  }

  /**
   * @param {string} _key
   * @returns {Promise<LockInspection>}
   */
  async inspect(_key) {
    throw new LockError(LOCK_ERROR_CODES.NOT_IMPLEMENTED, 'LockProvider.inspect is abstract')
  }

  /**
   * Current fencing counter, or `0` when the provider has never issued a
   * token. Providers without fencing may keep the default (which throws);
   * `applyPatchset` then verifies against the root fence file instead.
   *
   * @returns {Promise<number>}
   */
  async currentFence() {
    throw new LockError(
      LOCK_ERROR_CODES.NOT_IMPLEMENTED,
      'LockProvider.currentFence is abstract',
    )
  }
}

/**
 * Lock files under one directory.
 *
 * Each key maps to `<sha256(key)>.lock`. The file is created with `wx`, so
 * creation is atomic on POSIX and on filesystems that implement exclusive
 * create correctly. Its body is a JSON record holding `owner`, `token`,
 * `expiresAt`, `acquiredAt`, `renewedAt`, and `pid`.
 *
 * Expired records are reclaimed by renaming the stale file to a unique name
 * and retrying `wx`. The rename is atomic, so only one reclaimer wins; the
 * contents are re-read immediately before the rename to keep the window for
 * accidentally moving a just-reacquired lock small. That window is not zero:
 * this is a best-effort lease, not a linearizable lock.
 *
 * Fencing lives in a separate counter file (`fencePath`, default
 * `<dir>/fence`). It is a plain decimal integer and is bumped by every
 * successful acquire; see {@link allocateFence}.
 */
export class FileLockProvider extends LockProvider {
  #dir
  #fencePath
  #ready

  /**
   * @param {{ dir: string, clock?: () => number, fencePath?: string }} options
   */
  constructor(options = {}) {
    super(options)
    if (typeof options.dir !== 'string' || options.dir.trim() === '') {
      throw new LockError(
        LOCK_ERROR_CODES.INVALID_ARGUMENT,
        'FileLockProvider requires a non-empty dir',
      )
    }
    if (
      options.fencePath !== undefined &&
      (typeof options.fencePath !== 'string' || options.fencePath.trim() === '')
    ) {
      throw new LockError(
        LOCK_ERROR_CODES.INVALID_ARGUMENT,
        'FileLockProvider fencePath must be a non-empty string when present',
      )
    }
    this.#dir = path.resolve(options.dir)
    this.#fencePath =
      options.fencePath === undefined
        ? path.join(this.#dir, FENCE_FILE_NAME)
        : path.resolve(options.fencePath)
    /** @type {Promise<void> | null} */
    this.#ready = null
  }

  /** @returns {'file'} */
  get kind() {
    return 'file'
  }

  /** @returns {string} Absolute lock directory. */
  get dir() {
    return this.#dir
  }

  /** @returns {string} Absolute path of the fencing counter. */
  get fencePath() {
    return this.#fencePath
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  lockPath(key) {
    return path.join(this.#dir, lockFileName(key))
  }

  /** @returns {Promise<void>} */
  async #ensureDirectory() {
    if (this.#ready === null) {
      this.#ready = (async () => {
        await ensureLockDirectory(this.#dir)
        const fenceDir = path.dirname(this.#fencePath)
        if (fenceDir !== this.#dir) await ensureLockDirectory(fenceDir)
      })().catch((error) => {
        this.#ready = null
        throw error
      })
    }
    await this.#ready
  }

  /**
   * @param {string} key
   * @param {{ ttlMs?: number, owner: string, issueFence?: boolean }} options
   * @returns {Promise<LockHandle>}
   */
  async acquire(key, options = {}) {
    const safeKey = normalizeKey(key)
    const settings = normalizeAcquireOptions(options)
    await this.#ensureDirectory()
    const lockPath = path.join(this.#dir, lockFileName(safeKey))

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const now = this.now()
      const token = randomToken()
      const record = {
        version: LOCK_VERSION,
        key: safeKey,
        owner: settings.owner,
        token,
        pid: process.pid,
        acquiredAt: now,
        renewedAt: null,
        expiresAt: now + settings.ttlMs,
      }
      let handle = null
      try {
        handle = await fs.open(lockPath, 'wx', 0o600)
      } catch (error) {
        if (!(error instanceof Error) || error.code !== 'EEXIST') {
          throw new LockError(
            LOCK_ERROR_CODES.LOCK_FAILED,
            `cannot create lock file "${lockPath}": ${messageOf(error)}`,
            {
              key: safeKey,
              lockPath,
              cause: error instanceof Error ? error.code : undefined,
            },
          )
        }
        const observed = await readLockRecord(lockPath, now)
        if (!observed.exists) continue
        if (!observed.expired) throw lockedError(safeKey, lockPath, observed)

        // Re-read immediately before reclaiming. If another process already
        // replaced the expired record, re-evaluate instead of moving its lock.
        const current = await readLockRecord(lockPath, this.now())
        if (!current.exists) continue
        if (!current.expired) throw lockedError(safeKey, lockPath, current)
        if (current.token !== observed.token) continue

        const claimed = `${lockPath}.stale-${process.pid}-${randomToken().slice(0, 12)}`
        try {
          await fs.rename(lockPath, claimed)
        } catch (renameError) {
          if (renameError instanceof Error && renameError.code === 'ENOENT') continue
          throw new LockError(
            LOCK_ERROR_CODES.LOCK_FAILED,
            `cannot reclaim expired lock "${lockPath}": ${messageOf(renameError)}`,
            {
              key: safeKey,
              lockPath,
              cause: renameError instanceof Error ? renameError.code : undefined,
            },
          )
        }
        try {
          await fs.unlink(claimed)
        } catch {
          // The claim is already atomically out of the way; cleanup is best effort.
        }
        continue
      }

      try {
        // The fence is allocated while the lock file is exclusively ours, so
        // no other successful acquire for this key can interleave. A failure
        // releases the path instead of leaving an unusable lock behind.
        record.fence = settings.issueFence
          ? await allocateFence(this.#fencePath)
          : await this.currentFence()
        await handle.writeFile(`${JSON.stringify(record)}\n`)
        await handle.sync()
      } catch (error) {
        await handle.close().catch(() => {})
        handle = null
        await fs.unlink(lockPath).catch(() => {})
        if (error instanceof LockError) throw error
        throw new LockError(
          LOCK_ERROR_CODES.LOCK_FAILED,
          `cannot write lock file "${lockPath}": ${messageOf(error)}`,
          {
            key: safeKey,
            lockPath,
            cause: error instanceof Error ? error.code : undefined,
          },
        )
      } finally {
        if (handle !== null) await handle.close().catch(() => {})
      }

      return makeHandle({ ...record, provider: 'file', lockPath })
    }

    throw new LockError(
      LOCK_ERROR_CODES.LOCK_FAILED,
      `could not acquire lock "${safeKey}" after ${MAX_ACQUIRE_ATTEMPTS} attempts`,
      { key: safeKey, lockPath },
    )
  }

  /**
   * @param {LockHandle} handle
   * @param {{ ttlMs?: number }} [options]
   * @returns {Promise<LockHandle>}
   */
  async renew(handle, options = {}) {
    const { key, token } = ownedHandle(handle)
    const ttlMs = normalizeTtl(options.ttlMs)
    await this.#ensureDirectory()
    const lockPath = path.join(this.#dir, lockFileName(key))

    let file
    try {
      file = await fs.open(lockPath, 'r+')
    } catch (error) {
      if (error instanceof Error && error.code === 'ENOENT') {
        throw lockLostError(key, lockPath, 'the lock file no longer exists')
      }
      throw new LockError(
        LOCK_ERROR_CODES.LOCK_FAILED,
        `cannot open lock file "${lockPath}": ${messageOf(error)}`,
        { key, lockPath, cause: error instanceof Error ? error.code : undefined },
      )
    }
    try {
      let raw
      try {
        raw = await file.readFile('utf8')
      } catch (error) {
        throw new LockError(
          LOCK_ERROR_CODES.LOCK_FAILED,
          `cannot read lock file "${lockPath}": ${messageOf(error)}`,
          { key, lockPath, cause: error instanceof Error ? error.code : undefined },
        )
      }
      const record = parseLockRecord(raw)
      if (record.token === null || record.token !== token) {
        throw lockLostError(key, lockPath, 'another owner holds the lock')
      }
      const now = this.now()
      if (record.expiresAt !== null && now >= record.expiresAt) {
        throw new LockError(
          LOCK_ERROR_CODES.LOCK_EXPIRED,
          `lock "${key}" expired at ${new Date(record.expiresAt).toISOString()}; acquire it again`,
          { key, lockPath, owner: record.owner, expiresAt: record.expiresAt },
        )
      }
      const updated = {
        version: LOCK_VERSION,
        key,
        owner: typeof handle.owner === 'string' ? handle.owner : record.owner,
        token,
        fence:
          Number.isSafeInteger(handle.fence) && handle.fence >= 0
            ? handle.fence
            : record.fence,
        pid: typeof record.pid === 'number' ? record.pid : process.pid,
        acquiredAt: record.acquiredAt ?? now,
        renewedAt: now,
        expiresAt: now + ttlMs,
      }
      const body = Buffer.from(`${JSON.stringify(updated)}\n`, 'utf8')
      await file.truncate(0)
      await file.write(body, 0, body.length, 0)
      await file.sync()
      return makeHandle({ ...updated, provider: 'file', lockPath })
    } finally {
      await file.close().catch(() => {})
    }
  }

  /**
   * @param {LockHandle} handle
   * @returns {Promise<{ key: string, owner: string, released: true, expiresAt: number | null }>}
   */
  async release(handle) {
    const { key, token } = ownedHandle(handle)
    await this.#ensureDirectory()
    const lockPath = path.join(this.#dir, lockFileName(key))
    const observed = await readLockRecord(lockPath, this.now())
    if (!observed.exists) {
      throw lockLostError(key, lockPath, 'the lock file no longer exists')
    }
    if (observed.token !== token) {
      throw lockLostError(key, lockPath, 'another owner holds the lock')
    }
    try {
      await fs.unlink(lockPath)
    } catch (error) {
      if (error instanceof Error && error.code === 'ENOENT') {
        throw lockLostError(key, lockPath, 'the lock file vanished during release')
      }
      throw new LockError(
        LOCK_ERROR_CODES.LOCK_FAILED,
        `cannot remove lock file "${lockPath}": ${messageOf(error)}`,
        { key, lockPath, cause: error instanceof Error ? error.code : undefined },
      )
    }
    return Object.freeze({
      key,
      owner: typeof handle.owner === 'string' ? handle.owner : observed.owner ?? 'unknown',
      released: true,
      fence:
        Number.isSafeInteger(handle.fence) && handle.fence >= 0
          ? handle.fence
          : observed.fence,
      expiresAt: observed.expiresAt,
    })
  }

  /**
   * @param {string} key
   * @returns {Promise<LockInspection>}
   */
  async inspect(key) {
    const safeKey = normalizeKey(key)
    const lockPath = path.join(this.#dir, lockFileName(safeKey))
    const observed = await readLockRecord(lockPath, this.now())
    if (!observed.exists) {
      return Object.freeze({
        key: safeKey,
        locked: false,
        owner: null,
        expiresAt: null,
        expired: false,
        acquiredAt: null,
        renewedAt: null,
        fence: null,
        lockPath,
      })
    }
    return Object.freeze({
      key: safeKey,
      locked: true,
      owner: observed.owner,
      expiresAt: observed.expiresAt,
      expired: observed.expired,
      acquiredAt: observed.acquiredAt,
      renewedAt: observed.renewedAt,
      fence: observed.fence,
      pid: observed.pid,
      lockPath,
    })
  }

  /**
   * Read the on-disk fencing counter. A missing file means no token has ever
   * been issued in this directory.
   *
   * @returns {Promise<number>}
   */
  async currentFence() {
    return readFenceValue(this.#fencePath)
  }
}

/**
 * In-memory provider for tests and single-process embedding.
 *
 * Two instances do not share state, so this provider cannot coordinate two
 * DSH processes, let alone two hosts. Use {@link FileLockProvider} on a shared
 * filesystem or a custom provider for that.
 */
export class MemoryLockProvider extends LockProvider {
  /** @type {Map<string, { key: string, owner: string, token: string, fence: number, expiresAt: number, acquiredAt: number, renewedAt: number | null }>} */
  #locks = new Map()

  /**
   * Monotonic in-process fencing counter. It is deliberately *not* reset by
   * {@link clear}: a token that was handed out must never be reissued.
   * @type {number}
   */
  #fence = 0

  /** @returns {'memory'} */
  get kind() {
    return 'memory'
  }

  /** Drop every lock. Intended for test cleanup. The fence counter is kept. */
  clear() {
    this.#locks.clear()
  }

  /**
   * @param {string} key
   * @param {{ ttlMs?: number, owner: string, issueFence?: boolean }} options
   * @returns {Promise<LockHandle>}
   */
  async acquire(key, options = {}) {
    const safeKey = normalizeKey(key)
    const settings = normalizeAcquireOptions(options)
    const now = this.now()
    const existing = this.#locks.get(safeKey)
    if (existing !== undefined && now < existing.expiresAt) {
      throw lockedError(safeKey, undefined, { ...existing, exists: true })
    }
    if (settings.issueFence) {
      if (!Number.isSafeInteger(this.#fence + 1)) {
        throw new LockError(
          LOCK_ERROR_CODES.FENCE_FAILED,
          'memory fence counter is exhausted',
        )
      }
      this.#fence += 1
    }
    const record = {
      key: safeKey,
      owner: settings.owner,
      token: randomToken(),
      fence: this.#fence,
      expiresAt: now + settings.ttlMs,
      acquiredAt: now,
      renewedAt: null,
    }
    this.#locks.set(safeKey, record)
    return makeHandle({ ...record, provider: 'memory' })
  }

  /**
   * @param {LockHandle} handle
   * @param {{ ttlMs?: number }} [options]
   * @returns {Promise<LockHandle>}
   */
  async renew(handle, options = {}) {
    const { key, token } = ownedHandle(handle)
    const ttlMs = normalizeTtl(options.ttlMs)
    const existing = this.#locks.get(key)
    if (existing === undefined || existing.token !== token) {
      throw lockLostError(key, undefined, 'another owner holds the lock')
    }
    const now = this.now()
    if (now >= existing.expiresAt) {
      throw new LockError(
        LOCK_ERROR_CODES.LOCK_EXPIRED,
        `lock "${key}" expired at ${new Date(existing.expiresAt).toISOString()}; acquire it again`,
        { key, owner: existing.owner, expiresAt: existing.expiresAt },
      )
    }
    const updated = { ...existing, renewedAt: now, expiresAt: now + ttlMs }
    this.#locks.set(key, updated)
    return makeHandle({ ...updated, provider: 'memory' })
  }

  /**
   * @param {LockHandle} handle
   * @returns {Promise<{ key: string, owner: string, released: true, expiresAt: number | null }>}
   */
  async release(handle) {
    const { key, token } = ownedHandle(handle)
    const existing = this.#locks.get(key)
    if (existing === undefined || existing.token !== token) {
      throw lockLostError(key, undefined, 'another owner holds the lock')
    }
    this.#locks.delete(key)
    return Object.freeze({
      key,
      owner: existing.owner,
      released: true,
      fence: existing.fence,
      expiresAt: existing.expiresAt,
    })
  }

  /**
   * @param {string} key
   * @returns {Promise<LockInspection>}
   */
  async inspect(key) {
    const safeKey = normalizeKey(key)
    const existing = this.#locks.get(safeKey)
    if (existing === undefined) {
      return Object.freeze({
        key: safeKey,
        locked: false,
        owner: null,
        expiresAt: null,
        expired: false,
        acquiredAt: null,
        renewedAt: null,
        fence: null,
      })
    }
    return Object.freeze({
      key: safeKey,
      locked: true,
      owner: existing.owner,
      expiresAt: existing.expiresAt,
      expired: this.now() >= existing.expiresAt,
      acquiredAt: existing.acquiredAt,
      renewedAt: existing.renewedAt,
      fence: existing.fence,
    })
  }

  /**
   * Latest fence issued by this provider instance.
   *
   * @returns {Promise<number>}
   */
  async currentFence() {
    return this.#fence
  }
}

/**
 * Validate a user-supplied provider before an apply starts.
 *
 * Duck typing is intentional: adapters backed by Redis, SQL, etcd, or a lock
 * daemon do not need to import this package. Requiring all four methods keeps
 * `inspect` usable for diagnostics and `renew` available for callers that
 * hold a lock longer than one apply.
 *
 * @param {unknown} provider
 * @returns {{ acquire: Function, renew: Function, release: Function, inspect: Function }}
 */
export function assertLockProvider(provider) {
  if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new LockError(
      LOCK_ERROR_CODES.INVALID_ARGUMENT,
      'lock provider must be an object with acquire/renew/release/inspect methods',
    )
  }
  for (const method of ['acquire', 'renew', 'release', 'inspect']) {
    if (typeof (/** @type {any} */ (provider)[method]) !== 'function') {
      throw new LockError(
        LOCK_ERROR_CODES.INVALID_ARGUMENT,
        `lock provider must implement ${method}()`,
      )
    }
  }
  return /** @type {any} */ (provider)
}

/**
 * Acquire `key`, run `fn(handle)`, and always release afterwards.
 *
 * The release always runs after `fn`, even when `fn` throws, so a failing
 * operation does not leave the path locked for the rest of the TTL. If the
 * operation failed and the release also fails, the operation error is thrown
 * with a best-effort `releaseError` property; the TTL remains the last resort.
 *
 * @template T
 * @param {LockProvider | { acquire: Function, renew: Function, release: Function, inspect: Function }} provider
 * @param {string} key
 * @param {(handle: LockHandle) => T | Promise<T>} fn
 * @param {{ ttlMs?: number, owner?: string }} [options]
 * @returns {Promise<T>}
 */
export async function withLock(provider, key, fn, options = {}) {
  assertLockProvider(provider)
  if (typeof fn !== 'function') {
    throw new LockError(LOCK_ERROR_CODES.INVALID_ARGUMENT, 'withLock requires a function')
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new LockError(LOCK_ERROR_CODES.INVALID_ARGUMENT, 'withLock options must be an object')
  }
  const handle = await provider.acquire(key, {
    ttlMs: options.ttlMs,
    owner: options.owner ?? `withLock:${process.pid}`,
  })
  let result
  try {
    result = await fn(handle)
  } catch (error) {
    try {
      await provider.release(handle)
    } catch (releaseError) {
      if (error !== null && typeof error === 'object') {
        try {
          /** @type {any} */ (error).releaseError = releaseError
        } catch {
          // Frozen/non-extensible errors are fine; the original error wins.
        }
      }
    }
    throw error
  }
  await provider.release(handle)
  return result
}
