#!/usr/bin/env node
/**
 * verify-tarballs.mjs — optional end-to-end packaging check.
 *
 * `smoke-pack.mjs` validates the *manifest*; this script validates the real
 * install path that consumers will hit:
 *   1. `npm pack` every non-private workspace package into a temp directory;
 *   2. `npm install --ignore-scripts` that tarball into a throwaway project;
 *   3. import the installed package by name and require at least one export;
 *   4. run `<bin> --version` for every installed CLI.
 *
 * Nothing is published and no repository file is modified. Some packages have
 * peer dependencies, so this script may need the network to fetch them (the
 * first run can take a while; afterwards npm's cache makes it fast).
 *
 * Usage:
 *   node scripts/verify-tarballs.mjs
 *   node scripts/verify-tarballs.mjs --only dsh-os-trace
 *   node scripts/verify-tarballs.mjs --keep
 *
 * Exit codes:
 *   0  every package packed, installed, imported and (if it has a CLI) ran
 *   1  at least one package failed
 *   2  invalid command-line usage
 */

import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGES_DIR = join(ROOT, 'packages')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const NPM_SHELL = process.platform === 'win32'
const TEMP_PREFIX = 'dsh-verify-tarballs-'

const USAGE = `verify-tarballs.mjs — pack, install and import every workspace package

Usage:
  node scripts/verify-tarballs.mjs [--only <package-name>] [--keep]

Options:
  --only <name>  Verify a single package (useful while debugging).
  --keep         Keep the temporary directory instead of deleting it.
  --help         Show this help.

Exit codes:
  0  all packages passed
  1  at least one package failed
  2  invalid usage
`

/** Normalize the `bin` field to [name, relativePath] pairs. */
function binsOf(pkg) {
  if (typeof pkg.bin === 'string') return [[pkg.name, pkg.bin]]
  if (!pkg.bin || typeof pkg.bin !== 'object') return []
  return Object.entries(pkg.bin).filter(([, path]) => typeof path === 'string')
}

function slug(name) {
  return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
}

function errorDetail(error) {
  const stderr = (error.stderr ?? '').toString().trim()
  return stderr || error.message
}

async function loadPackages(only) {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true })
  const packages = []
  for (const entry of entries.filter((item) => item.isDirectory()).map((item) => item.name).sort()) {
    const dir = join(PACKAGES_DIR, entry)
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    if (pkg.private) continue
    if (only !== null && pkg.name !== only) continue
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
      throw new Error(`${entry}/package.json is missing name or version`)
    }
    packages.push({ dir, pkg })
  }
  return packages
}

async function packTarball({ dir, pkg }, tarballDir) {
  const { stdout } = await execFileAsync(
    NPM,
    ['pack', '--json', '--pack-destination', tarballDir],
    { cwd: dir, shell: NPM_SHELL, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
  )
  const parsed = JSON.parse(stdout)
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`expected exactly one tarball from npm pack, got ${parsed?.length ?? 'non-array'}`)
  }
  const tarball = join(tarballDir, parsed[0].filename)
  await access(tarball)
  return tarball
}

async function installTarball({ pkg }, tarball, installDir) {
  await mkdir(installDir, { recursive: true })
  await writeFile(
    join(installDir, 'package.json'),
    `${JSON.stringify({ name: `verify-${slug(pkg.name)}`, private: true, type: 'module' }, null, 2)}\n`,
  )
  await execFileAsync(
    NPM,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', tarball],
    { cwd: installDir, shell: NPM_SHELL, maxBuffer: 8 * 1024 * 1024, timeout: 300_000 },
  )
}

async function importInstalled({ pkg }, installDir) {
  const code = `
const mod = await import(${JSON.stringify(pkg.name)})
const keys = Object.keys(mod)
if (keys.length === 0) {
  console.error('module has no exports')
  process.exit(1)
}
console.log(String(keys.length))
`
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', code],
    { cwd: installDir, maxBuffer: 1024 * 1024, timeout: 60_000 },
  )
  const exports = Number.parseInt(stdout.trim(), 10)
  if (!Number.isFinite(exports) || exports < 1) {
    throw new Error(`import('${pkg.name}') reported no exports`)
  }
  return exports
}

async function checkBins({ pkg }, installDir) {
  const bins = binsOf(pkg)
  for (const [binName, binPath] of bins) {
    const installed = join(installDir, 'node_modules', pkg.name, binPath)
    await access(installed)
    let stdout
    try {
      const result = await execFileAsync(process.execPath, [installed, '--version'], {
        cwd: installDir,
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      })
      stdout = result.stdout
    } catch (error) {
      throw new Error(`${binName} --version failed: ${errorDetail(error)}`)
    }
    if (stdout.trim() === '') throw new Error(`${binName} --version printed nothing`)
  }
  return bins.length
}

async function main() {
  const args = process.argv.slice(2)
  let keep = false
  let only = null

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE)
      return
    }
    if (arg === '--keep') {
      keep = true
    } else if (arg === '--only') {
      only = args[index + 1] ?? null
      index += 1
      if (only === null) {
        console.error('verify-tarballs: --only requires a package name')
        process.exitCode = 2
        return
      }
    } else {
      console.error(`verify-tarballs: unknown argument ${arg}\n`)
      process.stderr.write(USAGE)
      process.exitCode = 2
      return
    }
  }

  const packages = await loadPackages(only)
  if (packages.length === 0) {
    console.error(only === null ? 'verify-tarballs: no publishable packages found' : `verify-tarballs: no package named ${only}`)
    process.exitCode = only === null ? 1 : 2
    return
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX))
  const tarballDir = join(tmpRoot, 'tarballs')
  await mkdir(tarballDir, { recursive: true })
  console.log(`verify-tarballs: workspace ${ROOT}`)
  console.log(`verify-tarballs: temp ${tmpRoot}`)

  const failures = []
  try {
    for (const item of packages) {
      const label = `${item.pkg.name}@${item.pkg.version}`
      try {
        const tarball = await packTarball(item, tarballDir)
        const installDir = join(tmpRoot, `install-${slug(item.pkg.name)}`)
        await installTarball(item, tarball, installDir)
        const exports = await importInstalled(item, installDir)
        const clis = await checkBins(item, installDir)
        console.log(`[ok] ${label} — installed, ${exports} export(s), ${clis} CLI(s)`)
      } catch (error) {
        console.error(`[FAIL] ${label} — ${errorDetail(error)}`)
        failures.push(label)
      }
    }
  } finally {
    if (keep) {
      console.log(`verify-tarballs: kept ${tmpRoot}`)
    } else {
      const resolved = await realpath(tmpRoot)
      const tempBase = await realpath(tmpdir())
      if (dirname(resolved) !== tempBase || !basename(resolved).startsWith(TEMP_PREFIX)) {
        console.error(`verify-tarballs: refusing to remove unexpected path ${resolved}`)
      } else {
        console.log(`verify-tarballs: removing ${resolved}`)
        await rm(resolved, { recursive: true, force: true })
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\nverify-tarballs: FAILED — ${failures.length}/${packages.length} package(s) failed`)
    process.exitCode = 1
    return
  }
  console.log(`\nverify-tarballs: OK — ${packages.length}/${packages.length} package(s) verified`)
}

await main()
