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
 * These are *leases*, not linearizable distributed locks. TTL decisions use a
 * local clock, reclaim is best effort, and there is no fencing token enforced
 * by the target filesystem. Read `docs/cross-host-locks.md` before relying on
 * cross-host exclusion.
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
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
})

/** Default lock lifetime used when a caller omits `ttlMs`. */
export const DEFAULT_LOCK_TTL_MS = 900_000

/** On-disk lock record version. */
export const LOCK_VERSION = 1

/** How often an acquire may retry after reclaiming or losing a stale file. */
const MAX_ACQUIRE_ATTEMPTS = 5

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
 * @returns {{ ttlMs: number, owner: string }}
 */
function normalizeAcquireOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new LockError(
      LOCK_ERROR_CODES.INVALID_ARGUMENT,
      'acquire options must be an object',
    )
  }
  return {
    ttlMs: normalizeTtl(options.ttlMs),
    owner: normalizeOwner(options.owner),
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
 * Lock provider interface.
 *
 * Implementations must be safe to share between concurrent callers in one
 * process and must throw {@link LockError} with a stable `code`. `acquire`
 * must either create a fresh lock or throw `LOCKED`; it must never hand out a
 * second handle for the same live key. `renew` and `release` must verify the
 * handle's token so an expired holder cannot release a lock that a newer
 * owner has since acquired.
 *
 * The base class only documents the contract; subclass it or provide a
 * duck-typed object with the same four methods.
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
   * @param {{ ttlMs?: number, owner: string }} _options
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
 */
export class FileLockProvider extends LockProvider {
  #dir
  #ready

  /**
   * @param {{ dir: string, clock?: () => number }} options
   */
  constructor(options = {}) {
    super(options)
    if (typeof options.dir !== 'string' || options.dir.trim() === '') {
      throw new LockError(
        LOCK_ERROR_CODES.INVALID_ARGUMENT,
        'FileLockProvider requires a non-empty dir',
      )
    }
    this.#dir = path.resolve(options.dir)
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
      this.#ready = ensureLockDirectory(this.#dir).catch((error) => {
        this.#ready = null
        throw error
      })
    }
    await this.#ready
  }

  /**
   * @param {string} key
   * @param {{ ttlMs?: number, owner: string }} options
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
        await handle.writeFile(`${JSON.stringify(record)}\n`)
        await handle.sync()
      } catch (error) {
        await handle.close().catch(() => {})
        handle = null
        await fs.unlink(lockPath).catch(() => {})
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
      pid: observed.pid,
      lockPath,
    })
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
  /** @type {Map<string, { key: string, owner: string, token: string, expiresAt: number, acquiredAt: number, renewedAt: number | null }>} */
  #locks = new Map()

  /** @returns {'memory'} */
  get kind() {
    return 'memory'
  }

  /** Drop every lock. Intended for test cleanup. */
  clear() {
    this.#locks.clear()
  }

  /**
   * @param {string} key
   * @param {{ ttlMs?: number, owner: string }} options
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
    const record = {
      key: safeKey,
      owner: settings.owner,
      token: randomToken(),
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
    })
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
