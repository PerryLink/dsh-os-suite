/**
 * Detached `SessionLogSnapshot` fixtures for the live-session adapter tests.
 *
 * The shape mirrors what `ctx.sessionQuery.readSession()` returns: a cloned
 * `SessionHeader`, the inherited-event count, and complete raw `SessionEvent`
 * objects. Factories return fresh objects so a test cannot leak mutations.
 */

/**
 * @param {object} session Session header fields.
 * @param {object[]} events Raw session events.
 * @returns {{ session: object, inheritedEventCount: number, events: object[] }} Snapshot.
 */
function snapshotOf(session, events) {
  return {
    session: {
      version: 4,
      createdAt: 0,
      cwd: '/tmp/dsh-os-eval',
      isSeeded: false,
      ...session,
    },
    inheritedEventCount: 0,
    events: events.map((event) => ({ ...event, data: { ...event.data } })),
  }
}

/**
 * @returns {object} Snapshot that parses to one paired `read` call, 27 tokens,
 *   and the final text "Live session passed.".
 */
export function liveSuccessSnapshot() {
  return snapshotOf({ id: 'live-success' }, [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: 1001, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 1002,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Read the README first.' },
            { type: 'tool-call', id: 'call-live', name: 'read', arguments: '{"path":"README.md"}' },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 },
      },
      surfaceOp: 'append',
    },
    {
      type: 'tool/call',
      seq: 4,
      time: 1003,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-live',
        name: 'read',
        arguments: '{"path":"README.md"}',
      },
    },
    {
      type: 'tool/result',
      seq: 5,
      time: 1004,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call-live',
          content: [{ type: 'text', text: '# dsh-os-eval live' }],
          isError: false,
        },
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 6, time: 1005, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 7, time: 1006, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 8, time: 1007, data: { turn: 2 } },
    {
      type: 'assistant/message',
      seq: 9,
      time: 1008,
      data: {
        turn: 2,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Live session passed.' }],
        },
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
      },
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: 10, time: 1009, data: { turn: 2, reason: { kind: 'completed' } } },
  ])
}

/**
 * @returns {object} Snapshot with one failed `read` call, 999 tokens, and the
 *   final text "Live session failed.".
 */
export function liveFailureSnapshot() {
  return snapshotOf({ id: 'live-failure' }, [
    { type: 'turn/start', seq: 1, time: 2000, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: 2001, data: { turn: 1, step: 1 } },
    {
      type: 'tool/call',
      seq: 3,
      time: 2002,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-live-fail',
        name: 'read',
        arguments: '{"path":"missing.txt"}',
      },
    },
    {
      type: 'tool/result',
      seq: 4,
      time: 2003,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call-live-fail',
          content: [{ type: 'text', text: 'ENOENT: no such file or directory' }],
          isError: true,
        },
      },
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: 5, time: 2004, data: { turn: 1, reason: { kind: 'error' } } },
    { type: 'turn/start', seq: 6, time: 2005, data: { turn: 2 } },
    {
      type: 'assistant/message',
      seq: 7,
      time: 2006,
      data: {
        turn: 2,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Live session failed.' }],
        },
        usage: { inputTokens: 900, outputTokens: 99 },
      },
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: 8, time: 2007, data: { turn: 2, reason: { kind: 'completed' } } },
  ])
}
