import assert from 'node:assert/strict'

import {
  canonicalJSONString,
  decodeProbeTitle,
  extensionIdFromKey,
  legacyMV2OverrideArguments,
  matchFixtures,
  parseBrowserRevision,
  parseDevToolsActivePort
} from './run-chromium-webui-oracle.mjs'

const key = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuWlXrHbU4hxvIcDjU0sHO656loD/yj6TGeu0mYPo65oxAiqquEU6q7YcMP6IoKNq6iF7+ibvUtaAeuNGAVng/hhtd6mUTrueIzWrLYxef5uXfudjc2Gx85CTmaAlGwXLz7jDoDw2itrxm+q93kxgA3C873s6kLjo57lGeBHQkUF8SmE4fxCCiIfCN12d/l0KtivIxJ7Vx05Ep2/ZahZyyIg79oYigRvsrtQT8AMM6L6r0CpULD4NDKtoZZsf2unJrH856UBT0T9u81Zef83dwwUDVFXCj97u3W+Svb11tXfdQFG1TXLDuaKAYjh4b7aC/o636M596GA8mOFQAaA0IwIDAQAB'
assert.equal(extensionIdFromKey(key), 'pgbgbjeeogkcjkafklffklbidjndeadj')

assert.deepEqual(parseDevToolsActivePort('43125\n/devtools/browser/example\n'), {
  browserPath: '/devtools/browser/example',
  port: 43125
})
assert.throws(() => parseDevToolsActivePort('0\n/devtools/browser/example\n'), /invalid port/)
assert.equal(parseBrowserRevision('@204b1fd0d2d1ae8eac84fa6e3169e198b159d5d2'), '204b1fd0d2d1ae8eac84fa6e3169e198b159d5d2')
assert.throws(() => parseBrowserRevision('@not-a-revision'), /invalid source revision/)

const report = {
  extensions: [{ enabled: true, id: 'fixture-id', name: 'Fixture', version: '1.2.3' }],
  platform: { arch: 'x86-64', nacl_arch: 'x86-64', os: 'linux' }
}
const title = `ORACLE_READY:${Buffer.from(JSON.stringify(report)).toString('base64')}`
assert.deepEqual(decodeProbeTitle(title), { status: 'ready', value: report })
assert.equal(decodeProbeTitle('ORACLE_PENDING'), undefined)

assert.deepEqual(matchFixtures([{
  displayName: 'Fixture',
  label: 'fixture',
  manifestVersion: 3,
  version: '1.2.3'
}], report.extensions, '152.0.7946.0'), [{
  displayName: 'Fixture',
  enabled: true,
  expectedStatus: 'loaded',
  expectationMet: true,
  expectationReason: 'fixture uses a supported manifest generation',
  id: 'fixture-id',
  installType: undefined,
  label: 'fixture',
  manifestVersion: 3,
  requested: true,
  status: 'loaded',
  type: undefined,
  version: '1.2.3'
}])

const mv2Result = matchFixtures([{
  displayName: 'uBlock Origin',
  label: 'ublock',
  manifestVersion: 2,
  version: '1.72.2'
}], [], '152.0.7946.0')[0]
assert.equal(mv2Result.status, 'not-loaded')
assert.equal(mv2Result.expectedStatus, 'not-loaded')
assert.equal(mv2Result.expectationMet, true)
assert.deepEqual(legacyMV2OverrideArguments([
  '--allow-legacy-extension-manifests',
  '--disable-features=OtherFeature,ExtensionManifestV2Unsupported',
  '--enable-features=Webium'
]), [
  '--allow-legacy-extension-manifests',
  '--disable-features=OtherFeature,ExtensionManifestV2Unsupported'
])

assert.equal(canonicalJSONString({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}')
assert.equal(canonicalJSONString({ kept: true, omitted: undefined }), '{"kept":true}')

console.log(JSON.stringify({ oracleProbeId: extensionIdFromKey(key), tests: 'passed' }, null, 2))
