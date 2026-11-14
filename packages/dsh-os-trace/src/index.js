import { readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_WHY_DEPTH,
  MAX_WHY_DEPTH,
  SPAN_KINDS,
  SPAN_STATUSES,
  TraceError,
  createTraceStore,
  verifyBundle,
} from './core.js'

export const name = 'dsh-os-trace'
export const inject = ['tools']

/**
 * @typedef {object} TracePluginConfig
 * @property {string} [dataFile] Read-only JSONL file loaded once when the plugin starts.
 * @property {object[]} [spans] Programmatic seed spans, mainly for embedding and tests.
 * @property {() => number} [now] Clock override used for `exportedAt`.
 */

const spanSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Stable event id, unique in the store' },
    parentId: { type: 'string', description: 'Causal parent event id' },
    sessionId: { type: 'string', required: true, description: 'Originating DSH session id' },
    agentPath: { type: 'string', description: 'Agent path, for example lead/researcher' },
    kind: {
      type: 'string',
      required: true,
      enum: SPAN_KINDS,
      description: 'Event category',
    },
    name: { type: 'string', required: true, description: 'Operation name' },
    startMs: { type: 'number', required: true, description: 'Start time in epoch milliseconds' },
    endMs: { type: 'number', description: 'End time in epoch milliseconds' },
    status: {
      type: 'string',
      required: true,
      enum: SPAN_STATUSES,
      description: 'Lifecycle state',
    },
    attrs: { type: 'object', additionalProperties: true, description: 'JSON attributes' },
    hash: { type: 'string', required: true, description: 'SHA-256 chain hash' },
    prevHash: {
      type: 'string',
      required: true,
      description: 'Previous span hash, or the genesis hash',
    },
  },
}

const edgeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    parentId: { type: 'string', required: true, description: 'Parent span id' },
    childId: { type: 'string', required: true, description: 'Child span id' },
  },
}

const badSpanSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    index: { type: 'integer', required: true, description: 'Zero-based span index, -1 for bundle-level' },
    id: {
      oneOf: [{ type: 'null' }, { type: 'string' }],
      required: true,
      description: 'Span id when readable',
    },
    reason: { type: 'string', required: true, description: 'Why verification failed' },
  },
}

const queryOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    count: { type: 'integer', required: true, description: 'Number of returned spans' },
    spans: { type: 'array', required: true, items: spanSchema, description: 'Matching spans' },
  },
}

const whyOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    eventId: { type: 'string', required: true },
    found: { type: 'boolean', required: true, description: 'Whether the target span exists' },
    target: {
      oneOf: [{ type: 'null' }, spanSchema],
      required: true,
      description: 'Target span, or null when missing',
    },
    depth: { type: 'integer', required: true, description: 'Hop limit used by this call' },
    spans: {
      type: 'array',
      required: true,
      items: spanSchema,
      description: 'Chronological causal path including the target',
    },
    edges: {
      type: 'array',
      required: true,
      items: edgeSchema,
      description: 'Parent-to-child links inside the path',
    },
    missing: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'Referenced ids that could not be resolved',
    },
    truncated: {
      type: 'boolean',
      required: true,
      description: 'Whether the depth limit stopped a longer chain',
    },
  },
}

const bundleOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    format: { type: 'string', required: true },
    version: { type: 'integer', required: true },
    hashAlgo: { type: 'string', required: true },
    exportedAt: { type: 'number', required: true },
    spanCount: { type: 'integer', required: true },
    rootHash: { type: 'string', required: true },
    sourceRootHash: { type: 'string', required: true },
    genesisPrevHash: { type: 'string', required: true },
    redaction: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        fields: { type: 'array', required: true, items: { type: 'string' } },
        applied: { type: 'boolean', required: true },
      },
    },
    spans: { type: 'array', required: true, items: spanSchema },
  },
}

const verifyOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: 'Whether the whole chain verifies' },
    count: { type: 'integer', required: true, description: 'Number of spans in the bundle' },
    checked: {
      type: 'integer',
      required: true,
      description: 'Spans fully verified before the first failure',
    },
    rootHash: {
      oneOf: [{ type: 'null' }, { type: 'string' }],
      required: true,
      description: 'Computed final hash on success; null on failure',
    },
    firstBad: {
      oneOf: [{ type: 'null' }, badSpanSchema],
      required: true,
      description: 'First failing span, or null when ok',
    },
  },
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Load one read-only JSONL file into the store. Blank lines are ignored.
 *
 * @param {ReturnType<typeof createTraceStore>} store
 * @param {string} dataFile
 */
