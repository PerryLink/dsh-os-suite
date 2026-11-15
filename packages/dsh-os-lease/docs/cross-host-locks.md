# Cross-host locks in `dsh-os-lease`

Status: design note for the pluggable lock API (`src/lock.js`, `dsh-os-lease@0.2.1`).
This document describes what the lock layer can and cannot guarantee when the
same workspace is mounted on more than one host. It is not a claim of
linearizability and it is not a substitute for a database transaction. The
fencing token in §5 is a useful safety net, not a linearizable lock.

## 1. What the lock layer does

`applyPatchset()` takes one short-lived lock per normalized patchset path before
it reads pre-images or writes targets, and releases those locks in `finally`.
The provider is pluggable:

```js
import { applyPatchset } from 'dsh-os-lease/apply'
import { FileLockProvider } from 'dsh-os-lease/lock'

const locks = new FileLockProvider({ dir: '/mnt/shared/.dsh-os-lease/locks' })

await applyPatchset(patchset, {
  root: '/mnt/shared/workspace',
  lockProvider: locks,
  lockTtlMs: 15 * 60 * 1000,
  lockOwner: 'host-a/agent-7',
})
```

The default provider is a `FileLockProvider` rooted at
`<root>/.dsh-os-lease/locks`, with the fencing counter at
`<root>/.dsh-os-lease/fence`. Every lock has an owner, an expiry, a random
token, and a monotonic **fence**. The token is the capability used by
`renew()`/`release()`: an expired holder whose lock was reclaimed cannot renew
or release the new holder's lock. The fence is the write capability recorded in
the journal and checked before each target write (§5).

This is a **lease**, not a strong distributed lock. Four properties follow from
that and cannot be configured away:

1. Expiry is evaluated from a local clock, so correctness depends on bounded
   clock skew.
2. Reclaim is best effort and race-prone by design (see §5).
3. Fencing is a compare-then-write check, not an atomic test-and-set. It only
   rejects a writer that has *already observed* a newer fence before it writes.
   A process paused after its check and before its write can still write. The
   target filesystem does not enforce the token.
4. There is no global ordering guarantee. Writes can still interleave, and a
   crash can leave a partially applied tree plus a retained journal.

## 2. When cross-host locking is possible

A `FileLockProvider` works across hosts only when **all** of the following hold:

1. **Same key space.** Every host resolves the lock directory to the same
   server-side directory. `/mnt/shared/locks` on host A and host B must not be
   two local copies or two different exports.
2. **Atomic exclusive create.** The server honours
   `open(path, O_CREAT | O_EXCL)` (`fs.open(path, 'wx')`). The call must be
   decided atomically on the server, not by client-side "stat then create".
3. **Atomic rename in the directory.** Reclaim moves the stale lock file with
   `rename(2)` inside the same directory, and the fencing counter is published
   by renaming a `.next-<n>` candidate over `fence`; the server must provide
   atomic rename and coherent directory entries.
4. **Usable `fsync`.** The provider fsyncs the lock file and the published
   fence before it returns a handle (directory fsync of the fence rename is
   best effort). A filesystem that rejects or silently ignores those calls
   needs a different provider.
5. **No hidden caching.** A client must not keep returning cached negative
   lookups or stale file contents after another client created or removed the
   lock. Aggressive attribute caching delays *inspect*, and in pathological
   configurations can confuse reclaim.
6. **Shared workspace writes too.** Locking only the lock directory is not
   enough if the files being patched are on a filesystem with incoherent
   caching. The target tree needs at least close-to-open coherence.
7. **Permission alignment.** The process needs create/unlink/rename rights in
   the lock directory on the server. With NFS root squash, a local root becomes
   `nobody` and a `0700` lock directory owned by another UID cannot be used.
   Run all cooperating agents under a shared UID/group and give the lock
   directory a matching mode.

If any condition is missing, `FileLockProvider` may appear to work in light
testing and still hand the same key to two hosts under load.

### NFS

