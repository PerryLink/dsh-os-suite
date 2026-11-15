# dsh-os-lease

> **Community project. Not affiliated with, sponsored by, or endorsed by DeepSeek.**
> Apache-2.0. No SLA, no warranty. This is an early MVP.

**Workspace lease intents and multi-file transaction plans for parallel DSH agents.**

`dsh-os-lease` lets several agents work in one workspace without silently
overwriting each other. An agent reserves workspace-relative paths with a
time-to-live lease, stages intended file bodies as a patchset, and commits or
rolls back the patchset as one logical unit. The default is **dry-run**: commit
returns a write plan and touches nothing. Opt in with `apply: true` plus an
explicit `root`, and commit writes each file atomically and keeps a recoverable
journal for rollback.

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

The package is **published as `dsh-os-lease@0.2.0`**. From npm:

```sh
npm install
node --test packages/dsh-os-lease/test/*.test.js
```

Once published, it is a standard DSH bundle:

```sh
dsh plugin add dsh-os-lease
```

Requirements: DSH `>=0.2.2-rc.3 <0.3.0`, Node `^22.19.0 || >=24.9.0` (pure ESM
JavaScript, JSDoc types, no build step).

## Tools

The plugin registers four tools. Lease and plan logic lives in `src/core.js`
(no `@deepseek-ai/*` imports); the opt-in filesystem executor lives in
`src/apply.js`. Both are unit-testable offline.

### Enabling real writes

Without configuration the plugin is dry-run only. Real writes require **both**
keys in the plugin config:

```yaml
dsh-os-lease:
  apply: true
  root: /srv/shared-workspace
```

`root` is canonicalized with `realpath` when the first write happens. Every
patchset path must stay inside that directory; absolute paths, drive-letter
paths, `..`, and symbolic links are refused. `verifyBefore: true` is an optional
extra guard that rejects an apply when a caller-supplied `before` body does not
match the file on disk. Leave `apply` absent or `false` to keep the safe
plan-only behavior even if `root` is set.

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
  patchset. No file is touched.
- `commit` requires the lease to still be active and transitions the patchset
  to `committed`. It returns the **path-sorted write set**
  `[{ path, after }]`. A second commit is an error, not a no-op.
- With `apply: true` and `root`, commit also executes the write set: each file
  is written to a sibling temp file, fsynced, then renamed over the target. The
  real on-disk pre-image is saved to
  `.dsh-os-lease/journal/<patchsetId>/backups/`, and the returned `journal`
  describes every path. A failed apply attempts to restore the files it already
  journaled before reporting the error.

### `workspace_rollback`

Takes `patchsetId`, transitions a `prepared` or `committed` patchset to
`rolledBack`, and returns the path-sorted pre-images
`[{ path, before? }]`. A file staged without `before` comes back without a
`before` key, meaning "new file".

When `root` is configured and `.dsh-os-lease/journal/<patchsetId>/` exists,
rollback first restores the journal **in reverse apply order**: existing files
are written back from their backups (temp file + fsync + rename), newly added
files are deleted, and directories created by the apply are removed when empty.
The journal is then marked `rolledBack`. The same `rollback()` call is
idempotent and a second call is a no-op; the tool-level patchset transition
still reports a double rollback as an error. Rollback is allowed even after the
lease expired or was released, so cleanup is never blocked by a stale lease.

### `workspace_status`

Takes no parameters. Returns `{ now, defaultTtlMs, leases, patchsets, counts
}`. Patchsets are summarized by path and status; file bodies are not echoed.
The same snapshot is available from `manager.status()`.

### Journal API (embedding)

`src/apply.js` (published as the `dsh-os-lease/apply` subpath) exports the
executor for hosts that want the same behavior without the tool layer:

- `applyPatchset(patchset, { root, verifyBefore? })` → journal
- `readJournal(id, { root })` → parsed journal manifest
- `rollback(journalPathOrJournal, { root? })` → rollback summary

The journal lives at
`<root>/.dsh-os-lease/journal/<id>/journal.json`; pre-images live in
`<root>/.dsh-os-lease/journal/<id>/backups/`. The manifest records paths,
existence, modes, sizes, and SHA-256 hashes, but not file bodies. Failures throw
`ApplyError` with a stable `code` such as `INVALID_PATH`, `PATH_ESCAPE`,
`LOCKED`, `ALREADY_APPLIED`, `BACKUP_MISSING`, or `ROLLBACK_FAILED`.

Typical flow:

