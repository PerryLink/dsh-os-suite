# Release runbook — dsh-os-suite

How the six packages in this repo are tested, published with provenance, verified
and rolled back.

**Current state (2026-11-14):** all six packages are published at `0.1.1`.
The next release must therefore use a new version, e.g. `0.1.2` / tag `v0.1.2`.

- Packages: `dsh-os-catalog`, `dsh-os-eval`, `dsh-os-lease`, `dsh-os-quota`,
  `dsh-os-registry`, `dsh-os-trace` (`packages/*`).
- The repo root is `private: true` and is never published.
- Workflows: [`.github/workflows/ci.yml`](.github/workflows/ci.yml),
  [`.github/workflows/release.yml`](.github/workflows/release.yml).
- Scripts: [`scripts/smoke-pack.mjs`](scripts/smoke-pack.mjs),
  [`scripts/verify-tarballs.mjs`](scripts/verify-tarballs.mjs).

## Release model

- **Lockstep versioning.** Every package under `packages/*` carries the same
  version. The release workflow fails if any package version differs from the
  tag, so one tag publishes one coherent suite.
- **Tag-driven.** Only a pushed tag matching `v*` starts a publish. Nothing is
  published from `main`, from a pull request, or by hand under normal operation.
- **Workspaces.** The workflow runs
  `npm publish --workspaces --access public --provenance` from the repo root;
  npm publishes each non-private workspace and skips the private root.
- **Provenance.** `--provenance` attaches a sigstore attestation binding each
  tarball to this repository, commit and workflow run. It needs the job's
  `id-token: write` permission, which `release.yml` grants.

## Prerequisites

- Node.js `22.19.0+` or `24.9.0+` and npm `10.9+` (npm 11 recommended). CI runs
  the `22.19.0` and `24` lines.
- A **public** GitHub repo. Provenance is only issued for public repositories,
  and each `packages/*/package.json` must keep its `repository.url` pointing at
  `https://github.com/PerryLink/dsh-os-suite` (it does).
- npm publish rights for all six names (`perrylink` owner; scope as needed).
- Repository secret `NPM_TOKEN`: a **granular access token** with publish
  permission for these packages and no broader account scope. Add it under
  *Settings → Secrets and variables → Actions → New repository secret*.
  Never commit a token, print it in logs, or paste it into an issue/PR.
- Branch protection on `main` should require the `CI` workflow.

## One-time setup: migrate to npm Trusted Publishing (recommended)

`release.yml` currently authenticates with `secrets.NPM_TOKEN` only because
Trusted Publishing has not been configured yet. The target state is OIDC:

1. On npmjs.com, open each of the six packages → **Settings → Trusted
   Publishing → GitHub Actions**.
2. Use repository `PerryLink/dsh-os-suite`, workflow filename `release.yml`,
   environment left blank.
3. Repeat for all six packages.
4. Then edit `release.yml`: remove the `NODE_AUTH_TOKEN` environment entry and
   the empty-token guard, and delete the `NPM_TOKEN` secret. Keep
   `id-token: write` — both provenance and trusted publishing use OIDC.
5. Validate the switch with the next patch release; if OIDC fails, re-add the
   token secret temporarily and record why in the release notes.

Trusted Publishing only works from GitHub-hosted runners, which is what the
workflow uses.

## Before you tag

1. Start from an up-to-date `main`:
   ```sh
   git switch main
   git pull --ff-only
   ```
2. Bump **all six** `packages/*/package.json` versions to the same `X.Y.Z`, then
   refresh the lockfile so CI's `npm ci` stays in sync:
   ```sh
   npm install --package-lock-only
   git diff --stat
   ```
   The diff should only contain the six version fields and `package-lock.json`.