- Prefer **NFSv4.0/4.1/4.2**. NFSv3 generally implements `O_EXCL` correctly on
  the server and is often usable, but older servers, `nolock` folklore, and
  attribute-cache tuning make it easier to misconfigure. `nolock` concerns NLM
  advisory locks, not `O_EXCL`, but it is a useful warning sign that the mount
  was configured for a workload without cross-client locking.
- Mount the same export on every host, with the same path spelling. Do not mix
  a local path and an NFS mount of the same tree on different hosts.
- If lock visibility is suspect, tighten attribute caching (`actimeo=0` or
  `lookupcache=none` on Linux) for the lock directory, or use a dedicated
  export. This costs performance; do not apply it to the whole workspace
  without measuring.
- Check server-side UID mapping and root squash before blaming the provider.

### SMB

- Use **SMB 2.1 or SMB 3.x** with a real server (Windows Server, Samba) and a
  single share. `CREATE_NEW` is the server-side equivalent of `wx`; it must not
  be emulated by the client redirector.
- Do not put the lock directory on a cloud-sync share (OneDrive/SharePoint
  "Files On-Demand", Dropbox, Google Drive). Those clients are synchronization
  engines, not filesystems with atomic create/rename.
- DFS referrals, offline files, and client-side caching can hide directory
  entries. Keep the lock directory out of those paths.
- Windows delete-sharing/oplock behaviour can make a reclaim `rename` fail
  while another client holds the file open. The provider reports
  `LOCK_FAILED`; it does not retry forever.

### Not sufficient

- **A local disk on each host**, even at the same path. There is no shared
  state; every host acquires freely.
- **Replicated trees** (rsync, Syncthing, Unison, git checkout loops). There is
  no server-side atomic create across replicas.
- **Object-store gateways** (s3fs, gcsfuse, rclone mount, many "cloud drives").
  These are FUSE or userspace emulations; see below.
- **FUSE filesystems in general.** sshfs, rclone, s3fs, gcsfuse, davfs, and
  similar mounts emulate POSIX with client-side caches and no shared kernel
  lock state. `O_EXCL` may be implemented as a local check, rename may not be
  atomic across clients, and directory entries can be stale. `dsh-os-lease`
  does not attempt to detect FUSE and does not support it for cross-host
  exclusion. NFS and SMB are kernel filesystem clients (with server-side
  semantics); FUSE is explicitly out of scope.
- **A single host with several containers** that each mount their own overlay
  or bind mount of the same path. Containers on one kernel can share a real
  directory, but a per-container copy is a local disk as far as the lock is
  concerned.

## 3. Clock skew

`FileLockProvider` and `MemoryLockProvider` compare `now >= expiresAt` using
the provider's clock (`Date.now()` by default; tests can inject one). There is
no server clock and no clock exchange.

Let `δ` be the difference between the fastest and slowest participating clock.
The holder's expiry is computed on its clock; a contender decides reclaim on
its own clock. The effective lifetime can therefore be shorter than `ttlMs` by
up to `δ` (or longer by `δ` on the holder side). Consequences:

- `δ` close to `ttlMs` means a lock can be reclaimed almost immediately after
  it was acquired, or never reclaimed while the holder thinks it has expired.
- NTP/chrony steps during an apply can move the clock in either direction. A
  backwards step extends the stale window; a forwards step can cause early
  reclaim.
- VM suspend/resume, laptop sleep, and long GC pauses are indistinguishable
  from a clock jump to the lease.

Guidance:

- Keep `lockTtlMs` at least an order of magnitude above the measured skew `δ`
  (for example, `lockTtlMs = 900000` with a measured skew below 90 s is only a
  10× margin; tighter deployments should monitor NTP offset and keep it far
  below the TTL).
- Prefer a network time service with monitoring; record the offset in the
  agent's incident notes when a `LOCKED`/reclaim anomaly appears.
- Do **not** use the same TTL for a job that can pause for minutes (builds,
  downloads, VM live migration) unless the job holds no lock across the pause.

## 4. TTL guidance

