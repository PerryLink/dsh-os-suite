# dsh-os-lease — Design

Status: MVP (`0.1.0`). Pure ESM JavaScript + JSDoc, no build step.
Core logic lives in `src/core.js` and imports nothing from `@deepseek-ai/*`.

## 1. Problem

Parallel DSH agents sharing a workspace have no shared notion of "I am about to
change these paths". `git worktree` gives each agent a separate checkout, which
is excellent isolation but not coordination: it does not reserve paths inside a
workspace, cannot express a multi-file atomic intent, and cannot make a crashed
agent's reservation expire. The lease layer supplies exclusivity; the patchset
layer supplies two-phase, multi-file intent.

## 2. Data model

### Lease

```js
{
  id: "lease-1",              // manager-local, deterministic counter
  workspace: "/repo",         // normalized key; equality only
  paths: ["src/api"],         // normalized, deduplicated, workspace-relative
  owner: "agent-1",           // caller label; no auth semantics
  ttlMs: 900000,              // latest acquire/renew grant
  expiresAt: 1760000000000,   // epoch ms; stale when now >= expiresAt
  status: "active",           // active | expired | released
  createdAt: 1759999100000
}
```

### Patchset

```js
{
  id: "patchset-1",
  leaseId: "lease-1",
  files: [
    { path: "src/api/routes.js", before: "...", after: "..." },
    { path: "src/api/schema.js",            after: "..." }
  ],
  status: "prepared",         // prepared | committed | rolledBack
  createdAt: 1759999200000,
  committedAt: undefined,     // set on commit
  rolledBackAt: undefined     // set on rollback
}
```

### Path normalization

- Backslashes become `/`; leading `./` is removed; duplicate and trailing
  slashes are collapsed.
- Absolute paths (`/x`), drive paths (`C:\x`), control characters, and `.` /
  `..` segments are rejected (`INVALID_PATH`).
- Paths are literal and workspace-relative. Globs and symlinks are not resolved.
- Matching is case-sensitive. On a case-insensitive filesystem, `src/A` and
  `src/a` are distinct keys in this MVP.

### Workspace normalization

Trim, convert `\` to `/`, collapse duplicate slashes, strip trailing slashes.
Workspaces are opaque equality keys; they are never resolved against the host
filesystem. `/repo`, `/repo/`, and `\repo` are the same key.

## 3. Lease state machine

```
                acquire
      (none) ─────────────► active
                               │  │
                     renew     │  │  release
                 (now+ttl)     │  └──────────► released
                               ▼                 ▲
                             active              │ release (cleanup)
                               │                 │
                 now >= expiresAt (lazy)         │
                               ▼                 │
                            expired ─────────────┘
