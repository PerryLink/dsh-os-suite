# npm Trusted Publishing (OIDC) — status and steps

> **Status (2026-11-16): blocked on npm account 2FA.** The release workflows still
> use the `NPM_TOKEN` secret. `npm trust github` was attempted for
> `dsh-os-trace` and returned `E403`: the configured granular access token
> bypasses 2FA, and npm refuses that token for trusted-publisher changes.
> Do not remove `NPM_TOKEN` until all six packages are configured.

## Why

Trusted Publishing removes the long-lived `NPM_TOKEN` from GitHub secrets. The
release job authenticates with the GitHub Actions OIDC token (`id-token: write`,
already present) and npm verifies the repository + workflow + environment.

## Per-package setup (npmjs.com, manual)

For each package:

1. Open `https://www.npmjs.com/package/<name>/access` → **Trusted Publishing**.
2. Provider: **GitHub Actions**.
3. Repository: `PerryLink/dsh-os-suite`.
4. Workflow file: `release.yml`.
5. Environment: leave empty.
6. Permission: allow **publish**.

Packages:

- `dsh-os-trace`
- `dsh-os-lease`
- `dsh-os-quota`
- `dsh-os-eval`
- `dsh-os-catalog`
- `dsh-os-registry`

## Then change the workflow

In `.github/workflows/release.yml` publish job:

- remove `NODE_AUTH_TOKEN` / `secrets.NPM_TOKEN`;
- keep `permissions: id-token: write` (already present);
- keep `npm publish --workspaces --provenance`.

Do this only after all six packages show the trusted publisher. A release with
one unconfigured package fails after publishing the earlier ones.

## Verify

- Push a `vX.Y.Z` tag and confirm the release workflow publishes with OIDC.
- `npm view <pkg>@X.Y.Z dist.attestations` still contains a provenance entry.
- Delete the `NPM_TOKEN` Actions secret only after a successful OIDC release.
