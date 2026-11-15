import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRACEPARENT_DEFAULT_FLAGS,
  TRACEPARENT_VERSION,
  formatTraceparent,
  fromTraceparent,
  parseTraceparent,
  toTraceparent,
} from '../src/w3c.js'

const TRACE_ID = 'a'.repeat(32)
const SPAN_ID = 'b'.repeat(16)
const HEADER = `00-${TRACE_ID}-${SPAN_ID}-01`

/**
 * @param {string} flags
 * @param {string} [traceId]
 * @param {string} [spanId]
 * @returns {string}
 */
function header(flags, traceId = TRACE_ID, spanId = SPAN_ID) {
  return `00-${traceId}-${spanId}-${flags}`
}

test('formatTraceparent emits the version-00 layout and honors flags', () => {
  assert.equal(TRACEPARENT_VERSION, '00')
  assert.equal(TRACEPARENT_DEFAULT_FLAGS, 1)
  assert.equal(formatTraceparent({ traceId: TRACE_ID, spanId: SPAN_ID }), HEADER)
  assert.equal(formatTraceparent({ traceId: TRACE_ID, spanId: SPAN_ID, flags: 0 }), header('00'))
  assert.equal(formatTraceparent({ traceId: TRACE_ID, spanId: SPAN_ID, flags: 3 }), header('03'))
  assert.equal(formatTraceparent({ traceId: TRACE_ID, spanId: SPAN_ID, flags: 255 }), header('ff'))

  for (const input of [
    null,
    {},
    { traceId: '0'.repeat(32), spanId: SPAN_ID },
    { traceId: TRACE_ID, spanId: '0'.repeat(16) },
    { traceId: 'a'.repeat(31), spanId: SPAN_ID },
    { traceId: 'A'.repeat(32), spanId: SPAN_ID },
    { traceId: TRACE_ID, spanId: 'b'.repeat(15) },
    { traceId: TRACE_ID, spanId: SPAN_ID, flags: -1 },
    { traceId: TRACE_ID, spanId: SPAN_ID, flags: 256 },
    { traceId: TRACE_ID, spanId: SPAN_ID, flags: 1.5 },
    { traceId: TRACE_ID, spanId: SPAN_ID, flags: '01' },
  ]) {
    assert.throws(
      () => formatTraceparent(input),
      (error) => error.code === 'INVALID_TRACEPARENT',
      JSON.stringify(input),
    )
  }
})

test('parseTraceparent accepts valid headers and reports flags both ways', () => {
  assert.deepEqual(parseTraceparent(HEADER), {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    flags: 1,
    traceFlags: 1,
  })
  assert.equal(parseTraceparent(header('00')).flags, 0)
  assert.equal(parseTraceparent(header('03')).traceFlags, 3)
  assert.equal(parseTraceparent(header('ff')).flags, 255)
  assert.deepEqual(parseTraceparent(`  ${HEADER}\r\n`), parseTraceparent(HEADER))

  for (const flags of ['00', '01', '03', 'ff']) {
    const value = header(flags)
    assert.equal(formatTraceparent(parseTraceparent(value)), value)
  }
})

test('parseTraceparent accepts future versions with mandatory fields', () => {
  assert.deepEqual(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01`), {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    flags: 1,
    traceFlags: 1,
  })
  assert.equal(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-00-ff`).flags, 0)
  assert.equal(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-nothex`), null)
  assert.equal(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-`), null)
})

test('parseTraceparent rejects malformed, wrong-version and all-zero headers', () => {
  const invalid = [
    null,
    42,
    {},
    '',
    '   ',
    'not-a-traceparent',
    `00-${TRACE_ID}-${SPAN_ID}`,
    `00-${TRACE_ID}-${SPAN_ID}-`,
    `00-${'a'.repeat(31)}-${SPAN_ID}-01`,
    `00-${'a'.repeat(33)}-${SPAN_ID}-01`,
    `00-${TRACE_ID}-${'b'.repeat(15)}-01`,
    `00-${TRACE_ID}-${'b'.repeat(17)}-01`,
    `00-${'0'.repeat(32)}-${SPAN_ID}-01`,
    `00-${TRACE_ID}-${'0'.repeat(16)}-01`,
    `ff-${TRACE_ID}-${SPAN_ID}-01`,
    `0g-${TRACE_ID}-${SPAN_ID}-01`,
    `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`,
    `00-${TRACE_ID}-${SPAN_ID.toUpperCase()}-01`,
    `00-${TRACE_ID}-${SPAN_ID}-0`,
    `00-${TRACE_ID}-${SPAN_ID}-001`,
    `00-${TRACE_ID}-${SPAN_ID}-0g`,
    `00-${TRACE_ID}-${SPAN_ID}-01-extra`,
    `00-${TRACE_ID}-${SPAN_ID}-01-`,
    `0x-${TRACE_ID}-${SPAN_ID}-01`,
  ]
  for (const value of invalid) {
    assert.equal(parseTraceparent(value), null, JSON.stringify(value))
  }
})

test('toTraceparent formats OTLP spans and recorded traceparent attributes', () => {
  assert.equal(toTraceparent({ traceId: TRACE_ID, spanId: SPAN_ID }), HEADER)
  assert.equal(
    toTraceparent({ traceId: TRACE_ID, spanId: SPAN_ID, flags: 0 }),
    header('00'),
  )
  assert.equal(toTraceparent({ attrs: { traceparent: HEADER } }), HEADER)
  assert.equal(toTraceparent({ traceparent: HEADER }), HEADER)
  // Unencodable explicit ids fall back to a valid recorded header.
  assert.equal(
    toTraceparent({ traceparent: HEADER, traceId: 'A'.repeat(32), spanId: SPAN_ID }),
    HEADER,
  )
  // Explicit ids win over the recorded header, but its flags are kept.
  assert.equal(
    toTraceparent({
      traceparent: header('00'),
      traceId: 'c'.repeat(32),
      spanId: 'd'.repeat(16),
    }),
    `00-${'c'.repeat(32)}-${'d'.repeat(16)}-00`,
  )
  assert.equal(toTraceparent({ id: 'root', sessionId: 'session-1' }), null)
  assert.equal(toTraceparent({ attrs: { traceparent: 'garbage' } }), null)
  assert.equal(
    toTraceparent({ attrs: { traceparent: `00-${'A'.repeat(32)}-${SPAN_ID}-01` } }),
    null,
  )
  assert.equal(toTraceparent(null), null)
})

test('fromTraceparent builds a named span record and round-trips', () => {
  assert.deepEqual(fromTraceparent(HEADER, { name: 'root' }), {
    name: 'root',
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    flags: 1,
    traceFlags: 1,
  })
  assert.equal(fromTraceparent(HEADER).name, 'w3c-span')
  assert.equal(fromTraceparent('bad'), null)
  assert.equal(fromTraceparent(null), null)
  assert.equal(toTraceparent(fromTraceparent(HEADER, { name: 'root' })), HEADER)
  assert.throws(
    () => fromTraceparent(HEADER, { name: '' }),
    (error) => error.code === 'INVALID_TRACEPARENT',
  )
  assert.throws(
    () => fromTraceparent(HEADER, null),
    (error) => error.code === 'INVALID_TRACEPARENT',
  )
})