```

- There are no timers. Every manager operation calls `expireStaleLeases(now)`
  first, so expired leases are excluded from conflict checks and reflected in
  `status()`.
- `renew` sets `expiresAt = now + ttlMs` (from *now*, not from the old expiry)
  and only succeeds while the lease is `active`.
- `expired` and `released` are terminal for `renew` (`LEASE_EXPIRED` /
  `LEASE_RELEASED`).
- `release` on an expired lease is allowed and moves it to `released`; a second
  `release` is `ALREADY_RELEASED`.
- Expiry is exclusive: at `now === expiresAt` the lease is already stale. Use
  `now >= expiresAt` consistently in the applier.

### Conflict relation

Two paths overlap iff they are equal or one is a segment-boundary prefix of the
other:

```
overlap(a, b) = a === b || a.startsWith(b + "/") || b.startsWith(a + "/")
```

Thus `src/a` conflicts with `src/a/b` and `src/a/b/c`, but not `src/ab`.
Conflicts are evaluated only between **active** leases with **equal normalized
workspace keys**. Leases on different workspaces never conflict, even for
identical paths. `checkConflict` is read-only and returns structured conflicts
with `leaseId`, `owner`, requested `path`, `leasePath`, and `reason`
(`exact` | `prefix`).

A lease path is a subtree reservation. A patchset file is allowed only when it
is equal to, or below, one of its lease's paths (`PATH_NOT_LEASED` otherwise).

## 4. Two-phase transaction

### Prepare

`preparePatchset(leaseId, files)` performs all validation before recording
anything:

1. Lease exists and is `active` (stale leases are expired first).
2. `files` is a non-empty array; each item has a string `after` and an optional
   string `before`.
3. Each path normalizes; duplicates after normalization are `DUPLICATE_PATH`.
4. Every path is covered by the lease (`PATH_NOT_LEASED`).
5. No *other* active lease in the same workspace overlaps (defensive; the lease
   itself should make this impossible).
6. No *prepared* patchset in the same workspace overlaps. This makes the commit
   order unambiguous. Disjoint prepared patchsets are allowed; committed and
   rolled-back patchsets do not block new work.

On success the patchset is stored as `prepared` and a snapshot is returned.

### Commit

`commitPatchset(id)`:

1. Reject a patchset that is already `committed` (`ALREADY_COMMITTED`) or
   `rolledBack` (`ALREADY_ROLLED_BACK`). Commit is deliberately **not
   idempotent**: a duplicate call usually means a duplicated write attempt, so
   it must be visible.
2. Re-check the authorizing lease: it must still be `active`
   (`LEASE_EXPIRED` / `LEASE_RELEASED` otherwise).
3. Transition to `committed`, set `committedAt`.
4. Return `files` projected to `{ path, after }` and **sorted by path**. This is
   the write set. No file operation occurs.

### Rollback

`rollbackPatchset(id)` accepts a `prepared` patchset (abort) or a `committed`
patchset (undo). It:

1. Rejects an already `rolledBack` patchset (`ALREADY_ROLLED_BACK`).
2. Does **not** require a live lease, so cleanup survives expiry/release.
3. Transitions to `rolledBack`, sets `rolledBackAt`.
4. Returns `{ path, before? }` sorted by path. A missing `before` key means the
   caller declared a new file.

### Patchset state machine

```
prepare                commit
(none) ───────► prepared ────────► committed
                    │                    │
                    │ rollback           │ rollback
                    └──────────┬─────────┘
                               ▼
                          rolledBack
