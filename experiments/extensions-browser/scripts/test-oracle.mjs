import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  buildProbeMatrix,
  extensionIdFromKey,
  extensionKeys,
  generateProbeFixtures,
  root
} = require('./oracle-contract.cjs')
const { behaviorDifferences, surfaceDifference } = require('./oracle-diff.cjs')
const { loadContract } = require('./platform-contract.cjs')
const { chromiumVersionFromVersionFile, compareChromiumVersions, newestTaggedVersion } = require('./platform-freshness.cjs')

const contract = loadContract()
const matrix = buildProbeMatrix(contract, 'linux', 'http://127.0.0.1:12345')
assert.deepEqual(Object.keys(matrix.contexts).sort(), [
  'mv2_background',
  'mv2_content_script',
  'mv2_extension_page',
  'mv2_popup',
  'mv3_content_script',
  'mv3_extension_page',
  'mv3_popup',
  'mv3_service_worker',
  'ordinary_page'
])
assert.equal(matrix.extensionIds.mv2, extensionIdFromKey(extensionKeys[2]))
assert.equal(matrix.extensionIds.mv3, extensionIdFromKey(extensionKeys[3]))
assert.notEqual(matrix.extensionIds.mv2, matrix.extensionIds.mv3)
assert.ok(matrix.contexts.mv3_service_worker.apiFeatures.includes('runtime'))
assert.ok(matrix.contexts.mv3_content_script.apiFeatures.includes('storage'))
assert.ok(!matrix.contexts.mv3_content_script.apiFeatures.includes('downloads'))

const fixtureRoot = path.join(root, '.generated', 'oracle-test')
await generateProbeFixtures(fixtureRoot, { contract, platform: 'linux', collectorURL: 'http://127.0.0.1:12345' })
const mv2 = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'mv2', 'manifest.json'), 'utf8'))
const mv3 = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'mv3', 'manifest.json'), 'utf8'))
assert.equal(mv2.manifest_version, 2)
assert.ok(mv2.background.scripts.includes('background.js'))
assert.equal(mv3.manifest_version, 3)
assert.equal(mv3.background.service_worker, 'service-worker.js')
assert.ok(mv3.host_permissions.includes('http://127.0.0.1/*'))

const surface = surfaceDifference(
  { surface: { namespaces: ['runtime'], members: { runtime: { getURL: 'function' } } } },
  { surface: { namespaces: ['runtime'], members: { runtime: { getURL: 'undefined', id: 'string' } } } }
)
assert.equal(surface.evidenceEligible, false)
assert.deepEqual(surface.added, ['runtime.id'])
assert.deepEqual(surface.typeChanged, [{ path: 'runtime.getURL', chromium: 'function', electron: 'undefined' }])

const behavior = behaviorDifferences(
  { behavior: [{ id: 'runtime.getURL', feature: 'runtime', status: 'pass' }] },
  { behavior: [{ id: 'runtime.getURL', feature: 'runtime', status: 'pass' }] },
  true
)
assert.equal(behavior[0].evidenceCandidate, true)
assert.equal(behavior[0].coverage, 'partial')
assert.equal(behaviorDifferences({ behavior: behavior[0].chromium ? [behavior[0].chromium] : [] }, { behavior: [behavior[0].electron] }, false)[0].evidenceCandidate, false)

assert.equal(chromiumVersionFromVersionFile('MAJOR=152\nMINOR=0\nBUILD=7946\nPATCH=0\n'), '152.0.7946.0')
assert.ok(compareChromiumVersions('152.0.7945.0', '152.0.7946.0') < 0)
assert.equal(newestTaggedVersion({ '152.0.7944.0': {}, '152.0.7945.0': {}, '152.0.7945.1': {}, '151.0.1.0': {} }, '152'), '152.0.7945.0')

await fs.rm(fixtureRoot, { recursive: true, force: true })
console.log(JSON.stringify({ chromium: contract.chromium, contexts: Object.keys(matrix.contexts), extensionIds: matrix.extensionIds }, null, 2))