```jsonc
// 1. Reserve a subtree
{ "action": "acquire", "workspace": "/repo", "paths": ["src/api"], "owner": "agent-1", "ttlMs": 600000 }

// 2. Stage a multi-file change
{ "action": "prepare", "leaseId": "lease-1", "files": [
  { "path": "src/api/routes.js", "before": "...", "after": "..." },
  { "path": "src/api/schema.js", "after": "..." }
] }

// 3. Commit: dry-run returns writes sorted by path; with apply:true + root it
//    also writes atomically and returns { applied: true, journal }
{ "action": "commit", "patchsetId": "patchset-1" }

// 4. Optional cleanup (after a real apply)
{ "action": "rollback", "patchsetId": "patchset-1" }
```

## Permissions and data

- **Dry-run by default.** The package performs no filesystem access unless the
  plugin is configured with `apply: true` and `root`. It never spawns
  processes, uses the network, or reads environment variables.
- **With `apply: true`.** The executor reads and writes only under the
  canonical `root`, refuses symbolic links on the target chain, and stores its
  own state under `<root>/.dsh-os-lease/`. Treat that directory as sensitive:
  backups contain pre-images of edited files. Add `.dsh-os-lease/` to the target
  repository's ignore file if the workspace is a git checkout.
- The manifest stores paths, modes, sizes, and hashes; file bodies are written
  only to the backup files. `workspace_status` continues to echo no bodies.
- Leases and patchsets live in memory. A plugin restart loses them; journals and
  locks on disk survive and can be rolled back or inspected by the next process
  with the same `root`.
- No credentials, no telemetry, no external storage. The applier has no
  privileges beyond the DSH process that runs it.

## Limitations

- **Default is plan-only.** Commit writes nothing unless the plugin config has
  both `apply: true` and `root`. There is no per-call override.
- **No cross-host lock.** Overlapping applies are excluded with local
  `fs.open('wx')` lock files under `<root>/.dsh-os-lease/locks/`. This
  coordinates cooperating processes on the **same host and filesystem**; it is
  not a distributed lock. A crashed process can leave a stale lock file, which
  must be removed manually after confirming no apply is still running.
- **Per-file atomic, not multi-file crash-atomic.** Each file is temp-file +
  fsync + rename, but a crash between files leaves a partially applied tree.
  The journal is marked `applying`; run `rollback(journal)` to restore it.
  Recovery is best effort, not a transactional filesystem.
- **Caller-provided pre-images are advisory by default.** The applier always
  backs up the real on-disk pre-image, but it compares a supplied `before` only
  when `verifyBefore: true`.
- **Symbolic links are refused.** A link anywhere on the target chain is
  rejected even if it resolves inside `root`, because rename would replace the
  link rather than its target. Path checks are not atomic against a hostile
  process mutating directories concurrently (TOCTOU); use an OS sandbox for
  adversarial workloads.
- **In-process leases.** There is no cross-process or cross-host lease view.
  Two DSH processes do not see each other's leases; the applier locks only
  protect file application.
- **No persistence of leases.** Restarting DSH drops all lease and patchset
  state; expired workspaces are reclaimed only as a new process sees them.
- **Case-sensitive.** Paths differing only by case are distinct. On
  case-insensitive filesystems, two such leases can both exist.
- **No globs, symlink resolution, rename, or deletion semantics.** Paths are
  literal workspace-relative strings; `..` and absolute paths are rejected.
  Deletion exists only as rollback of files that the journal created.
- **TTL is clock-based.** The default clock is `Date.now()`; callers may inject
  a clock for tests. There is no heartbeat/dead-agent detector.
- **No merge or nested transactions.** A prepared patchset must be committed or
  rolled back before another patchset may touch overlapping paths.
- **Rollback assumes journaled paths are not edited externally.** It restores
  every journaled entry (existing files from backup, new files deleted), which is
  what makes a crash-partial apply recoverable. Locks coordinate applies, not
  external editors or a human changing files while a rollback runs. Rollback
  itself does not take the per-path locks: do not run it concurrently with an
  apply on the same paths.
- **Journals accumulate.** Rollback does not delete the journal directory, so
  `readJournal`/`rollback` remain idempotent. Remove a `rolledBack` journal
  manually if you want to reclaim space.

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

30 tests cover leases (acquire/release, TTL expiry, prefix conflicts, workspace
isolation, lease lifetime at commit), patchset planning (prepare/commit
sorting, duplicate transitions, prepared-patchset overlap, status counts), and
the applier (write/read journals, atomic mode-preserving replacement, path and
symlink escape rejection, rollback restore/delete, idempotent rollback, missing
backup errors, duplicate journal ids, per-path locks, a concurrent lock race,
`verifyBefore`, and the dry-run/apply/rollback tool wiring).

## License

[Apache-2.0](./LICENSE). This is a community project, not an official DeepSeek
product. It is provided as-is, with no SLA or support guarantee.