The lock is held for the duration of one `applyPatchset` call, not for the
whole agent task. `applyPatchset` does not renew the lock; a lock that expires
mid-apply can be reclaimed by another process while the first process is still
writing. Choose `lockTtlMs` longer than the worst-case apply on that tree:

| Workload | Suggested `lockTtlMs` | Notes |
| --- | --- | --- |
| Small patchset, local SSD | 60 s – 5 min | Short stale window after a crash. |
| Default (multi-file source edits) | 15 min (`900000`, the default) | Matches the lease default. |
| Large binary/generated assets, slow shared FS | 30–60 min | Reclaim during a long apply is worse than a long stale window. |
| High-latency NFS/SMB or known clock trouble | larger than the above | Also fix the clock; TTL is not a substitute. |

Trade-off: a short TTL cleans up a crashed applier quickly but makes premature
reclaim more likely; a long TTL is safer under load but leaves the path blocked
longer after a crash. There is no heartbeat during apply. If an apply can
legitimately exceed the TTL, split the patchset, reduce the path set, or use a
custom provider whose semantics you control.

Operational notes:

- Locks created by older versions with no `expiresAt` are treated as **held
  with no expiry** and are never reclaimed automatically. Remove such a file
  only after confirming no apply is running.
- After a `kill -9`, the lock file remains until its TTL elapses. A retry
  before then gets `LOCKED` with the dead owner's label and expiry.
- Fence gaps are normal: a failed acquire, a crashed allocator, or a stale
  `.next-<n>` candidate (reclaimed after 30 s) can skip values. Only monotonic
  ordering matters, never contiguity.
- The fence check runs before every target write, so an apply of `n` files
  reads the counter `n + 1` times. Keep the fence counter on the same coherent
  mount as the locks; a local counter per host fences nothing.
- `workspace_status` does not inspect locks; use the provider's `inspect(key)`
  or the embedding API for diagnostics.

## 5. Reclaim race and fencing

### Reclaim race

When a lock is expired, the file provider:

1. reads the record and checks `now >= expiresAt`;
2. re-reads it immediately before reclaiming;
3. renames the stale file to a unique claim name (atomic, so one reclaimer
   wins) and retries `wx`.

Between step 2 and step 3 another host can release and re-acquire the key. The
probability is small (the window is a few syscalls), but it is not zero. The
same applies to `release()`: it verifies the token immediately before
`unlink`, with a small untrusted window.

### Fencing tokens

Reclaim alone cannot stop two writers from writing. Fencing adds a monotonic
token so the losing writer can be rejected:

- `acquire()` returns `{ fence, owner, expiresAt }` (plus the token and key).
  `FileLockProvider` stores the counter in `fencePath` (default `<dir>/fence`,
  default `<root>/.dsh-os-lease/fence` for the applier). It reads the value,
  adds one, writes a deterministic candidate `fence.next-<n>`, and atomically
  renames the candidate over `fence`. The `wx` create of the candidate is the
  serialization point: two allocators may read the same value, but only one can
  create the next candidate, and a stale reader re-checks the counter before
  publishing. A token is never issued twice. `MemoryLockProvider` uses an
  in-process counter with the same monotonic contract.
- `applyPatchset({ fence })` accepts a token from a lease the caller acquired.
  It then acquires the path locks with `issueFence: false`, so its internal
  acquisition does not advance the counter past the caller's token.
- Before each target write (and before each rollback restore/delete) it calls
  `assertFence(root, fence)`. If the current fence is greater than the caller's
  token, the write is refused with `FENCED`. The journal records `fence`.
- Without an explicit `fence`, the applier uses the token from its own last
  path-lock acquisition, so ordinary applies are fenced too.
- `rollback(journal, { fence })` applies the same check; without `fence` it
  keeps the old unfenced behavior. Rollback has no provider instance, so it
  reads `<root>/.dsh-os-lease/fence` unless you pass `fencePath` (use that when
  the provider keeps the counter in a shared lock directory outside the root).

