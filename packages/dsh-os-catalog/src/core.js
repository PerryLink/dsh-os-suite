/**
 * Pure capability-catalog logic for dsh-os-catalog.
 *
 * This module has no `@deepseek-ai/*` imports: it can be exercised offline with
 * `node --test`. The Cordis entry point in `index.js` is only a thin adapter
 * that registers three tools and forwards their arguments here.
 *
 * @module dsh-os-catalog/core
 */

/**
 * @typedef {'tool' | 'plugin' | 'mcp' | 'skill' | 'command'} CapabilityKind
 * @typedef {'free' | 'cheap' | 'expensive'} CapabilityCost
 * @typedef {'ok' | 'degraded' | 'down'} CapabilityHealth
 */

/**
 * A capability manifest. It describes what a capability is for; it does not
 * execute or grant anything.
 *
 * @typedef {object} Capability
 * @property {string} id Stable unique id, e.g. `"pdf.convert"`.
 * @property {string} name Human-readable name.
 * @property {CapabilityKind} kind Registry family the capability belongs to.
 * @property {string[]} intents Short natural-language intents it serves.
 * @property {string[]} inputs Accepted input names or types.
 * @property {string[]} outputs Produced output names or types.
 * @property {string[]} permissions Permission ids required to run it.
 * @property {CapabilityCost} cost Declared cost tier.
 * @property {CapabilityHealth} health Declared health.
 * @property {object} [meta] Free-form JSON metadata; never interpreted here.
 */

/**
 * @typedef {object} SearchOptions
 * @property {CapabilityKind | CapabilityKind[]} [kind] Kind or kinds to keep.
 * @property {CapabilityCost} [maxCost] Highest cost tier to keep.
 * @property {string[]} [requirePermissions] Permissions the caller can grant;
 *   only capabilities whose permissions are fully covered are kept.
 * @property {CapabilityHealth} [health] Exact health filter.
 * @property {boolean} [includeDown] Include `down` capabilities (default false).
 * @property {number} [limit] Maximum hits, 1-100 (default 20).
 */

/**
 * @typedef {object} SearchHit
 * @property {Capability} cap Frozen capability manifest.
 * @property {number} score Deterministic relevance score.
 * @property {string[]} why Human-readable match reasons.
 */

/**
 * @typedef {object} Suggestion
 * @property {string} id
 * @property {string} name
 * @property {CapabilityKind} kind
 * @property {string[]} intents
 */

/**
 * @typedef {object} SearchResult
 * @property {SearchHit[]} items Ranked hits, truncated by `limit`.
 * @property {number} total Matched hits before truncation.
 * @property {Suggestion[]} suggestions Browse suggestions when nothing matched.
 */

/**
 * @typedef {object} PreflightBlocker
 * @property {string} code Machine-readable reason.
 * @property {string} message Human-readable reason.
 * @property {string} [permission]
 * @property {CapabilityCost} [cost]
 * @property {CapabilityCost} [maxCost]
 * @property {CapabilityHealth} [health]
 */

/**
 * @typedef {object} PreflightResult
 * @property {boolean} ok True when `blockers` is empty.
 * @property {PreflightBlocker[]} blockers Reasons the capability cannot run now.
 * @property {PreflightBlocker[]} warnings Non-blocking risks.
 * @property {string} id
 * @property {string | null} name
 * @property {CapabilityHealth | null} health
 * @property {CapabilityCost | null} cost
 * @property {string[]} requiredPermissions
 * @property {string[]} missingPermissions
 * @property {string[]} grantedPermissions
 */

/**
 * @typedef {object} Catalog
 * @property {(cap: Capability | object) => Capability} register
 * @property {(id: string) => boolean} remove
 * @property {(id: string) => Capability | undefined} get
 * @property {(intent: string, options?: SearchOptions) => SearchResult} search
 * @property {(id: string, options?: { grantedPermissions?: string[], maxCost?: CapabilityCost }) => PreflightResult} preflight
 * @property {() => Capability[]} list
 */

/** @type {ReadonlyArray<CapabilityKind>} */
export const KINDS = Object.freeze(['tool', 'plugin', 'mcp', 'skill', 'command'])
/** @type {ReadonlyArray<CapabilityCost>} */
export const COSTS = Object.freeze(['free', 'cheap', 'expensive'])
/** @type {ReadonlyArray<CapabilityHealth>} */
export const HEALTHS = Object.freeze(['ok', 'degraded', 'down'])

/** @type {Record<CapabilityCost, number>} */
const COST_RANK = Object.freeze({ free: 0, cheap: 1, expensive: 2 })
/** @type {Record<CapabilityHealth, number>} */
const HEALTH_RANK = Object.freeze({ ok: 0, degraded: 1, down: 2 })

