#!/usr/bin/env node
/**
 * smoke-pack.mjs — release gate for the packed npm artifacts of dsh-os-suite.
 *
 * For every non-private package under `packages/*` this script:
 *   1. runs `npm pack --dry-run --json` in the package directory;
 *   2. asserts exactly one tarball is produced, named/versioned like package.json;
 *   3. asserts the tarball contains package.json, README.md, DESIGN.md, LICENSE
 *      and a `src/` tree;
 *   4. asserts every entry point (`main`, `exports`, `bin`, `dsh.bundle.patch`)
 *      and every `files` allowlist entry actually made it into the tarball;
 *   5. rejects test/, node_modules/, *.tgz and OS metadata leaks;
 *   6. runs `<bin> --version` for every `bin` entry (this suite has none today,
 *      so the check is a no-op here and stays ready for future CLIs).
 *
 * The script is read-only for the repo: `--dry-run` writes no tarball and
 * nothing is published. Exit code 0 = all assertions passed, 1 = failure.
 *
 * Usage: node scripts/smoke-pack.mjs [--help]
 */

import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGES_DIR = join(ROOT, 'packages')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const NPM_SHELL = process.platform === 'win32'

/** Files every published package must contain. */
const REQUIRED_FILES = ['package.json', 'README.md', 'DESIGN.md', 'LICENSE']

/**
 * Per-package extras. Add an entry only when a package genuinely needs a file
 * that the generic checks do not cover.
 */
const EXTRA_FILES = {
  // dsh-os-suite packages are library-only; nothing beyond the defaults.
}

/** Directories that must never leak into a published tarball. */
const FORBIDDEN = [
  ['test files', (path) => path === 'test' || path.startsWith('test/')],
  ['node_modules', (path) => path === 'node_modules' || path.startsWith('node_modules/')],
  ['packed tarball', (path) => path.endsWith('.tgz')],
  ['OS metadata', (path) => path === '.DS_Store' || path.endsWith('/.DS_Store')],
]

const USAGE = `smoke-pack.mjs — assert npm tarball contents for every workspace package

Usage:
  node scripts/smoke-pack.mjs
  node scripts/smoke-pack.mjs --help

Exit codes:
  0  every package passed every assertion
  1  at least one package failed (details are printed)
`

/** Normalize a packed path (npm reports POSIX-style paths). */
function normalize(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/** True when `target` is packed exactly or as a directory prefix. */
function hasPath(paths, target) {
  const needle = normalize(target)
  return paths.includes(needle) || paths.some((path) => path.startsWith(`${needle}/`))
}

/** Every relative file path referenced by main/exports/bin/dsh.bundle.patch. */
function entryPointsOf(pkg) {
  const entries = new Set()
  const add = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('./') || value.startsWith('src/') || value.startsWith('data/')) {
        entries.add(normalize(value))
      }
      return
    }
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) add(nested)
    }
  }
  add(pkg.main)
  add(pkg.exports)
  add(pkg.bin)
  add(pkg.dsh?.bundle?.patch)
  return [...entries].sort()
}

/** Normalize the `bin` field to [name, relativePath] pairs. */
function binsOf(pkg) {
  if (typeof pkg.bin === 'string') return [[pkg.name, pkg.bin]]
  if (!pkg.bin || typeof pkg.bin !== 'object') return []
  return Object.entries(pkg.bin).filter(([, path]) => typeof path === 'string')
}

async function runNpmPack(packageDir) {
  const { stdout } = await execFileAsync(NPM, ['pack', '--dry-run', '--json'], {
    cwd: packageDir,
    shell: NPM_SHELL,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  })

  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`npm pack --dry-run --json did not return JSON:\n${stdout.slice(0, 1000)}`)
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    const count = Array.isArray(parsed) ? parsed.length : typeof parsed
    throw new Error(`expected exactly one tarball from npm pack, got ${count}`)
  }
  return parsed[0]
}

