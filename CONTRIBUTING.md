# Contributing to dsh-os-suite

Thanks for helping. This is an unofficial community project, **not** affiliated with, sponsored by, or endorsed by DeepSeek. By contributing, you agree that your contribution is licensed under Apache-2.0.

Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md) before you start. Do not report security vulnerabilities in a public issue or pull request.

## Where the source lives: `04-build` and GitHub

- The public repository is <https://github.com/PerryLink/dsh-os-suite>. It is the collaboration surface, the public source of record, and the home of release tags.
- The maintainer workspace keeps the release staging tree at `04-build/dsh-os-suite` in the `deepseek-community-hub` workspace. That tree is a standalone Git checkout with a GitHub remote. Release candidates are built, tested, packed, and reviewed there.
- **Tracked files must not diverge.** Maintainers sync `04-build` → GitHub before tagging and publishing, and port an accepted pull request back into `04-build` after merging. Never make a long-lived GitHub-only edit.
- External contributors do **not** need access to `04-build`. Open a pull request on GitHub; maintainers will apply the accepted change to the staging tree and re-sync.
- `node_modules/`, `*.tgz`, `.DSH_HOME/`, and `*.log` are ignored. Do not commit them.

## Development environment

- **Node.js** `^22.19.0 || >=24.9.0` (the `engines.node` range). The 0.1.1 audit ran on Node 24.22.1; if you test the lower bound, state the exact version in your PR.
- **npm** with workspace support. Run commands from the repository root.
- **DSH peer:** `@deepseek-ai/dsh-tools` 0.2.2-rc.3 and `engines.dsh >=0.2.2-rc.3 <0.3.0`. `npm install` fetches the dev dependencies.

```sh
npm install
npm test
```

The suite currently reports 90 passing tests. The number may grow; the gate is **zero failures**, not a fixed count.

Check every source file for syntax errors:

```sh
# POSIX
for f in packages/*/src/*.js; do node --check "$f"; done
```

```powershell
# PowerShell
Get-ChildItem packages -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
```

Useful narrower commands:

```sh
npm test --workspace dsh-os-trace
cd packages/dsh-os-trace && npm pack --dry-run
```

Core logic and tests are offline: no network, no real `DSH_HOME`, no credentials. Tests must not write outside a temporary directory.

## Naming and description rules

Package names and descriptions are part of the public contract. Propose the name in an issue **before** opening a package PR.

- A package name is `dsh-os-<topic>`, lower-case kebab-case, unscoped, with no version suffix. Do not use `official`, `deepseek-*`, or a name that implies endorsement.
- Tool names are `snake_case`, unique across the suite, and must not shadow a DSH built-in tool. Use a clear verb-noun shape (`quota_admit`, `trace_verify`).
- The `description` is one sentence, present tense. Say what the package does **and** its limit. Use `advisory` for budgets, `MVP` for partial backends, and “local” when there is no remote service.
- Do not use “secure”, “audit-certified”, “production-ready”, “guaranteed”, or “official” unless the implementation and tests actually support the claim. A heuristic is described as a heuristic.
- Required metadata: `license: "Apache-2.0"`, `engines.node`, `engines.dsh`, `dsh.bundle.patch`, `repository` / `homepage` / `bugs`, and a `files` list that includes `LICENSE`, `README.md`, `DESIGN.md`, and `cordis.patch.yml`.
- A package README must carry the unofficial statement, a status line, an install section, the tool list, and a limitations section. `DESIGN.md` covers the data model, integration points, failure modes, and roadmap.
- Before opening the PR, verify the name is free:
  - `npm view <name> version` returns `E404`;
  - GitHub repository search for the exact name returns no repository.
  Paste that evidence in the PR.

## Pull requests

- **One logical change per PR.** A bug fix, a feature, a rename, a formatting sweep, and a dependency bump are separate PRs. Do not bundle an unrelated README or CONTRIBUTING edit into a code PR. A release PR (version bump + changelog) is its own PR.
- **Tests are required** for behavior changes. Add or update a `test/*.test.js` case, run `npm test`, and paste the pass/fail summary. Docs-only PRs may skip new tests but must still pass `npm test` and `node --check`.
- **Update the docs.** Add a `CHANGELOG.md` entry under `[Unreleased]` and update the package README for user-visible behavior, tool schemas, exit codes, or limitations.
- **Preserve the non-official statement.** Every package README must keep: “Community project. Not affiliated with, sponsored by, or endorsed by DeepSeek.” Do not use DeepSeek logos, wordmarks, or any wording that implies endorsement.
- **Call out contract changes.** Tool names, parameter/output schemas, and package names are compatibility surfaces. Explain the break and why it is necessary.
- **No secrets or customer data.** Do not commit tokens, keys, real `.env` files, customer logs, or personal data. Redact evidence.
- **Keep the diff reviewable.** No generated files, no unrelated reformatting, no `node_modules/`, no tarballs.
- In the PR description, include: what changed and why; affected packages; the test commands and results; any migration or compatibility note; and the linked issue.

Security issues go through [SECURITY.md](SECURITY.md), never a public PR or issue.

## Release checklist (maintainers)

1. Sync `04-build/dsh-os-suite` and GitHub so tracked files match.
2. Bump all six packages together; this suite is released in lockstep.
3. Update `CHANGELOG.md` and the root README status.
4. Run `npm test`, run `node --check` over every `src/*.js`, and inspect `npm pack --dry-run` for each package.
5. Publish from a clean tree, tag `v<version>` on GitHub, and create the GitHub release.
6. Record the result in `AUDIT.md`.

Questions about a change are welcome in a bug or feature issue. Use the templates in `.github/ISSUE_TEMPLATE/`.
