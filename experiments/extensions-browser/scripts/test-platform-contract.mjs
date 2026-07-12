import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  conformanceFailures,
  contractSummary,
  evaluateCoverage,
  loadContract,
  loadElectronChromiumVersion,
  loadSupportLedger,
  parseJSONC,
  parseSchema
} = require('./platform-contract.cjs')

assert.deepEqual(parseJSONC('{ /* block */ "value": [1, 2,], // line\n }', 'fixture'), { value: [1, 2] })

const webIDL = `
  interface OnChangedEvent : ExtensionEvent { static undefined addListener(); };
  interface Demo { static Promise<undefined> run(); static attribute OnChangedEvent onChanged; const long LIMIT = 3; };
  partial interface Browser { static attribute Demo demo; };
`
assert.deepEqual(parseSchema(webIDL, 'demo.webidl'), [{
  namespace: 'demo',
  functions: ['run'],
  events: ['onChanged'],
  properties: ['LIMIT'],
  types: []
}])

const contract = loadContract()
const ledger = loadSupportLedger()
assert.equal(contract.chromium.version, loadElectronChromiumVersion())
assert.equal(ledger.chromiumRevision, contract.chromium.revision)
assert.deepEqual(contract.summary, contractSummary(contract))
assert.equal(new Set(contract.sources.map((source) => source.path)).size, contract.sources.length)
assert.ok(contract.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256)))
assert.ok(contract.summary.sourceFiles >= 200)
assert.ok(contract.summary.namespaces >= 180)
assert.ok(contract.summary.schemaMembers >= 2_000)
assert.ok(contract.summary.apiFeatures >= 270)
assert.ok(contract.summary.manifestFeatures >= 90)
assert.ok(contract.summary.permissionFeatures >= 170)

for (const namespace of ['action', 'alarms', 'declarativeNetRequest', 'offscreen', 'scripting', 'sidePanel', 'tabs', 'webRequest', 'windows']) {
  assert.ok(contract.namespaces[namespace], `missing namespace ${namespace}`)
}
for (const feature of ['action', 'declarativeNetRequest', 'offscreen', 'scripting', 'sidePanel', 'tabs', 'webRequest', 'windows']) {
  assert.ok(contract.features.api[feature], `missing API feature ${feature}`)
}
for (const feature of ['action', 'background.service_worker', 'content_scripts', 'declarative_net_request', 'side_panel']) {
  assert.ok(contract.features.manifest[feature], `missing manifest feature ${feature}`)
}
for (const feature of ['declarativeNetRequest', 'scripting', 'webRequest', 'webRequestBlocking']) {
  assert.ok(contract.features.permission[feature], `missing permission feature ${feature}`)
}

const coverage = evaluateCoverage(contract, ledger, {
  chrome: contract.chromium.version,
  provider: { mode: 'native', nativeConformance: true, injectedAPIs: [] },
  extensions: {}
})
assert.ok(coverage.conformanceEvidence.api.unverified.length > 0)
assert.ok(conformanceFailures(coverage).some((failure) => failure.includes('unverified')))

const unsupportedClaim = structuredClone(ledger)
unsupportedClaim.apiFeatures.action = { status: 'supported', platforms: ['linux'], coverage: 'partial', tests: ['action.test.mjs'] }
const unsupportedClaimCoverage = evaluateCoverage(contract, unsupportedClaim, {
  chrome: contract.chromium.version,
  platform: 'linux',
  provider: { mode: 'native', nativeConformance: true, injectedAPIs: [] },
  extensions: {}
})
assert.ok(unsupportedClaimCoverage.conformanceEvidence.api.unverified.includes('action'))

console.log(JSON.stringify({ chromium: contract.chromium, summary: contract.summary }, null, 2))