3. Run the same checks CI runs:
   ```sh
   npm ci
   npm test
   node scripts/smoke-pack.mjs
   ```
   `smoke-pack` runs `npm pack --dry-run --json` for every package and asserts
   `package.json`, `README.md`, `DESIGN.md`, `LICENSE`, `src/`, every entry
   point, and every `files` allowlist entry. It exits non-zero on any mismatch.
4. Optional but recommended before a release: install the real tarballs in a
   throwaway directory and import them:
   ```sh
   node scripts/verify-tarballs.mjs
   ```
   This packs each package, runs `npm install --ignore-scripts` into a temp
   project, imports the package by name, and runs any CLI. It needs network
   access for the peer dependencies and leaves the repo untouched.
5. Commit through a PR, e.g. `chore(release): 0.1.2`, merge to `main`, and wait
   for the `CI` workflow to pass on the merge commit.
6. Create and push an annotated tag on that commit:
   ```sh
   git tag -a v0.1.2 -m "dsh-os-suite 0.1.2"
   git push origin v0.1.2
   ```
   Do not tag `v0.1.1` again: those versions already exist on npm and the
   release preflight rejects them.

## What the workflows do

`CI` (`.github/workflows/ci.yml`) runs on every push to `main`, every pull
request, and on demand, with a Node `22.19.0` / `24` matrix:

1. `npm ci --ignore-scripts` (lockfile is committed).
2. `npm test`.
3. `node --check` for every `packages/*/src/*.js`.
4. CLI smoke: `<bin> --version` and `<bin> --help` for every package that
   declares a `bin`. These six packages are library-only today, so the step
   logs a notice and passes; it will exercise a future CLI automatically.
5. `node scripts/smoke-pack.mjs`.

`Release` (`.github/workflows/release.yml`) runs on tags matching `v*`:

- **verify** job: `npm ci`, `npm test`, `node --check`, `smoke-pack`, and a
  check that the tagged commit is an ancestor of `origin/main`.
- **publish** job (needs `verify`): checks the tag equals every workspace
  version, verifies none of those versions exist on npm yet (prevents a
  half-finished re-run), then runs:
  ```sh
  npm publish --workspaces --access public --provenance
  ```
  authenticated by `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`.

Permissions are deliberately minimal: `contents: read` and `id-token: write`.

> **Install source.** The committed `package-lock.json` resolves its tarballs
> through `registry.npmmirror.com`. GitHub-hosted runners normally reach that
> mirror. If the install step fails on a resolved URL, regenerate the lockfile
> against the public registry (delete `package-lock.json`, run
> `npm install --package-lock-only --registry=https://registry.npmjs.org`,
> review the diff, commit) instead of disabling the lockfile in CI.

## Verify a release

1. The `Release` workflow run is green:
   `https://github.com/PerryLink/dsh-os-suite/actions/workflows/release.yml`
2. Registry metadata and provenance are present:
   ```sh
   npm view dsh-os-trace@0.1.2 version dist.integrity dist.attestations
   ```
   `dist.attestations` should contain a `provenance` entry whose predicate points
   at this repo, the tag commit and `release.yml`.
3. The raw attestation is also available at:
   `https://registry.npmjs.org/-/npm/v1/attestations/dsh-os-trace@0.1.2`
4. Verify signatures from a scratch consumer project:
   ```sh
   mkdir /tmp/dsh-sig-check && cd /tmp/dsh-sig-check
   npm init -y
   npm install dsh-os-trace@0.1.2
   npm audit signatures
   ```
   It should report verified registry signatures and provenance attestations for
   the installed packages.
5. Check all six versions in one pass:
   ```sh
   for pkg in dsh-os-catalog dsh-os-eval dsh-os-lease dsh-os-quota dsh-os-registry dsh-os-trace; do
     npm view "$pkg@0.1.2" version
   done
   ```
