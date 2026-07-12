import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  conformanceFailures,
  evaluateCoverage,
  loadContract,
  loadSourceManifest,
  loadSupportLedger,
  root
} = require('./platform-contract.cjs')

const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

const reportPath = path.resolve(option('--report', path.join(root, 'artifacts', 'compatibility.json')))
const outputPath = path.resolve(option('--output', path.join(root, 'artifacts', 'platform-coverage.json')))
const contract = loadContract()
const ledger = loadSupportLedger()
const sourceManifest = loadSourceManifest()
const report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
const targetPlatform = option('--platform', report.platform)

const structuralFailures = []
if (contract.chromium.version !== sourceManifest.chromium.version) structuralFailures.push('contract Chromium version differs from source manifest')
if (contract.chromium.revision !== sourceManifest.chromium.revision) structuralFailures.push('contract Chromium revision differs from source manifest')
if (ledger.chromiumRevision !== contract.chromium.revision) structuralFailures.push('support ledger Chromium revision differs from contract')
for (const [key, count] of Object.entries(contract.summary)) {
  if (key !== 'sourceFiles' && key !== 'platforms' && count === 0) structuralFailures.push(`contract denominator ${key} is empty`)
}

const coverage = evaluateCoverage(contract, ledger, report, targetPlatform)
const failures = [...structuralFailures, ...conformanceFailures(coverage)]
coverage.failures = failures
coverage.strictPass = failures.length === 0
await fs.mkdir(path.dirname(outputPath), { recursive: true })
await fs.writeFile(outputPath, `${JSON.stringify(coverage, null, 2)}\n`)

const summary = {
  output: outputPath,
  provider: coverage.provider,
  contract: coverage.contract,
  evidence: Object.fromEntries(Object.entries(coverage.conformanceEvidence).map(([kind, value]) => [kind, {
    total: value.total,
    supported: value.supported.length,
    failing: value.failing.length,
    invalid: value.invalid.length,
    unverified: value.unverified.length
  }])),
  strictPass: coverage.strictPass,
  failures
}
console.log(JSON.stringify(summary, null, 2))
if (structuralFailures.length || (args.includes('--strict') && failures.length)) process.exitCode = 1
