# dsh-os-lease — Design

Status: MVP (`0.2.0`). Pure ESM JavaScript + JSDoc, no build step.
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
   the write set. Core performs no file operation; the opt-in applier
   (`src/apply.js`) executes it when the plugin is configured with
   `apply: true` and `root`.

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

Tool code only selects the core operation. When the plugin config contains
`apply: true` and `root`, `workspace_apply` additionally passes the prepared
patchset to `src/apply.js`, and `workspace_rollback` first restores the matching
journal. Core errors are surfaced with their stable `code` prefix so an agent
can react (`CONFLICT`, `LEASE_EXPIRED`, `ALREADY_COMMITTED`, ...); applier errors
use `INVALID_PATH`, `PATH_ESCAPE`, `LOCKED`, `BACKUP_MISSING`,
`ROLLBACK_FAILED`, and similar codes.

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

The opt-in applier (`src/apply.js`) implements the file-writing half:

1. Before writing, it checks that each path is inside the canonical `root` and
   refuses symbolic links and the reserved `.dsh-os-lease` tree.
2. It acquires one lock per normalized path through a pluggable provider
   (default: `FileLockProvider` over `.dsh-os-lease/locks`, one `wx`-created
   JSON record per key with `owner`/`token`/`expiresAt`), then backs up the
   real pre-images to `.dsh-os-lease/journal/<patchsetId>/backups/`.
3. It writes each file via temp file + fsync + rename, then marks the journal
   `applied`.
4. On any apply failure it restores the journaled entries in reverse order.
   `workspace_rollback` / `rollback(journal)` restores pre-images, deletes new
   files, and removes directories the apply created when empty.
5. The plugin calls the applier only when configured with `apply: true` and
   `root`; otherwise it returns the plan exactly as before.

`core.js` remains offline-testable and never touches the filesystem. The
applier is a separate module precisely so the lease/plan layer cannot become an
unverified file writer by default.

### Lock provider layer

`src/lock.js` isolates the mutual-exclusion primitive behind
`acquire(key, { ttlMs, owner, issueFence? })`, `renew(handle, { ttlMs })`,
`release(handle)`, `inspect(key)`, and `currentFence()`:

- Every handle carries a random `token`. `renew` and `release` verify it, so an
  expired holder cannot mutate a lock that a newer owner has acquired.
- Every successful acquire also issues a monotonic `fence`. `FileLockProvider`
  keeps the counter in `fencePath` (default `<dir>/fence`) and allocates it with
  read-increment + a `wx` candidate + atomic rename; `MemoryLockProvider` uses
  an in-process counter. The counter is never reset by `release`/`clear`.
- `FileLockProvider` keeps one `<sha256(key)>.lock` file per key. Creation is
  `wx`; expiry is evaluated against the provider clock; reclaim renames the
  stale file and retries. Malformed/legacy files without `expiresAt` are held
  conservatively (no automatic reclaim).
- `MemoryLockProvider` mirrors the contract in a `Map` for tests; instances do
  not share state.
- `withLock(provider, key, fn, options)` releases on success and on throw.
- `applyPatchset` accepts `lockProvider`, `lockTtlMs`, `lockOwner`, and
  `fence`; the default is a file provider at `<root>/.dsh-os-lease/locks` with
  the counter at `<root>/.dsh-os-lease/fence` and a 15-minute TTL. Lock
  acquisition happens before any journal or target write, and `LOCKED` errors
  carry `details.owner`/`details.expiresAt`.
- Before each target write (and each rollback restore/delete) the applier calls
  `assertFence(root, fence)`: a current counter greater than the caller's token
  throws `FENCED`. The journal records `fence`. Without an explicit token the
  applier uses the one from its own acquisition; `rollback` stays unfenced when
  no `{ fence }` is supplied.

Cross-host behavior is deliberately documented as a lease, not a strong
distributed lock: shared NFSv4/SMB 3.x mounts with atomic `O_EXCL`/rename and
bounded clock skew can work; FUSE/cloud-sync mounts cannot; reclaim and release
retain small TOCTOU windows. Fencing rejects a write after a newer token became
visible, but the check and the write are not atomic: a holder paused between
them can still write, and strong consistency still requires an external store
that applies the compare-and-write atomically. See `docs/cross-host-locks.md`
for conditions, TTL/clock guidance, fencing limits, and Redis/SQL interface
sketches (not implemented here).

### Cordis / future service layer

