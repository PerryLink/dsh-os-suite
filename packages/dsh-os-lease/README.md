# dsh-os-lease

> **Community project. Not affiliated with, sponsored by, or endorsed by DeepSeek.**
> Apache-2.0. No SLA, no warranty. This is an early MVP.

**Workspace lease intents and multi-file transaction plans for parallel DSH agents.**

`dsh-os-lease` lets several agents work in one workspace without silently
overwriting each other. An agent reserves workspace-relative paths with a
time-to-live lease, stages intended file bodies as a patchset, and commits or
rolls back the patchset as one logical unit. Everything is recorded as intent;
the MVP never reads or writes files.

## Why: worktrees isolate, they do not coordinate

`git worktree` solves *build isolation*: each agent gets its own checkout, so
one agent's build cannot dirty another's. It does not solve *coordination*:

- Two agents can target the same repository, branch, or workspace when a
  worktree per agent is impractical (large repos, generated assets, shared
  fixtures, or tools that do not understand worktrees).
- Worktrees do not say who is about to edit `src/api/routes.ts`, so two agents
  can produce conflicting multi-file edits that only surface as a merge
  conflict later.
- A multi-file edit is not atomic at the intent level: agent B can start from
  half of agent A's plan.
- A crashed agent leaves no expiring reservation behind.

Leases add the missing coordination layer: segment-boundary path exclusivity
with an injectable clock and automatic expiry. Patchsets add two-phase intent:
validate and record a whole multi-file change, then commit it as one sorted
write set or roll it back to the recorded pre-images. Worktrees and leases are
complementary — use worktrees when you need full checkout isolation, and leases
when agents must share one workspace safely.

## Install

The package is **not published yet**. From this monorepo:

```sh
npm install
node --test packages/dsh-os-lease/test/*.test.js
```

Once published, it is a standard DSH bundle:

```sh
dsh plugin add dsh-os-lease
```

Requirements: DSH `>=0.2.2-rc.3 <0.3.0`, Node 24 (pure ESM JavaScript, JSDoc
types, no build step).

## Tools

The plugin registers four tools. All four are thin wrappers over
`src/core.js`; the core has no `@deepseek-ai/*` imports and is unit-testable
offline.

### `workspace_lease`

Acquire, renew, release, or dry-run a lease. `acquire` needs `workspace`,
`paths`, and `owner`; `renew`/`release` need `id`; `check` needs `workspace`
and `paths`.

| Action | Meaning |
| --- | --- |
| `acquire` | Reserve paths until `ttlMs` (default 900000 = 15 min). Fails if an active lease in the same workspace overlaps. |
| `renew` | Extend a live lease from *now*. Expired and released leases cannot be revived. |
| `release` | End a lease early. Releasing twice is an error. |
| `check` | Return `{ conflict, conflicts }` without reserving anything. |

Conflict is segment-aware: `src/a` overlaps `src/a`, `src/a/b`, and
`src/a/b/c`, but not `src/ab`. Different workspace keys never conflict. Stale
leases are marked `expired` automatically whenever the manager is touched.

### `workspace_apply`

Two-phase patchset handling. `action: "prepare"` needs `leaseId` and `files:
[{ path, before?, after }]`; `before` is optional for new files.

- `prepare` validates that the lease is alive, every path is covered by the
  lease, paths are unique and workspace-relative, and no other prepared
  patchset overlaps them. It records the before/after bodies and returns the
  patchset.
- `commit` requires the lease to still be active and transitions the patchset
  to `committed`. It returns the **path-sorted write set**
  `[{ path, after }]`. A second commit is an error, not a no-op.

### `workspace_rollback`

Takes `patchsetId`, transitions a `prepared` or `committed` patchset to
`rolledBack`, and returns the path-sorted pre-images
`[{ path, before? }]`. A file staged without `before` comes back without a
`before` key, meaning "new file". Rolling back twice is an error. Rollback is
allowed even after the lease expired or was released, so cleanup is never
blocked by a stale lease.

### `workspace_status`

Takes no parameters. Returns `{ now, defaultTtlMs, leases, patchsets, counts
}`. Patchsets are summarized by path and status; file bodies are not echoed.
The same snapshot is available from `manager.status()`.

Typical flow:

```jsonc
// 1. Reserve a subtree
{ "action": "acquire", "workspace": "/repo", "paths": ["src/api"], "owner": "agent-1", "ttlMs": 600000 }

// 2. Stage a multi-file change
{ "action": "prepare", "leaseId": "lease-1", "files": [
  { "path": "src/api/routes.js", "before": "...", "after": "..." },
  { "path": "src/api/schema.js", "after": "..." }
] }

// 3. Commit: returns writes sorted by path
{ "action": "commit", "patchsetId": "patchset-1" }
```

## Permissions and data

- **Intent only.** The package does not read, write, create, delete, or stat any
  file. It does not spawn processes, use the network, or read environment
  variables.
- `before` / `after` bodies are caller-supplied and held in memory for the life
  of the manager. `workspace_status` intentionally omits them.
- Lease and patchset ids, paths, owner labels, TTLs, and timestamps live in
  memory only. A plugin restart loses all leases and patchsets.
- No credentials, no telemetry, no external storage, no privileges beyond the
  DSH tool call itself.

## Limitations (MVP)

- **Does not write files.** `commit` returns a write plan; your host/applier must
  perform it. There is no atomic file replacement, fsync, or backup.
- **In-process only.** There is no cross-process or cross-host lock. Two DSH
  processes (or two plugin instances) do not see each other's leases.
- **No persistence.** Restarting DSH drops all state; expired workspaces are
  reclaimed only as a new process sees them.
- **Caller-provided pre-images are trusted.** The core cannot verify that a
  `before` value matches the file on disk. An applier must compare before
  writing.
- **Case-sensitive.** Paths differing only by case are distinct. On
  case-insensitive filesystems, two such leases can both exist.
- **No globs, symlink resolution, rename, or deletion semantics.** Paths are
  literal workspace-relative strings; `..` and absolute paths are rejected.
- **TTL is clock-based.** The default clock is `Date.now()`; callers may inject
  a clock for tests. There is no heartbeat/dead-agent detector.
- **No merge or nested transactions.** A prepared patchset must be committed or
  rolled back before another patchset may touch overlapping paths.

## Naming verification

Checked on **2026-11-14**:

- `npm view dsh-os-lease version` → **404** (`E404 Not Found`,
  `registry.npmjs.org/dsh-os-lease` still unclaimed).
- GitHub repository search `q=dsh-os-lease in:name` →
  `"total_count": 0` (`api.github.com/search/repositories`).

Both checks should be repeated immediately before any publish; registry and
repository names can be claimed at any time.

## Tests

```sh
node --test packages/dsh-os-lease/test/*.test.js
```

11 tests cover acquire/release, TTL expiry, prefix conflicts, workspace
isolation, prepare/commit sorting, rollback and duplicate transitions, lease
lifetime at commit, path validation, prepared-patchset overlap, and status
counts.

## License

[Apache-2.0](./LICENSE). This is a community project, not an official DeepSeek
product. It is provided as-is, with no SLA or support guarantee.
