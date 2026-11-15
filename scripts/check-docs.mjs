#!/usr/bin/env node
/**
 * Guard against the release-doc drift that has bitten this suite before:
 * README/RELEASE saying an old version, or credential docs keeping old test
 * counts. It is deliberately narrow — it checks current-state documents, not
 * CHANGELOG/AUDIT history.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const read = (path) => readFileSync(join(root, path), 'utf8')

/** @param {string} message */
function fail(message) {
  failures.push(message)
}

const packageDirs = readdirSync(join(root, 'packages'))
  .filter((name) => existsSync(join(root, 'packages', name, 'package.json')))
const versions = new Set()
for (const dir of packageDirs) {
  const manifest = JSON.parse(read(join('packages', dir, 'package.json')))
  versions.add(manifest.version)
  if (manifest.license !== 'Apache-2.0') {
    fail(`${dir}: license is ${String(manifest.license)}, expected Apache-2.0`)
  }
}
if (versions.size !== 1) {
  fail(`workspace versions are not in lockstep: ${[...versions].join(', ')}`)
}
const version = [...versions][0]
if (!version) {
  fail('no package version found')
  process.exit(1)
}

const readme = read('README.md')
if (!readme.includes('`' + version + '`')) {
  fail(`README.md does not mention the current version \`${version}\``)
}
if (!/not affiliated/i.test(readme) && !/无隶属关系/.test(readme)) {
  fail('README.md is missing the non-affiliation notice')
}

const currentFiles = ['README.md', 'RELEASE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CREDENTIALS.md']
for (const file of currentFiles) {
  if (!existsSync(join(root, file))) continue
  const text = read(file)
  if (text.includes('`0.' + '1.')) {
    fail(`${file}: still references a 0.1.x version`)
  }
  if (/\b242\/242\b|\b90\/90\b/.test(text)) {
    fail(`${file}: still references an old test count`)
  }
}

const docsRoot = join(root, 'docs')
if (existsSync(docsRoot)) {
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === '_archive') continue
        walk(full)
      } else if (name.endsWith('.md')) {
        const text = readFileSync(full, 'utf8')
        const rel = relative(root, full)
        const historical = /SUPERSEDED|historical|历史/i.test(text.slice(0, 2000))
        if (historical) continue
        if (/\b0\.1\.\d+\b/.test(text)) fail(`${rel}: still references a 0.1.x version`)
        if (/\b242\/242\b|\b90\/90\b/.test(text)) fail(`${rel}: still references an old test count`)
      }
    }
  }
  walk(docsRoot)
}

if (failures.length > 0) {
  console.error('check-docs failed:')
  for (const message of failures) console.error(`  - ${message}`)
  process.exit(1)
}
console.log(`check-docs: ${packageDirs.length} packages at ${version}; current docs consistent`)