Because the applier takes its own path locks, a caller that acquired the same
paths must release them before calling `applyPatchset`; otherwise the applier
reports `LOCKED`. Releasing does not invalidate the caller's fence — the token
stays valid until another acquire advances the counter.

The check protects against the common failure: host A stalls past its TTL, host
B reclaims the key and starts an apply, A wakes up and tries to write. A's
token is older than the fence B published, so A's write is rejected **if A's
check happens after B's publish**.

### What fencing does not do

The check and the write are separate syscalls. There is no atomic
"compare-fence-and-write" primitive on a normal filesystem:

1. Holder A calls `assertFence`, sees its own token is current.
2. A is paused (VM suspend, stop-the-world GC, scheduler starvation, SIGSTOP).
3. Holder B acquires, publishes a newer fence, and writes.
4. A resumes and executes the write it had already checked.

A's write lands. Fencing did not prevent it, because no newer fence was visible
at check time. The same applies between the per-file checks inside one apply.
Fencing also does not stop a process that ignores the lock API, an editor, an
NFS client with stale caching, or a filesystem that does not provide atomic
`wx`/rename. And because the counter is global to the lock directory, any newer
acquire (even for disjoint paths) makes older tokens stale; expect occasional
`FENCED` retries when unrelated agents acquire concurrently.

For strong consistency you still need an external authority whose write path is
atomic with the token check:

- put the writes in a system that can compare the token and apply the write in
  one transaction (a database row version, etcd compare-and-swap, a lock
  service that owns the data);
- or serialize all writes through one daemon/service per workspace;
- or use a filesystem/object store with native conditional writes
  (compare-and-swap on a generation number).

A journal makes a retry after `FENCED` safe to inspect, but it does not make
the write linearizable. `dsh-os-lease` implements the token and the
compare-then-write guard; it does not implement distributed transactions.

## 6. Custom providers (interface examples only)

`applyPatchset({ lockProvider })` accepts any object with
`acquire`/`renew`/`release`/`inspect` methods that throws `LockError`-shaped
errors (`code`, `details.owner`, `details.expiresAt` for `LOCKED`). To
participate in fencing, the provider should also:

- return a monotonic `fence` from `acquire()`;
- implement `currentFence()`, used by `assertFence` for every write check;
- accept `issueFence: false` (do not advance the counter) on `acquire`, which
  the applier passes when the caller supplied its own token. Ignoring the
  option is safe only when the provider's counter is not shared with the
  caller's lease.

Without `currentFence()`, `assertFence` falls back to
`<root>/.dsh-os-lease/fence`, which a custom provider usually does not write;
fencing then only rejects a token that is older than that file, which is
usually no fencing at all. Pass `{ fence }` only if the provider can verify it.

This package ships only `FileLockProvider` and `MemoryLockProvider`; the Redis
and SQL adapters below are **not implemented, exported, or tested**. They are
documentation sketches that show the shape and the hazards, and they are not
production adapters.

### Redis

Redis evaluates expiry on the server clock, which avoids client clock skew for
TTL, but replication/failover is asynchronous unless you configure it
otherwise. A lock can be lost after a failover; Redlock-style multi-instance
schemes have known timing assumptions and are still not fencing.

```js
// acquire: Lua: local fence = redis.call('INCR', 'lockfence:' .. scope)
//               if SET lock:<key> <json token+owner+fence> NX PX <ttlMs> then
//                 return fence
//               else return nil end
// renew:   Lua: if GET == token then PEXPIRE ttlMs; return 1
// release: Lua: if GET == token then DEL; return 1
// inspect: GET + PTTL
// currentFence: GET lockfence:<scope> (or persist it yourself)
```

Store the owner and fence alongside the token (for example a JSON value) if you
want `LOCKED` errors to name the holder. `INCR` gives a server-side, monotonic
token without clock skew. Always compare the token in Lua; a read-then-delete
is the same race as the file provider, only faster. Remember that the fence is
still only compared by the applier before its write: a Lua script that checks
the fence *inside* the same script as the data write is what would make the
write atomic.

### SQL (PostgreSQL/MySQL)