6. Smoke-install in an isolated DSH profile (do not touch a real profile):
   ```sh
   DSH_HOME=/tmp/dsh-stage-home npx --yes @deepseek-ai/dsh plugin --profile web add dsh-os-trace@0.1.2
   DSH_HOME=/tmp/dsh-stage-home npx --yes @deepseek-ai/dsh --profile web --dump-config | grep dsh-os-
   ```
   The dump should list the six `dsh-os-*` entries. Remove the isolated
   `DSH_HOME` afterwards.

## Rollback

Decide first whether anything reached the registry.

### Nothing published yet

The tag was wrong or the run failed before `npm publish`:
```sh
git tag -d v0.1.2
git push origin :refs/tags/v0.1.2
```
Fix the commit, merge to `main`, then tag again. No registry state to clean up.

### Partial publish (some packages are public)

Do **not** force-push or re-run the same tag: the preflight will stop the re-run,
and npm versions cannot be overwritten. Preferred recovery:

1. Leave the already-published packages alone (or deprecate them if broken).
2. Bump the whole suite to the next patch (`0.1.3`), merge, and release normally.
3. Record which packages/versions are affected in the GitHub release notes.

If you must finish the same version manually, publish only the missing tarballs
after a local `npm test` and `smoke-pack`, one package directory at a time:
```sh
cd packages/dsh-os-trace
npm publish --access public --provenance
```
Keep `NODE_AUTH_TOKEN` in the environment only for that command; never write it
to `.npmrc` in the repo.

### A published version is broken

npm does not allow a published version to be replaced. Use, in order:

1. **Deprecate** the affected versions so installs warn immediately:
   ```sh
   npm deprecate 'dsh-os-trace@0.1.2' 'Broken release: <reason>. Use 0.1.3.'
   ```
   Repeat for each affected package. Deprecation is reversible with
   `npm deprecate 'dsh-os-trace@0.1.2' ''`.
2. **Publish a fixed patch** (`0.1.3`). This moves the `latest` dist-tag and
   creates new provenance attestations.
3. **Unpublish only as a last resort.** npm allows unpublishing a version only
   within 72 hours and only when nothing depends on it; removing a popular
   package or a version older than that requires npm support and is not
   guaranteed. If used:
   ```sh
   npm unpublish dsh-os-trace@0.1.2 --force
   ```
   Unpublishing does not restore trust: consumers may still have the tarball.

Provenance attestations are immutable. You cannot edit an old attestation; only
a new version gets a new one. Never delete a public tag to hide a bad release —
record the rollback in the release notes instead.

### Leaked or lost NPM_TOKEN

1. Revoke the token on npmjs.com immediately.
2. Delete/replace the `NPM_TOKEN` secret in GitHub.
3. Check the package's access log and recent versions for unexpected publishes.
4. Publish a new patch if anything untrusted reached the registry, and announce
   it in the release notes. Do not paste the token into issues or logs.

## About `0.0.0-stage`

`0.0.0-stage` is **not** a version this repo publishes or tags. It is a
placeholder that the npm registry can briefly expose for a **first-time**
package while the initial publish is being staged/processed (see
[`AUDIT.md`](AUDIT.md)); it disappears on its own after a few minutes.

- If you see `0.0.0-stage` right after a brand-new package's first release, wait
  and refresh the package page. Do not re-publish, unpublish, or open a support
  ticket in a loop.
- Never create a tag such as `v0.0.0-stage`. The release workflow rejects any tag
  whose version does not equal every package version.
- Tarballs built from a scratch/staging version are for local experiments only;
  never promote them to a release. Always bump to a real semver (`0.1.2`,
  `0.2.0`, …) before tagging.
- If the placeholder is still visible after ~30 minutes, verify the release with
  `npm view <pkg> versions` and check the workflow logs before doing anything.

## Local quick reference

```sh
npm ci
npm test
node scripts/smoke-pack.mjs
node scripts/verify-tarballs.mjs   # optional; network for peer deps
```

Both scripts exit non-zero on packaging problems, so they can be wired into any
local pre-tag check without further flags.