/** Field weights keep intent matches ahead of name and input matches. */
const FIELD_WEIGHTS = Object.freeze({ intents: 6, name: 3, inputs: 1 })

const TIER_LABELS = Object.freeze({ 1: 'contains', 2: 'prefix', 3: 'exact' })

/** Full-query phrase bonuses, applied on top of per-token matches. */
const PHRASE_BONUS = Object.freeze({
  intents: Object.freeze({ 3: 40, 2: 18, 1: 8 }),
  name: Object.freeze({ 3: 20, 2: 8, 1: 3 }),
})

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const MAX_SUGGESTIONS = 5

/** Error raised for catalog usage errors that callers should handle. */
export class CatalogError extends Error {
  /**
   * @param {'DUPLICATE_ID'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'CatalogError'
    this.code = code
  }
}

/** @param {unknown} value */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{ required?: boolean, fallback?: string }} [options]
 * @returns {string | undefined}
 */
function readString(value, field, options = {}) {
  const { required = false, fallback } = options
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`${field} is required`)
    return fallback
  }
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed && required) throw new TypeError(`${field} must not be empty`)
  return trimmed || fallback
}

/**
 * Read a string array, trimming entries and dropping exact duplicates.
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]}
 */
function readStringList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of strings`)
  /** @type {string[]} */
  const out = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new TypeError(`${field} must contain non-empty strings`)
    }
    const normalized = entry.trim().replace(/\s+/g, ' ')
    if (!seen.has(normalized)) {
      seen.add(normalized)
      out.push(normalized)
    }
  }
  return out
}

/**
 * @template {string} T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @param {string} field
 * @param {T} fallback
 * @returns {T}
 */
function readEnum(value, allowed, field, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !allowed.includes(/** @type {T} */ (value))) {
    throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`)
  }
  return /** @type {T} */ (value)
}

/**
 * Deep-copy a lossless JSON value so later caller mutation cannot change the
 * catalog and the value can be frozen safely.
 * @param {unknown} value
 * @param {string} path
 * @returns {any}
 */