async function checkPackage({ dir, pkg }) {
  const problems = []
  const warnings = []

  let pack
  try {
    pack = await runNpmPack(dir)
  } catch (error) {
    return {
      name: pkg.name,
      version: pkg.version,
      problems: [error.message],
      warnings,
      files: 0,
      clis: 0,
    }
  }

  const paths = (pack.files ?? []).map((file) => normalize(file.path))

  if (pack.name !== pkg.name) problems.push(`packed name ${pack.name} != package.json name ${pkg.name}`)
  if (pack.version !== pkg.version) {
    problems.push(`packed version ${pack.version} != package.json version ${pkg.version}`)
  }

  const required = new Set(REQUIRED_FILES)
  for (const extra of EXTRA_FILES[pkg.name] ?? []) required.add(extra)
  for (const file of required) {
    if (!hasPath(paths, file)) problems.push(`missing required file: ${file}`)
  }

  if (!paths.some((path) => path.startsWith('src/'))) problems.push('missing src/ tree')

  for (const entry of entryPointsOf(pkg)) {
    if (!hasPath(paths, entry)) problems.push(`entry point not packed: ${entry}`)
  }

  for (const allowed of pkg.files ?? []) {
    if (typeof allowed !== 'string') continue
    if (!hasPath(paths, allowed)) problems.push(`files entry not packed: ${allowed}`)
  }

  for (const [label, isForbidden] of FORBIDDEN) {
    const leaked = paths.filter(isForbidden)
    if (leaked.length > 0) problems.push(`forbidden ${label} in tarball: ${leaked.join(', ')}`)
  }

  let clis = 0
  for (const [binName, binPath] of binsOf(pkg)) {
    clis += 1
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [join(dir, binPath), '--version'],
        { cwd: dir, maxBuffer: 1024 * 1024, timeout: 30_000 },
      )
      const output = `${stdout}${stderr}`.trim()
      if (output === '') {
        problems.push(`${binName} --version printed nothing`)
      } else if (!output.includes(pkg.name)) {
        problems.push(`${binName} --version output does not name ${pkg.name}: ${JSON.stringify(output)}`)
      } else if (!output.includes(pkg.version)) {
        warnings.push(`${binName} --version does not mention ${pkg.version}: ${JSON.stringify(output)}`)
      }
    } catch (error) {
      const detail = (error.stderr ?? '').toString().trim() || error.message
      problems.push(`${binName} --version failed: ${detail}`)
    }
  }

  return { name: pkg.name, version: pkg.version, problems, warnings, files: paths.length, clis }
}

async function loadPackages() {
  let entries
  try {
    entries = await readdir(PACKAGES_DIR, { withFileTypes: true })
  } catch (error) {
    throw new Error(`cannot read ${PACKAGES_DIR}: ${error.message}`)
  }

  const packages = []
  for (const entry of entries.filter((item) => item.isDirectory()).map((item) => item.name).sort()) {
    const dir = join(PACKAGES_DIR, entry)
    let pkg
    try {
      pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    } catch (error) {
      throw new Error(`cannot read ${entry}/package.json: ${error.message}`)
    }
    if (pkg.private) continue
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
      throw new Error(`${entry}/package.json is missing name or version`)
    }
    packages.push({ dir, pkg })
  }
  return packages
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE)
    return
  }

  let packages
  try {
    packages = await loadPackages()
  } catch (error) {
    console.error(`smoke-pack: ${error.message}`)
    process.exitCode = 1
    return
  }

  if (packages.length === 0) {
    console.error(`smoke-pack: no non-private packages found under ${PACKAGES_DIR}`)
    process.exitCode = 1
    return
  }

  console.log(`smoke-pack: checking ${packages.length} package(s) under ${ROOT}`)

  const results = []
  for (const item of packages) results.push(await checkPackage(item))

  let failed = 0
  let cliCount = 0
  for (const result of results) {
    const status = result.problems.length === 0 ? 'ok  ' : 'FAIL'
    console.log(
      `[${status}] ${result.name}@${result.version} — ${result.files} packed file(s), ` +
        `${result.clis} CLI(s) checked`,
    )
    for (const warning of result.warnings) console.warn(`         warn: ${warning}`)
    for (const problem of result.problems) console.error(`         error: ${problem}`)
    if (result.problems.length > 0) failed += 1
    cliCount += result.clis
  }

  if (failed > 0) {
    console.error(`\nsmoke-pack: FAILED — ${failed}/${results.length} package(s) have problems`)
    process.exitCode = 1
    return
  }
  console.log(`\nsmoke-pack: OK — ${results.length} package(s), ${cliCount} CLI(s) exercised`)
}

await main()