function loadJsonl(store, dataFile) {
  let text
  try {
    text = readFileSync(dataFile, 'utf8')
  } catch (error) {
    throw new TraceError('INVALID_DATA_FILE', `cannot read dataFile "${dataFile}": ${messageOf(error)}`)
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line.length === 0) continue
    let span
    try {
      span = JSON.parse(line)
    } catch (error) {
      throw new TraceError(
        'INVALID_DATA_FILE',
        `dataFile "${dataFile}" line ${index + 1} is not valid JSON: ${messageOf(error)}`,
      )
    }
    try {
      store.ingest(span)
    } catch (error) {
      throw new TraceError(
        'INVALID_DATA_FILE',
        `dataFile "${dataFile}" line ${index + 1}: ${messageOf(error)}`,
      )
    }
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {TracePluginConfig} [config]
 */
export function apply(ctx, config = {}) {
  if (config === undefined || config === null) config = {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new TraceError('INVALID_OPTIONS', 'dsh-os-trace config must be an object')
  }

  const store = createTraceStore(config.now === undefined ? {} : { now: config.now })

  if (config.spans !== undefined) {
    if (!Array.isArray(config.spans)) {
      throw new TraceError('INVALID_OPTIONS', 'dsh-os-trace config.spans must be an array')
    }
    for (const [index, span] of config.spans.entries()) {
      try {
        store.ingest(span)
      } catch (error) {
        throw new TraceError(
          'INVALID_OPTIONS',
          `dsh-os-trace config.spans[${index}]: ${messageOf(error)}`,
        )
      }
    }
  }

  if (config.dataFile !== undefined) {
    if (typeof config.dataFile !== 'string' || config.dataFile.length === 0) {
      throw new TraceError('INVALID_OPTIONS', 'dsh-os-trace config.dataFile must be a non-empty string')
    }
    loadJsonl(store, config.dataFile)
  }

  ctx.tools.register(
    defineTool({
      name: 'trace_query',
      description:
        'Query spans already ingested into this plugin\'s in-memory trace store. Filters by id, session, parent, agent path, kind, status, name and start-time range; results are sorted by start time. Read-only; it does not fetch or invent data.',
      parameters: {
        id: { type: 'string', description: 'Exact span id' },
        sessionId: { type: 'string', description: 'Exact DSH session id' },
        parentId: { type: 'string', description: 'Exact causal parent id' },
        agentPath: { type: 'string', description: 'Exact agent path' },
        kind: { type: 'string', enum: SPAN_KINDS, description: 'Only one event kind' },
        status: { type: 'string', enum: SPAN_STATUSES, description: 'Only one lifecycle status' },
        name: { type: 'string', description: 'Exact operation name' },
        since: { type: 'number', description: 'Keep spans with startMs greater than or equal to this' },
        until: { type: 'number', description: 'Keep spans with startMs less than or equal to this' },
        limit: { type: 'integer', description: 'Maximum results after sorting' },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Start-time order, default asc',
        },
      },
      output: {
        schema: queryOutputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const filter = {}
        for (const [key, value] of Object.entries(args)) {
          if (value !== undefined) filter[key] = value
        }
        const spans = store.query(filter)
        return { count: spans.length, spans }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'trace_why',
      description:
        'Explain the causal chain around one span: walk parentId ancestors and descendants up to depth hops. Returns spans, parent-to-child edges, unresolved parent ids in missing, and whether the depth limit truncated a longer chain. Read-only and bounded.',
      parameters: {
        eventId: { type: 'string', required: true, description: 'Span id to explain' },
        depth: {
          type: 'integer',
          description: `Hops to walk in each direction (default ${DEFAULT_WHY_DEPTH}, max ${MAX_WHY_DEPTH})`,
        },
      },
      output: {
        schema: whyOutputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        return store.why(args.eventId, args.depth ?? DEFAULT_WHY_DEPTH)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'trace_export',
      description:
        'Export the in-memory trace store as a SHA-256 hash-chain evidence bundle. An unredacted export preserves the store hashes; a redacted export recursively replaces matching object keys with "[redacted]" and re-seals the chain, so its hashes attest the redacted bundle rather than the original bytes.',
      parameters: {
        redact: {
          type: 'array',
          items: { type: 'string' },
          description: 'Object keys to replace recursively, case-insensitive, for example ["apiKey","token"]',
        },
      },
      output: {
        schema: bundleOutputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        return store.exportBundle(args.redact === undefined ? {} : { redact: args.redact })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'trace_verify',
      description:
        'Verify a dsh-os-trace evidence bundle\'s SHA-256 hash chain and root hash. Accepts the bundle object or its JSON text. Detects edits, reordering or partial truncation that break the chain/root hash and returns firstBad for the first failure. It cannot detect a full re-hash by an attacker and does not authenticate against an external anchor.',
      parameters: {
        bundle: {
          oneOf: [
            { type: 'object', additionalProperties: true, description: 'Bundle object from trace_export' },
            { type: 'string', description: 'Serialized bundle JSON' },
          ],
          required: true,
          description: 'Bundle to verify',
        },
      },
      output: {
        schema: verifyOutputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        let bundle = args.bundle
        if (typeof bundle === 'string') {
          try {
            bundle = JSON.parse(bundle)
          } catch (error) {
            return {
              ok: false,
              count: 0,
              checked: 0,
              rootHash: null,
              firstBad: {
                index: -1,
                id: null,
                reason: `bundle is not valid JSON: ${messageOf(error)}`,
              },
            }
          }
        }
        return verifyBundle(bundle)
      },
    }),
  )
}
