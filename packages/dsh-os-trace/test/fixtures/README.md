# Real-run fixtures

`real-run-redacted.jsonl` holds 637 spans from three recorded DSH sessions: two
top-level runs and the session started by the subagent one of them launched. It covers
shapes hand-written fixtures miss: a turn that ended in error, turns/steps/tool calls
that never received their end event, steps holding several sibling tool calls, jobs
nested under the tool call that started them, and a subagent span bridging into the
child session.

## Provenance

- Source: three DSH sessions recorded by the contributor on one machine; no third-party
  data is included (`workspace-write`, approval policy `ask`).
- 3 sessions; 228 `workflow` (turn/step), 199 `tool`, 26 `mcp`, 180 `job`, 1 `subagent`
  spans; statuses 629 `ok`, 1 `error`, 7 `running`.
- Ingest order is start-time order.
- `../real-run.test.js` pins the recorded shape (counts, parent kinds, graph fingerprint),
  so rewiring or trimming the fixture fails the suite instead of silently passing.
- A background job can outlive the tool call that spawned it; one job ends 3s after its
  parent tool span.
- Two sessions are snapshots of runs that were still going when captured: their session
  span is `running` and has no `endMs`. The first session in the file ended and keeps its
  `endMs`; it also contains the `error` turn.

## How this file was produced

- The three source session logs were captured in one snapshot. Both parent sessions are
  included up to that snapshot; the child session is cut at its first `step/end` after the
  180th event, so the cut point does not depend on wall-clock time.
- A session whose descendants were still running at the cut is marked `running` and has no
  `endMs`; a session with no unfinished descendant keeps its `endMs`.
- No earlier version of this file was published. Drafts taken while the source sessions
  were still growing were discarded, and the final file was generated once from the frozen
  snapshot with the cut rules above. That is why span counts differ from those drafts; the
  graph-building and redaction rules did not change; the frozen cut changes which spans
  are included.

## Wiring

The fixture keeps the shape the host actually produced: `session → turn → step → tool|mcp`,
then `job` under its tool call, and `subagent → child session`. DESIGN §4 suggests the
coarser `tool` parent of `turn`/`subagent` and MCP names of `server/tool`; the recorded
events are one level deeper (`step`) and name MCP tools `mcp__server__tool`, so this file
documents the host shape rather than the suggested shape.

## Redaction

Kept: `id`, `parentId`, `sessionId`, `kind`, `name` (tool name only), `startMs`, `endMs`,
`status`, and the causal graph.

Removed or replaced:

- session and call ids are `sha256(salt + value)[0:12]`; turn/step ids are scoped by the
  hashed session id. No span carries `attrs`.
- timestamps use an undisclosed fixed offset and are rounded to the second; intervals are
  preserved to within a second. Neither the file name nor this document states the source
  date.
- tool arguments, results, messages, working directories, commands, job labels and error
  text are not present.
- the MCP server name is replaced with `remote`; the recorded names were environment-specific.
- no account, path, URL or payload data is included. `../real-run.test.js` asserts the
  file has no `attrs`, keeps the id and timestamp formats, accepts only the documented
  fields and tool names, and stays free of third-party identifiers and non-ASCII text.

## Gaps

These runs contain no approval decisions, so no `approval` spans are included. Approval
coverage needs a run that goes through an approval prompt; the fixture should grow from a
real one rather than be synthesized.