function cloneJson(value, path) {
  if (value === null) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`)
      return value
    case 'object': {
      if (Array.isArray(value)) {
        return value.map((entry, index) => cloneJson(entry, `${path}[${index}]`))
      }
      if (!isPlainObject(value)) throw new TypeError(`${path} must be a plain JSON value`)
      /** @type {Record<string, unknown>} */
      const out = {}
      for (const [key, entry] of Object.entries(value)) {
        out[key] = cloneJson(entry, `${path}.${key}`)
      }
      return out
    }
    default:
      throw new TypeError(`${path} must be JSON-serializable`)
  }
}

/** @param {any} value */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * Validate and freeze one manifest.
 * @param {unknown} input
 * @returns {Capability}
 */
function normalizeCapability(input) {
  if (!isPlainObject(input)) throw new TypeError('capability must be a plain object')
  const id = /** @type {string} */ (readString(input.id, 'capability.id', { required: true }))
  const name = /** @type {string} */ (
    readString(input.name, 'capability.name', { fallback: id })
  )
  const kind = (() => {
    if (input.kind === undefined || input.kind === null) {
      throw new TypeError('capability.kind is required and must be one of: ' + KINDS.join(', '))
    }
    return readEnum(input.kind, KINDS, 'capability.kind', /** @type {CapabilityKind} */ ('tool'))
  })()

  /** @type {Capability} */
  const cap = {
    id,
    name,
    kind,
    intents: readStringList(input.intents, 'capability.intents'),
    inputs: readStringList(input.inputs, 'capability.inputs'),
    outputs: readStringList(input.outputs, 'capability.outputs'),
    permissions: readStringList(input.permissions, 'capability.permissions'),
    cost: readEnum(input.cost, COSTS, 'capability.cost', 'cheap'),
    health: readEnum(input.health, HEALTHS, 'capability.health', 'ok'),
  }
  if (input.meta !== undefined) {
    cap.meta = cloneJson(input.meta, 'capability.meta')
  }
  return deepFreeze(cap)
}

/**
 * NFKC/lower-case a string and collapse whitespace for comparisons.
 * @param {string} value
 */
function normalizeText(value) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Split on non-letter/non-number boundaries. Unicode property escapes keep CJK
 * phrases intact while still splitting punctuation.
 * @param {string} value
 * @returns {string[]}
 */
function tokenize(value) {
  return normalizeText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/**
 * @param {string} a
 * @param {string} b
 */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Best match for one query token across a list of field entries.
 * @param {string[]} entries
 * @param {string} token
 * @returns {{ tier: 0 | 1 | 2 | 3, detail: string }}
 */
function bestTokenMatch(entries, token) {
  /** @type {{ tier: 0 | 1 | 2 | 3, detail: string }} */
  let best = { tier: 0, detail: '' }
  for (const entry of entries) {
    const normalized = normalizeText(entry)
    if (!normalized) continue
    const entryTokens = tokenize(entry)
    /** @type {0 | 1 | 2 | 3} */
    let tier = 0
    if (entryTokens.includes(token)) {
      tier = 3
    } else if (entryTokens.some((candidate) => candidate.startsWith(token))) {
      tier = 2
    } else if (
      normalized.includes(token) ||
      entryTokens.some((candidate) => token.length > candidate.length && token.startsWith(candidate))
    ) {
      tier = 1
    }
    if (tier > best.tier) best = { tier, detail: entry }
    if (best.tier === 3) return best
  }
  return best
}

/**
 * Best whole-query phrase match across entries. Returns 3 for an exact phrase,
 * 2 for a prefix, and 1 for a contained phrase.
 * @param {string[]} entries
 * @param {string} queryPhrase
 * @returns {{ tier: 0 | 1 | 2 | 3, detail: string }}
 */
function bestPhraseMatch(entries, queryPhrase) {
  /** @type {{ tier: 0 | 1 | 2 | 3, detail: string }} */
  let best = { tier: 0, detail: '' }
  if (!queryPhrase) return best
  for (const entry of entries) {
    const phrase = tokenize(entry).join(' ')
    if (!phrase) continue
    /** @type {0 | 1 | 2 | 3} */
    let tier = 0
    if (phrase === queryPhrase) tier = 3
    else if (phrase.startsWith(queryPhrase)) tier = 2
    else if (phrase.includes(queryPhrase)) tier = 1
    if (tier > best.tier) best = { tier, detail: entry }
    if (best.tier === 3) return best
  }
  return best
}

/**
 * @param {'intent' | 'name' | 'input'} field
 * @param {{ tier: 1 | 2 | 3, detail: string }} match
 * @param {string} token
 */
function tokenWhy(field, match, token) {
  const detail = normalizeText(match.detail) === token ? '' : ` in "${match.detail}"`
  return `${field} ${TIER_LABELS[match.tier]} "${token}"${detail}`
}

/**
 * @param {'intent' | 'name'} field
 * @param {{ tier: 1 | 2 | 3, detail: string }} match
 * @param {string} queryPhrase
 */
function phraseWhy(field, match, queryPhrase) {
  const matchedPhrase = tokenize(match.detail).join(' ')
  const detail = matchedPhrase === queryPhrase ? '' : ` in "${match.detail}"`
  return `phrase ${TIER_LABELS[match.tier]} ${field}: "${queryPhrase}"${detail}`
}

/**
 * Score one capability against query tokens. Returns null when no token
 * matches `intents`, `name`, or `inputs`.
 * @param {Capability} cap
 * @param {string[]} tokens
 * @param {string} queryPhrase
 * @returns {{ score: number, why: string[] } | null}
 */
function scoreCapability(cap, tokens, queryPhrase) {
  let base = 0
  let matchedTokens = 0
  /** @type {string[]} */
  const why = []

  for (const token of tokens) {
    let matched = false

    const intentMatch = bestTokenMatch(cap.intents, token)
    if (intentMatch.tier > 0) {
      base += FIELD_WEIGHTS.intents * intentMatch.tier
      why.push(tokenWhy('intent', intentMatch, token))
      matched = true
    }

    const nameMatch = bestTokenMatch([cap.name], token)
    if (nameMatch.tier > 0) {
      base += FIELD_WEIGHTS.name * nameMatch.tier
      why.push(tokenWhy('name', nameMatch, token))
      matched = true
    }

    const inputMatch = bestTokenMatch(cap.inputs, token)
    if (inputMatch.tier > 0) {
      base += FIELD_WEIGHTS.inputs * inputMatch.tier
      why.push(tokenWhy('input', inputMatch, token))
      matched = true
    }

    if (matched) matchedTokens += 1
  }

  if (matchedTokens === 0) return null

  let bonus = 0
  const intentPhrase = bestPhraseMatch(cap.intents, queryPhrase)
  if (intentPhrase.tier > 0) {
    bonus += PHRASE_BONUS.intents[intentPhrase.tier]
    why.push(phraseWhy('intent', intentPhrase, queryPhrase))
  }
  const namePhrase = bestPhraseMatch([cap.name], queryPhrase)
  if (namePhrase.tier > 0) {
    bonus += PHRASE_BONUS.name[namePhrase.tier]
    why.push(phraseWhy('name', namePhrase, queryPhrase))
  }

  const coverage = matchedTokens / tokens.length
  const score = Math.round((base * (1 + 0.15 * coverage) + bonus) * 1000) / 1000
  return { score, why }
}

/**
 * @param {SearchHit} a
 * @param {SearchHit} b
 */
function compareHits(a, b) {
  return (
    b.score - a.score ||
    HEALTH_RANK[a.cap.health] - HEALTH_RANK[b.cap.health] ||
    COST_RANK[a.cap.cost] - COST_RANK[b.cap.cost] ||
    compareText(a.cap.name, b.cap.name) ||
    compareText(a.cap.id, b.cap.id)
  )
}

/**
 * @param {Capability} a
 * @param {Capability} b
 */
function compareBrowse(a, b) {
  return (
    HEALTH_RANK[a.health] - HEALTH_RANK[b.health] ||
    COST_RANK[a.cost] - COST_RANK[b.cost] ||
    compareText(a.name, b.name) ||
    compareText(a.id, b.id)
  )
}

/**
 * @param {string} required
 * @param {string[]} granted
 */
export function permissionCovered(required, granted) {
  for (const grant of granted) {
    if (grant === '*' || grant === required) return true
    if (grant.endsWith('*')) {
      const prefix = grant.slice(0, -1)
      if (prefix && required.startsWith(prefix)) return true
    }
  }
  return false
}

/**
 * Build a capability catalog. The catalog is an in-memory registry; callers
 * can seed it and may register more capabilities at runtime.
 * @param {Array<Capability | object>} [seed]
 * @returns {Catalog}
 */
export function createCatalog(seed = []) {
  if (!Array.isArray(seed)) throw new TypeError('seed must be an array of capabilities')

  /** @type {Map<string, Capability>} */
  const caps = new Map()

  /**
   * @param {Capability | object} input
   * @returns {Capability}
   */
  function register(input) {
    const cap = normalizeCapability(input)
    if (caps.has(cap.id)) {
      throw new CatalogError('DUPLICATE_ID', `capability "${cap.id}" is already registered`)
    }
    caps.set(cap.id, cap)
    return cap
  }

  /**
   * @param {string} id
   */
  function remove(id) {
    const key = readString(id, 'id', { required: true })
    return caps.delete(/** @type {string} */ (key))
  }

  /**
   * @param {string} id
   */
  function get(id) {
    const key = readString(id, 'id', { required: true })
    return caps.get(/** @type {string} */ (key))
  }

  /** @returns {Capability[]} */
  function list() {
    return [...caps.values()]
  }

  /**
   * @param {string} intent
   * @param {SearchOptions} [options]
   * @returns {SearchResult}
   */
  function search(intent, options = {}) {
    if (typeof intent !== 'string') throw new TypeError('intent must be a string')
    if (!isPlainObject(options)) throw new TypeError('search options must be an object')

    const query = intent.trim()
    const queryTokens = tokenize(query)
    const tokens = [...new Set(queryTokens)]
    const queryPhrase = queryTokens.join(' ')

    /** @type {CapabilityKind[] | undefined} */
    let kinds
    if (options.kind !== undefined && options.kind !== null) {
      const rawKinds = Array.isArray(options.kind) ? options.kind : [options.kind]
      kinds = []
      for (const kind of rawKinds) {
        if (!KINDS.includes(kind)) {
          throw new TypeError(`kind must be one of: ${KINDS.join(', ')}`)
        }
        if (!kinds.includes(kind)) kinds.push(kind)
      }
    }

    const maxCost =
      options.maxCost === undefined || options.maxCost === null
        ? undefined
        : readEnum(options.maxCost, COSTS, 'maxCost', /** @type {CapabilityCost} */ ('cheap'))

    const requirePermissions =
      options.requirePermissions === undefined || options.requirePermissions === null
        ? undefined
        : readStringList(options.requirePermissions, 'requirePermissions')

    const health =
      options.health === undefined || options.health === null
        ? undefined
        : readEnum(options.health, HEALTHS, 'health', /** @type {CapabilityHealth} */ ('ok'))

    if (options.includeDown !== undefined && typeof options.includeDown !== 'boolean') {
      throw new TypeError('includeDown must be a boolean')
    }
    const includeDown = options.includeDown === true

    let limit = DEFAULT_LIMIT
    if (options.limit !== undefined && options.limit !== null) {
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new TypeError('limit must be an integer greater than or equal to 1')
      }
      limit = Math.min(options.limit, MAX_LIMIT)
    }

    /** @type {Capability[]} */
    const eligible = []
    for (const cap of caps.values()) {
      if (kinds !== undefined && !kinds.includes(cap.kind)) continue
      if (maxCost !== undefined && COST_RANK[cap.cost] > COST_RANK[maxCost]) continue
      if (
        requirePermissions !== undefined &&
        !cap.permissions.every((permission) => permissionCovered(permission, requirePermissions))
      ) {
        continue
      }
      if (health !== undefined) {
        if (cap.health !== health) continue
      } else if (!includeDown && cap.health === 'down') {
        continue
      }
      eligible.push(cap)
    }

    if (tokens.length === 0) {
      const browse = eligible
        .slice()
        .sort(compareBrowse)
        .map((cap) => ({ cap, score: 0, why: ['browse: empty intent'] }))
      return { items: browse.slice(0, limit), total: browse.length, suggestions: [] }
    }

    /** @type {SearchHit[]} */
    const hits = []
    for (const cap of eligible) {
      const scored = scoreCapability(cap, tokens, queryPhrase)
      if (scored) hits.push({ cap, score: scored.score, why: scored.why })
    }
    hits.sort(compareHits)

    return {
      items: hits.slice(0, limit),
      total: hits.length,
      suggestions: hits.length === 0 ? suggestionsFor(eligible) : [],
    }
  }

  /**
   * @param {Capability[]} eligible
   * @returns {Suggestion[]}
   */
  function suggestionsFor(eligible) {
    return eligible
      .slice()
      .sort(compareBrowse)
      .slice(0, MAX_SUGGESTIONS)
      .map((cap) => ({
        id: cap.id,
        name: cap.name,
        kind: cap.kind,
        intents: [...cap.intents],
      }))
  }

  /**
   * @param {string} id
   * @param {{ grantedPermissions?: string[], maxCost?: CapabilityCost }} [options]
   * @returns {PreflightResult}
   */
  function preflight(id, options = {}) {
    const key = readString(id, 'id', { required: true })
    if (!isPlainObject(options)) throw new TypeError('preflight options must be an object')
    const granted = readStringList(options.grantedPermissions, 'grantedPermissions')
    const maxCost =
      options.maxCost === undefined || options.maxCost === null
        ? undefined
        : readEnum(options.maxCost, COSTS, 'maxCost', /** @type {CapabilityCost} */ ('cheap'))

    const cap = caps.get(/** @type {string} */ (key))
    if (!cap) {
      return {
        ok: false,
        blockers: [
          {
            code: 'unknown-capability',
            message: `capability "${key}" is not registered`,
          },
        ],
        warnings: [],
        id: /** @type {string} */ (key),
        name: null,
        health: null,
        cost: null,
        requiredPermissions: [],
        missingPermissions: [],
        grantedPermissions: granted,
      }
    }

    /** @type {PreflightBlocker[]} */
    const blockers = []
    /** @type {PreflightBlocker[]} */
    const warnings = []

    if (cap.health === 'down') {
      blockers.push({
        code: 'health-down',
        health: 'down',
        message: `capability "${cap.id}" is down`,
      })
    } else if (cap.health === 'degraded') {
      warnings.push({
        code: 'health-degraded',
        health: 'degraded',
        message: `capability "${cap.id}" is degraded; results may be partial`,
      })
    }

    const missingPermissions = cap.permissions.filter(
      (permission) => !permissionCovered(permission, granted),
    )
    for (const permission of missingPermissions) {
      blockers.push({
        code: 'missing-permission',
        permission,
        message: `permission "${permission}" is not granted`,
      })
    }

    if (maxCost !== undefined && COST_RANK[cap.cost] > COST_RANK[maxCost]) {
      blockers.push({
        code: 'cost-exceeds-budget',
        cost: cap.cost,
        maxCost,
        message: `capability costs "${cap.cost}" but the budget allows at most "${maxCost}"`,
      })
    } else if (cap.cost === 'expensive') {
      warnings.push({
        code: 'cost-expensive',
        cost: 'expensive',
        message: `capability "${cap.id}" is marked expensive`,
      })
    }

    return {
      ok: blockers.length === 0,
      blockers,
      warnings,
      id: cap.id,
      name: cap.name,
      health: cap.health,
      cost: cap.cost,
      requiredPermissions: [...cap.permissions],
      missingPermissions,
      grantedPermissions: granted,
    }
  }

  for (const entry of seed) register(entry)

  return Object.freeze({ register, remove, get, search, preflight, list })
}
