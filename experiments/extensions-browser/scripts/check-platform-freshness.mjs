import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  loadContract,
  loadElectronChromiumVersion,
  loadSourceManifest,
  parseElectronChromiumVersion,
  root
} = require('./platform-contract.cjs')
const { chromiumVersionFromVersionFile, newestTaggedVersion } = require('./platform-freshness.cjs')
const args = process.argv.slice(2)
const contract = loadContract()
const sourceManifest = loadSourceManifest()

async function fetchText(url) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url)
    if (response.ok) return response.text()
    if (response.status !== 429 && response.status < 500) throw new Error(`${response.status} ${response.statusText}: ${url}`)
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)))
  }
  throw new Error(`Retries exhausted: ${url}`)
}

const localElectronPin = loadElectronChromiumVersion()
const upstreamElectronDEPS = await fetchText('https://raw.githubusercontent.com/electron/electron/main/DEPS')
const upstreamElectronPin = parseElectronChromiumVersion(upstreamElectronDEPS, 'electron/electron main DEPS')
const versionFile = Buffer.from(await fetchText(`${sourceManifest.repository}/+/refs/heads/main/chrome/VERSION?format=TEXT`), 'base64').toString('utf8')
const liveTip = chromiumVersionFromVersionFile(versionFile)
const rawRefs = await fetchText(`${sourceManifest.repository}/+refs/tags/?format=JSON`)
const refs = JSON.parse(rawRefs.replace(/^\)\]\}'\n/, ''))
const major = localElectronPin.split('.')[0]
const newestBuildableTag = newestTaggedVersion(refs, major)
const newestBuildableRevision = refs[newestBuildableTag]?.value

const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  electron: {
    localPin: localElectronPin,
    upstreamMainPin: upstreamElectronPin,
    current: localElectronPin === upstreamElectronPin
  },
  contract: {
    version: contract.chromium.version,
    revision: contract.chromium.revision,
    matchesElectronDEPS: contract.chromium.version === localElectronPin
  },
  chromium: {
    newestBuildableTag,
    newestBuildableRevision,
    liveTip,
    liveTipTagged: Boolean(refs[liveTip]),
    rollAvailable: newestBuildableTag !== localElectronPin,
    untaggedTipAhead: liveTip !== newestBuildableTag && !refs[liveTip]
  },
  explicitRoll: newestBuildableTag === localElectronPin ? null : {
    from: localElectronPin,
    to: newestBuildableTag,
    revision: newestBuildableRevision,
    requiredAction: 'Roll Electron DEPS explicitly, sync/apply Chromium patches, then regenerate with platform:update -- --reset-ledger.'
  }
}
const output = path.join(root, 'artifacts', 'platform-freshness.json')
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ output, ...report }, null, 2))
if (args.includes('--strict') && (!report.electron.current || !report.contract.matchesElectronDEPS || report.chromium.rollAvailable)) process.exitCode = 1
