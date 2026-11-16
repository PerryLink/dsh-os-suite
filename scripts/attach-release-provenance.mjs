#!/usr/bin/env node
/**
 * Attach the npm provenance attestations for a GitHub release as one
 * `.intoto.jsonl` asset. OpenSSF Scorecard's Signed-Releases check reads asset
 * filenames, not GitHub's attestation API, so the release needs the file.
 *
 * Triggered by `.github/workflows/release-provenance.yml` on release:published.
 * No secrets are written; the token comes from the workflow's GITHUB_TOKEN.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const repo = process.env.GITHUB_REPOSITORY
const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!repo || !tag || !token) {
  console.error('GITHUB_REPOSITORY, RELEASE_TAG and GITHUB_TOKEN are required')
  process.exit(1)
}
const version = tag.replace(/^v/, '')
const packages = readdirSync('packages')
  .filter((name) => {
    try { return JSON.parse(readFileSync(join('packages', name, 'package.json'), 'utf8')).name } catch { return false }
  })
  .map((name) => JSON.parse(readFileSync(join('packages', name, 'package.json'), 'utf8')).name)

const lines = []
for (const pkg of packages) {
  const res = await fetch(`https://registry.npmjs.org/-/npm/v1/attestations/${pkg}@${version}`)
  if (!res.ok) {
    console.error(`${pkg}@${version}: attestation lookup failed (${res.status})`)
    process.exit(1)
  }
  const body = await res.json()
  for (const attestation of body.attestations || []) {
    const envelope = attestation.bundle?.dsseEnvelope
    if (!envelope) continue
    lines.push(JSON.stringify({
      package: pkg,
      version,
      predicateType: attestation.predicateType,
      dsseEnvelope: envelope,
    }))
  }
  console.log(`${pkg}@${version}: ${(body.attestations || []).length} attestation(s)`)
}
if (lines.length === 0) {
  console.error('no provenance attestations found')
  process.exit(1)
}
const payload = `${lines.join('\n')}\n`
const assetName = `${repo.split('/')[1]}-${tag}.intoto.jsonl`
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
const releaseRes = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers })
if (!releaseRes.ok) {
  console.error(`release ${tag} not found (${releaseRes.status})`)
  process.exit(1)
}
const release = await releaseRes.json()
if ((release.assets || []).some((asset) => asset.name === assetName)) {
  console.log(`asset ${assetName} already present; nothing to do`)
  process.exit(0)
}
const upload = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/x-ndjson' },
  body: payload,
})
if (!upload.ok) {
  console.error(`upload failed (${upload.status}): ${(await upload.text()).slice(0, 300)}`)
  process.exit(1)
}
console.log(`attached ${assetName} (${lines.length} attestations, ${payload.length} bytes)`)