The manager is currently per plugin instance. A shared Cordis service (one
manager per profile, keyed by workspace) plus persistence would let multiple
tools and plugins coordinate without each holding its own state. The applier
already coordinates cooperating processes through the lock provider; lease
*state* is still in memory and would need a daemon or persistence to be shared.

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
| Invalid/escaping path | `INVALID_PATH` / `RESERVED_PATH` | Use workspace-relative literal paths away from `.dsh-os-lease` |
| Symlink on a target path | `SYMLINK_NOT_ALLOWED` / `PATH_ESCAPE` | Use real directories; the applier refuses links even inside `root` |
| Overlapping applies (same host, or shared FS) | `LOCKED` with the holder's `owner`/`expiresAt` from the lock provider | Retry after the other apply finishes, wait for the TTL, inspect with `provider.inspect(key)`, or use disjoint paths |
| Caller-supplied `before` is stale | Not detected by core; applier records `beforeMatches` and backs up the real pre-image | Enable `verifyBefore: true` to reject a mismatch |
| External process edits a leased path | Not detected (no fs watch) | Applier locks only coordinate applies; use single-writer discipline |
| Apply fails mid-patchset | Journal marks `applying` / `applyFailed`; recovery restores in reverse | Inspect/run `rollback(journal)`; journal is retained when recovery fails |
| Rollback backup is missing | `ROLLBACK_FAILED` with per-path `BACKUP_MISSING` | Restore the journal backup, then retry rollback; it is idempotent |
| DSH process restart | Leases/patchsets lost; journals and locks remain | Reacquire; use a fresh patchset id if an old journal id exists |
| Two DSH processes | Managers do not see each other's leases; the same provider (file on a shared FS, or a custom adapter) excludes same-path applies | Future daemon for shared lease state; shared FS needs `docs/cross-host-locks.md` conditions |
| Two hosts, no shared FS | Each host's lock directory is private; both can acquire the same key | Use one shared mount or a custom cross-host provider; the local default does not coordinate |
| FUSE / cloud-sync mount | `wx`/rename are emulated; cross-host exclusion is unreliable | Unsupported: put the lock directory on NFSv4/SMB 3.x or use a custom provider |
| Stale lock file | Reclaimed automatically once `expiresAt` elapses; legacy records without expiry never are | Choose a TTL; delete legacy files manually after confirming no apply is running |
| Case-insensitive filesystem | `src/A` and `src/a` are distinct keys | Future canonicalization by workspace filesystem |
| Clock skew / injected clock | TTL decisions follow the provider clock; skew can shorten or extend a lease | Keep skew far below the TTL; tests inject deterministic clocks |
| Memory growth from large patchsets | Bodies retained until manager dies | No size bound yet; prefer small patchsets; status never echoes bodies |

## 7. Security and permissions

The manager has no filesystem, process, network, or environment access. Its
only authority is the DSH tool call. The applier is a separate opt-in module:
it reads and writes only under the configured canonical `root`, rejects symlinks
on the target chain, and keeps pre-images in `.dsh-os-lease/`. The default
lock provider only touches the lock directory; a custom `lockProvider` is
host-supplied code and may use a network service, so apply the same trust review
as any other dependency. `owner` is a label, not an authenticated identity: any
agent allowed to call the tools can release or renew any lease it can name, and
a lock token is a bearer capability for `renew`/`release`. If multi-tenant
isolation is required, an outer authorization layer must enforce
agent-to-owner binding. Do not store
secrets in `before`/`after`; they remain in memory and are visible to anyone who
can query a live manager (though `workspace_status` omits bodies). With the
applier enabled, `before`/`after` bodies and on-disk pre-images are written to
the journal/backups on disk, so protect `.dsh-os-lease/` accordingly.

## 8. 30-day roadmap

**Days 1–7 — durability and shared state**
- Persist leases/patchsets (JSON file or SQLite) with atomic writes and a
  schema version.
- Expose a Cordis service so every dsh-os tool shares one manager per profile.
- Stable, collision-resistant ids; manager restart tests; keep `node --test`
  offline.

**Days 8–14 — real applier (implemented in 0.1.2)**
- Opt-in applier reads actual pre-images, optionally verifies `before` at write
  time, writes via temp file + fsync + rename, and records results.
- Journal-backed rollback restores/deletes in reverse order and is idempotent.
- Pluggable per-path locks (implemented in `0.2.0`): `FileLockProvider` with
  owner/expiry records and stale reclaim, `MemoryLockProvider`, `withLock`, and
  custom providers through `applyPatchset({ lockProvider })`.
- Monotonic fencing tokens (implemented in `0.2.1`): per-acquire file/in-memory
  counters, `assertFence` before each write, `FENCED` on stale tokens, and the
  fence recorded in the journal.
- Remaining: integrate with DSH edit/write intent; emit commit/rollback events
  for audit.

**Days 15–21 — worktree and liveness**
- Worktree lifecycle hooks (acquire on create, release on remove).
- Owner heartbeat/renew helper and stale-owner detection; optional "wait for
  lease" with bounded backoff.
- Metrics: lease wait time, conflict rate, patchset size, commit failures.

**Days 22–30 — multi-process and release**
- File locks already coordinate processes on one host and, with the documented
  shared-FS conditions, across hosts. Fencing tokens are integrated into the
  write path. Remaining: a first-party Redis/SQL provider (or daemon) with an
  atomic token-check-plus-write, and renew-during-apply.
- Case/symlink canonicalization strategy per workspace.
- Stress tests for concurrent agents, docs/examples, changelog, publish
  `0.2.0` after rechecking the package name.

## 9. Non-goals

- A strong, linearizable distributed lock or a fencing service. The lock layer
  is a cooperative TTL lease; stronger semantics belong in a provider backed by
  Redis/SQL/etcd or a workspace daemon.
- A general filesystem snapshot/restore system.
- A VCS replacement or merge engine.
- Authenticated multi-tenant authorization.
- A UI, search, memory, or plugin marketplace.
