/**
 * Pure core logic for dsh-os-registry.
 *
 * This module has no DSH package imports and performs no I/O: the clock, the
 * port range and the health probe are all injected. That keeps the whole lease
 * model testable offline with `node --test`.
 */

/** @typedef {'unknown' | 'ok' | 'down'} ServiceHealth */

/**
 * One local service lease.
 *
 * @typedef {object} Service
 * @property {string} id Stable registry-local identifier, e.g. `svc-1`.
 * @property {string} name Human-readable service name, e.g. `web`.
 * @property {number} port Allocated TCP port.
 * @property {string} url Derived local URL, `http://127.0.0.1:<port>`.
 * @property {string} owner Agent / job / session that owns the lease.
 * @property {number} [pid] Optional OS process id of the dev server.
 * @property {ServiceHealth} health Last observed health; starts as `unknown`.
 * @property {number} ttlMs Lease duration in milliseconds.
 * @property {number} expiresAt Absolute expiry timestamp (`createdAt + ttlMs`).
 * @property {number} createdAt Registration timestamp.
 */

/**
 * @typedef {object} RegisterInput
 * @property {string} name
 * @property {number} [port] Explicit port. Omitted means "allocate from pool".
 * @property {string} owner
 * @property {number} [ttlMs] Defaults to {@link DEFAULT_TTL_MS}.
 * @property {number} [pid]
 */

/**
 * @typedef {object} ListFilter
 * @property {string} [owner]
 */

/**
 * @typedef {(service: Service) => unknown | Promise<unknown>} HealthProbe
 */

/**
 * @typedef {object} Registry
 * @property {(input: RegisterInput) => Service} register
 * @property {(id: string) => boolean} release
 * @property {(filter?: ListFilter) => Service[]} list
 * @property {() => Service[]} reclaimExpired
 * @property {(id: string) => Service | null} status
 * @property {(id: string, probe: HealthProbe) => Promise<Service | null>} checkHealth
 */

/** Default lease duration: 30 minutes. */
export const DEFAULT_TTL_MS = 30 * 60 * 1000

/** Default local development port pool: 4100-4199 inclusive. */
export const DEFAULT_PORT_RANGE = Object.freeze({ start: 4100, end: 4199 })

/** Health values understood by the registry. */
export const HEALTH = Object.freeze({
  UNKNOWN: 'unknown',
  OK: 'ok',
  DOWN: 'down',
})

const LOOPBACK_HOST = '127.0.0.1'
const MIN_PORT = 1
const MAX_PORT = 65535

/**
 * Error raised by registry operations. `code` is stable and safe to match on.
 */
export class RegistryError extends Error {
  /**
   * @param {string} code Stable machine-readable error code.
   * @param {string} message Human-readable message.
   */
  constructor(code, message) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
  }
}

/**
 * @param {number} port
 * @returns {boolean}
 */