```

`rolledBack` is terminal. `commit` after rollback is an error; `rollback` after
rollback is an error.

## 5. Integration points

### DSH tool pipeline

`apply(ctx)` creates one manager in the plugin-instance closure and registers:

- `workspace_lease` → `acquire` / `renew` / `release` / `checkConflict`
- `workspace_apply` → `preparePatchset` / `commitPatchset`
- `workspace_rollback` → `rollbackPatchset`
- `workspace_status` → `status`

Tool code only selects the core operation. Core errors are surfaced with their
stable `code` prefix so an agent can react (`CONFLICT`, `LEASE_EXPIRED`,
`ALREADY_COMMITTED`, ...).

### Worktree integration

Treat the worktree root as the `workspace` key. Recommended lifecycle:

1. Create/locate the worktree.
2. `acquire({ workspace: worktreeRoot, paths, owner: agentId, ttlMs })`.
3. Work; `renew` before long builds/tests.
4. `release` before removing the worktree.

This is orthogonal to worktree isolation: a worktree removes cross-checkout
interference; a lease coordinates agents that intentionally share a checkout.
The MVP has no workspace-root sentinel (`.` is rejected), so reserve the
top-level paths that matter, for example `["src"]` and `["tests"]`.

### fs-intent / edit integration

A future applier should wrap file-writing tools:

1. Before the first write, ensure an active lease covers the path (or acquire
   one automatically).
2. Build the complete change list and call `preparePatchset` once per logical
   change, including real pre-images read from disk.
3. Perform writes in returned path order, ideally to temp files followed by
   atomic renames; verify each `before` immediately before replacing.
4. On success call `commitPatchset`; on any failure call `rollbackPatchset` and
   use the returned pre-images.
5. Renew long operations; release the lease at task end.

The current MVP stops after step 2 and returns the plan from `commit`. This is
intentional: it keeps `core.js` offline-testable and prevents the lease layer
from becoming an unverified file writer.

### Cordis / future service layer

The manager is currently per plugin instance. A shared Cordis service (one
manager per profile, keyed by workspace) plus persistence would let multiple
tools and plugins coordinate without each holding its own state. Cross-process
coordination needs an OS-level lock or a small lease daemon; that is roadmap,
not MVP.

## 6. Failure modes

| Failure | Behavior | Mitigation |
| --- | --- | --- |
| Another agent holds overlapping paths | `acquire` throws `CONFLICT` with structured conflicts | Query `workspace_lease action=check`, choose other paths, or wait for TTL |
| Lease expires during a long task | `commit` throws `LEASE_EXPIRED`; patchset stays `prepared` | Renew before long work; rollback remains possible |
| Agent crashes without release | Lease stays active until TTL, then lazily expires | Use a TTL matched to task length; call `release` in `finally` |
| Lease released before commit | `commit` throws `LEASE_RELEASED` | Do not release until all patchsets commit/rollback |
| Duplicate commit | `ALREADY_COMMITTED` | Treat as a bug or duplicate delivery; inspect status |
| Duplicate rollback | `ALREADY_ROLLED_BACK` | Treat as terminal; do not retry blindly |
| Two prepared patchsets overlap | Second `prepare` throws `PATCHSET_CONFLICT` | Commit/rollback the first, or stage disjoint paths |
| Patchset touches unleased paths | `prepare` throws `PATH_NOT_LEASED` | Extend the lease paths before staging |
| Invalid/escaping path | `INVALID_PATH` | Use workspace-relative literal paths |
| Caller-supplied `before` is stale | Not detected by core | Applier must compare disk content before writing |
| External process edits a leased path | Not detected (no fs watch) | Applier verification + single-writer discipline |
| DSH process restart | All leases/patchsets lost | Reacquire; future persistence layer |
| Two DSH processes | Managers do not see each other | Future daemon/OS lock; MVP is single-process |
| Case-insensitive filesystem | `src/A` and `src/a` are distinct | Future canonicalization by workspace filesystem |
| Clock skew / injected clock | TTL decisions follow the injected clock | Tests inject deterministic clocks; production uses `Date.now()` |
| Memory growth from large patchsets | Bodies retained until manager dies | Bound patchset size in the applier; status never echoes bodies |

## 7. Security and permissions

The manager has no filesystem, process, network, or environment access. Its
only authority is the DSH tool call. `owner` is a label, not an authenticated
identity: any agent allowed to call the tools can release or renew any lease it
can name. If multi-tenant isolation is required, an outer authorization layer
must enforce agent-to-owner binding. Do not store secrets in `before`/`after`;
they remain in memory and are visible to anyone who can query a live manager
(though `workspace_status` omits bodies).

## 8. 30-day roadmap

**Days 1–7 — durability and shared state**
- Persist leases/patchsets (JSON file or SQLite) with atomic writes and a
  schema version.
- Expose a Cordis service so every dsh-os tool shares one manager per profile.
- Stable, collision-resistant ids; manager restart tests; keep `node --test`
  offline.

**Days 8–14 — real applier**
- Add an opt-in applier that reads actual pre-images, verifies `before` at
  write time, writes via temp file + rename, and records results.
- Execute rollback, not just return pre-images.
- Integrate with DSH edit/write intent; emit commit/rollback events for audit.

**Days 15–21 — worktree and liveness**
- Worktree lifecycle hooks (acquire on create, release on remove).
- Owner heartbeat/renew helper and stale-owner detection; optional "wait for
  lease" with bounded backoff.
- Metrics: lease wait time, conflict rate, patchset size, commit failures.

**Days 22–30 — multi-process and release**
- Cross-process locking (daemon or lock files) with crash recovery.
- Case/symlink canonicalization strategy per workspace.
- Stress tests for concurrent agents, docs/examples, changelog, publish
  `0.2.0` after rechecking the package name.

## 9. Non-goals

- A general filesystem snapshot/restore system.
- A VCS replacement or merge engine.
- Authenticated multi-tenant authorization.
- A UI, search, memory, or plugin marketplace.