Use the database clock (`CURRENT_TIMESTAMP`), a unique key, and one statement
for acquire. For example, with a `locks(lock_key primary key, owner, token,
fence, expires_at)` table and a `fence_seq` sequence:

```sql
INSERT INTO locks (lock_key, owner, token, fence, expires_at)
VALUES (
  $1, $2, $3, nextval('fence_seq'),
  now() + ($4 || ' milliseconds')::interval
)
ON CONFLICT (lock_key) DO UPDATE
  SET owner = EXCLUDED.owner, token = EXCLUDED.token,
      fence = EXCLUDED.fence,
      expires_at = EXCLUDED.expires_at
  WHERE locks.expires_at <= now()
RETURNING fence;
```

The `WHERE` on the conflict path is the atomic test-and-set; a zero-row result
means the key is live. Renew and release must include `AND token = $token`.
Run them in a transaction with an isolation level you understand; do not read,
then decide in application code, then write.

### etcd / ZooKeeper

Leases plus a monotonic revision/zxid can provide a real fencing token. That is
outside this package; if you build it, keep the token in the write path rather
than only in the lock record. A provider can return the revision as
`acquire().fence` and implement `currentFence()`; the applier then rejects a
revision older than the last one it can see. The rejection is still
compare-then-write unless the data write itself goes through an etcd
transaction that checks the revision.

## 7. Deployment checklist

- [ ] Lock directory on a shared NFSv4 or SMB 3.x mount, same server/export and
      same path on every host.
- [ ] Fencing counter (`<root>/.dsh-os-lease/fence`, or the provider's
      `fencePath`) on the same coherent mount as the locks; never a per-host
      local file. Treat a malformed counter as an incident, not as zero.
- [ ] Not FUSE, not cloud sync, not per-host overlay.
- [ ] Same UID/group access (or a deliberately shared mode); NFS root squash
      checked.
- [ ] Clocks synchronized and monitored; measured skew documented.
- [ ] `lockTtlMs` longer than the worst-case apply; owner labels include host
      and agent (for example `host-a/agent-7`).
- [ ] Patchsets are small; long jobs do not hold a lock across pauses.
- [ ] Retry policy treats `LOCKED` and `FENCED` as transient, re-acquires (and
      therefore gets a newer token), and surfaces `owner` / `expiresAt` to the
      operator.
- [ ] Callers that acquired their own lease pass its `fence` to
      `applyPatchset` / `rollback`; a `FENCED` rollback is inspected before
      retrying with a fresh token.
- [ ] Journal and backup directories are on the same coherent mount; rollback
      is not lock-protected unless `{ fence }` is supplied, so do not run it
      concurrently with an apply on overlapping paths.
- [ ] A single-host integration test and a two-host kill/reclaim test are part
      of the deployment validation.

## 8. Summary

| Property | Same host | Shared FS (NFS/SMB) + correct primitives | Custom provider |
| --- | --- | --- | --- |
| Excludes cooperating `applyPatchset` callers | Yes | Yes, subject to §2 | Depends on provider |
| Expiry after crash | Yes, after TTL | Yes, after TTL | Depends on provider |
| Immune to clock skew | N/A (one clock) | No; keep skew ≪ TTL | Depends; prefer server clock |
| Linearizable / strong | No | No | Only if the provider is |
| Rejects a write after a newer fence became visible | Yes | Yes | If the provider issues/checks a fence |
| Prevents a writer paused between check and write | No | No | Only with an atomic compare-and-write store |
| Works on FUSE/cloud-sync mounts | N/A | No | Not via `FileLockProvider` |

For a single host, the default is appropriate. For multiple hosts on a shared
filesystem, it is a cooperative lease that prevents the common "two agents edit
the same multi-file patchset" accident, and the fence usually catches the
"stalled holder writes late" case. It does **not** prevent a holder that was
paused after its fence check, and it is not linearizable. For anything stronger,
implement a provider backed by a system that gives you the semantics you need,
and put the write behind that system's atomic token check.