function isPort(port) {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RegistryError('INVALID_ARGUMENT', `${field} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function requirePort(value) {
  if (!isPort(/** @type {number} */ (value))) {
    throw new RegistryError('INVALID_PORT', 'port must be an integer between 1 and 65535')
  }
  return /** @type {number} */ (value)
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function requireTtl(value) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) <= 0) {
    throw new RegistryError('INVALID_TTL', 'ttlMs must be a positive integer')
  }
  return /** @type {number} */ (value)
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function requirePid(value) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) <= 0) {
    throw new RegistryError('INVALID_PID', 'pid must be a positive integer')
  }
  return /** @type {number} */ (value)
}

/**
 * @param {unknown} value
 * @returns {{ start: number, end: number }}
 */
function requirePortRange(value) {
  const candidate = /** @type {{ start?: unknown, end?: unknown }} */ (
    value === undefined || value === null ? DEFAULT_PORT_RANGE : value
  )
  const start = candidate.start ?? DEFAULT_PORT_RANGE.start
  const end = candidate.end ?? DEFAULT_PORT_RANGE.end
  if (!isPort(/** @type {number} */ (start)) || !isPort(/** @type {number} */ (end)) || start > end) {
    throw new RegistryError(
      'INVALID_PORT_RANGE',
      'portRange must satisfy 1 <= start <= end <= 65535',
    )
  }
  return { start: /** @type {number} */ (start), end: /** @type {number} */ (end) }
}

/**
 * @param {Service} service
 * @returns {Service}
 */
function snapshot(service) {
  return { ...service }
}

/**
 * Interpret the value returned by an injected health probe.
 *
 * Supported shapes: booleans; numbers in the HTTP 2xx/3xx range; the strings
 * `ok`, `up`, `healthy`, `pass`, `passing`; objects with an `ok` / `healthy`
 * boolean or a `status` string. Everything else, including `null`, counts as
 * down.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function probeSucceeded(value) {
  if (value === true) return true
  if (value === false || value === undefined || value === null) return false
  if (typeof value === 'number') return value >= 200 && value < 400
  if (typeof value === 'string') {
    return ['ok', 'up', 'healthy', 'pass', 'passing'].includes(value.toLowerCase())
  }
  if (typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value)
    if (typeof record.ok === 'boolean') return record.ok
    if (typeof record.healthy === 'boolean') return record.healthy
    if (typeof record.status === 'string') {
      return ['ok', 'up', 'healthy'].includes(record.status.toLowerCase())
    }
  }
  return false
}

/**
 * Create an in-memory registry of local dev-server leases.
 *
 * All state is process-local and intentionally non-persistent. Ports are only
 * bookkeeping: the registry does not bind, inspect or proxy them.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] Injectable clock in epoch milliseconds.
 * @param {{ start?: number, end?: number }} [options.portRange] Allocatable port pool.
 * @returns {Registry}
 */
export function createRegistry(options = {}) {
  const now = options.now ?? Date.now
  if (typeof now !== 'function') {
    throw new RegistryError('INVALID_ARGUMENT', 'now must be a function returning epoch milliseconds')
  }
  const { start, end } = requirePortRange(options.portRange)

  /** @type {Map<string, Service>} */
  const services = new Map()
  let nextId = 0

  /**
   * Remove every lease whose `expiresAt` is at or before `timestamp`.
   *
   * @param {number} timestamp
   * @returns {Service[]}
   */
  function reclaimAt(timestamp) {
    /** @type {Service[]} */
    const reclaimed = []
    for (const [id, service] of services) {
      if (timestamp >= service.expiresAt) {
        services.delete(id)
        reclaimed.push(snapshot(service))
      }
    }
    return reclaimed
  }

  /**
   * @param {number} port
   * @returns {Service | undefined}
   */
  function findByPort(port) {
    for (const service of services.values()) {
      if (service.port === port) return service
    }
    return undefined
  }

  /**
   * @returns {number}
   */
  function allocatePort() {
    for (let port = start; port <= end; port += 1) {
      if (!findByPort(port)) return port
    }
    throw new RegistryError(
      'PORT_RANGE_EXHAUSTED',
      `no free port in range ${start}-${end}`,
    )
  }

  /**
   * @param {RegisterInput} input
   * @returns {Service}
   */
  function register(input) {
    if (input === null || typeof input !== 'object') {
      throw new RegistryError('INVALID_ARGUMENT', 'register expects an object')
    }
    const name = requireNonEmptyString(input.name, 'name')
    const owner = requireNonEmptyString(input.owner, 'owner')
    const ttlMs = input.ttlMs === undefined ? DEFAULT_TTL_MS : requireTtl(input.ttlMs)
    const requestedPort = input.port === undefined ? undefined : requirePort(input.port)
    const pid = input.pid === undefined ? undefined : requirePid(input.pid)

    const timestamp = now()
    if (!Number.isFinite(timestamp)) {
      throw new RegistryError('INVALID_CLOCK', 'now() must return a finite timestamp')
    }

    // Expired leases release their ports before allocation or conflict checks.
    reclaimAt(timestamp)

    let port
    if (requestedPort === undefined) {
      port = allocatePort()
    } else {
      const existing = findByPort(requestedPort)
      if (existing !== undefined) {
        throw new RegistryError(
          'PORT_IN_USE',
          `port ${requestedPort} is already in use by service ${existing.id}`,
        )
      }
      port = requestedPort
    }

    nextId += 1
    /** @type {Service} */
    const service = {
      id: `svc-${nextId}`,
      name,
      port,
      url: `http://${LOOPBACK_HOST}:${port}`,
      owner,
      ...(pid === undefined ? {} : { pid }),
      health: HEALTH.UNKNOWN,
      ttlMs,
      expiresAt: timestamp + ttlMs,
      createdAt: timestamp,
    }
    services.set(service.id, service)
    return snapshot(service)
  }

  /**
   * Release a lease by id. Unknown, already released and expired ids are
   * no-ops: this function is idempotent and never throws for a bad lookup.
   *
   * @param {string} id
   * @returns {boolean} Whether an active lease was removed.
   */
  function release(id) {
    if (typeof id !== 'string' || id === '') return false
    reclaimAt(now())
    return services.delete(id)
  }

  /**
   * List active leases, sweeping expired ones first. Sorted by port so the
   * output is stable and humans can scan it.
   *
   * @param {ListFilter} [filter]
   * @returns {Service[]}
   */
  function list(filter = {}) {
    if (filter === null || typeof filter !== 'object') {
      throw new RegistryError('INVALID_ARGUMENT', 'list expects an object')
    }
    const owner = filter.owner === undefined
      ? undefined
      : requireNonEmptyString(filter.owner, 'owner')

    reclaimAt(now())

    /** @type {Service[]} */
    const out = []
    for (const service of services.values()) {
      if (owner === undefined || service.owner === owner) out.push(snapshot(service))
    }
    return out.sort((a, b) => a.port - b.port || a.createdAt - b.createdAt)
  }

  /**
   * Sweep expired leases and return the removed records.
   *
   * @returns {Service[]}
   */
  function reclaimExpired() {
    return reclaimAt(now())
  }

  /**
   * Read one lease without sweeping. Returns a copy, or `null` when unknown or
   * already released. Expired-but-unswept leases are still visible here; call
   * {@link Registry.reclaimExpired} or {@link Registry.list} to collect them.
   *
   * @param {string} id
   * @returns {Service | null}
   */
  function status(id) {
    if (typeof id !== 'string') return null
    const service = services.get(id)
    return service === undefined ? null : snapshot(service)
  }

  /**
   * Run an injected probe for one lease and record the result.
   *
   * The registry never issues network requests itself. A throwing or rejecting
   * probe marks the service `down`; a missing lease returns `null`. If the
   * lease is released while the probe is in flight, the result is discarded.
   *
   * @param {string} id
   * @param {HealthProbe} probe
   * @returns {Promise<Service | null>}
   */
  async function checkHealth(id, probe) {
    if (typeof probe !== 'function') {
      throw new RegistryError('INVALID_ARGUMENT', 'probe must be a function')
    }
    const current = services.get(id)
    if (current === undefined) return null

    let result
    try {
      result = await probe(snapshot(current))
    } catch {
      result = false
    }

    const stored = services.get(id)
    if (stored === undefined || stored !== current) return null
    stored.health = probeSucceeded(result) ? HEALTH.OK : HEALTH.DOWN
    return snapshot(stored)
  }

  return Object.freeze({ register, release, list, reclaimExpired, status, checkHealth })
}
