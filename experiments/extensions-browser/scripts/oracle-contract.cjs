const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { loadContract, root } = require('./platform-contract.cjs')

const extensionKeys = {
  2: 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDHGF8EGa8fj46a9ewGUdhQtQ+QLEBV1ITZqsZKwg6hHtjuS1eY0gzw+CuSLaY5jHE7SZCT03/hRMApK7s52laqWgazIADMByqzC56pPyp4SH8j8rjWSIQ2d2iBbhbP3nR44G4NIef4gJyxhvqJtlPjZhm8ZIDzOibyzH5c+h+/wwIDAQAB',
  3: 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDbkAuXVkjb2Mcpnz2cTZ/tHiPFxutU5z/Pdz2DH3QEyPEy5oi7drYa5vJx9ymgwPOzc34ltRB1ufyUlfTCe968uelCRCF4vxbekl2QmZJz+0jQBFmTDxIG8j2/1CNTpppJ/CnIdj0tiZlDzJzetHPTXdoHMHZ3zgoy2dCxxkKfywIDAQAB'
}

function extensionIdFromKey(key) {
  const digest = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)
  return [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join('')
}

function definitions(entries) {
  return entries.flatMap((entry) => Array.isArray(entry.definition) ? entry.definition : [entry.definition])
}

function values(value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function definitionEligible(definition, criteria) {
  if (definition.internal || definition.allowlist || definition.blocklist) return false
  if (definition.location && !['internal', 'unpacked'].includes(definition.location)) return false
  if (definition.channel && definition.channel !== criteria.channel) return false
  if (definition.platforms && !values(definition.platforms).includes(criteria.platform)) return false
  if (definition.extension_types && definition.extension_types !== 'all' && !values(definition.extension_types).includes('extension')) return false
  if (definition.min_manifest_version && criteria.manifestVersion < definition.min_manifest_version) return false
  if (definition.max_manifest_version && criteria.manifestVersion > definition.max_manifest_version) return false
  if (definition.contexts) {
    const contexts = values(definition.contexts)
    if (!contexts.includes('all') && !contexts.includes(criteria.context)) return false
  }
  return true
}

function parentFeature(features, name) {
  const components = name.split('.')
  while (components.length > 1) {
    components.pop()
    const parent = components.join('.')
    if (features[parent]) return parent
  }
  return undefined
}

function featureEligible(features, name, criteria, seen = new Set()) {
  if (seen.has(name)) return false
  const entries = features[name]
  if (!entries) return false
  const candidates = definitions(entries).filter((definition) => definitionEligible(definition, criteria))
  if (!candidates.length) return false
  if (candidates.some((definition) => definition.noparent)) return true
  const parent = parentFeature(features, name)
  if (!parent) return true
  return featureEligible(features, parent, criteria, new Set([...seen, name]))
}

function eligibleFeatures(features, criteria) {
  return Object.keys(features).filter((name) => featureEligible(features, name, criteria)).sort()
}

function dependenciesSatisfied(features, name, criteria, permissions, manifestFeatures, seen = new Set()) {
  if (seen.has(name)) return false
  const candidates = definitions(features[name]).filter((definition) => definitionEligible(definition, criteria))
  const ownSatisfied = candidates.some((definition) => values(definition.dependencies).every((dependency) => {
    const [kind, name] = dependency.split(':', 2)
    if (kind === 'permission') return permissions.has(name)
    if (kind === 'manifest') return manifestFeatures.has(name)
    return true
  }))
  if (!ownSatisfied) return false
  if (candidates.some((definition) => definition.noparent)) return true
  const parent = parentFeature(features, name)
  return !parent || dependenciesSatisfied(features, parent, criteria, permissions, manifestFeatures, new Set([...seen, name]))
}

function buildProbeMatrix(contract, platform, collectorURL) {
  const manifests = {}
  const contexts = {}
  for (const manifestVersion of [2, 3]) {
    const base = { platform, manifestVersion, channel: 'stable' }
    const permissionFeatures = eligibleFeatures(contract.features.permission, { ...base, context: 'privileged_extension' })
    const requestedPermissions = safePermissions(permissionFeatures)
    const manifestFeatures = eligibleFeatures(contract.features.manifest, { ...base, context: 'privileged_extension' })
    const permissionSet = new Set(requestedPermissions)
    const requiredManifestFeatures = manifestVersion === 2
      ? ['background', 'background.persistent', 'background.scripts', 'browser_action', 'content_scripts', 'permissions']
      : ['action', 'background', 'background.service_worker', 'content_scripts', 'host_permissions', 'permissions']
    const appliedManifestFeatures = requiredManifestFeatures.filter((feature) => manifestFeatures.includes(feature))
    const manifestSet = new Set(appliedManifestFeatures)
    manifests[manifestVersion] = { permissionFeatures, requestedPermissions, manifestFeatures, appliedManifestFeatures }
    const descriptors = manifestVersion === 2
      ? [
          ['mv2_background', 'privileged_extension'],
          ['mv2_extension_page', 'privileged_extension'],
          ['mv2_popup', 'privileged_extension'],
          ['mv2_content_script', 'content_script']
        ]
      : [
          ['mv3_service_worker', 'privileged_extension'],
          ['mv3_extension_page', 'privileged_extension'],
          ['mv3_popup', 'privileged_extension'],
          ['mv3_content_script', 'content_script']
        ]
    for (const [name, context] of descriptors) {
      const criteria = { ...base, context }
      const apiFeatures = eligibleFeatures(contract.features.api, criteria)
        .filter((feature) => dependenciesSatisfied(contract.features.api, feature, criteria, permissionSet, manifestSet))
      contexts[name] = { manifestVersion, chromiumContext: context, apiFeatures }
    }
  }
  contexts.ordinary_page = {
    manifestVersion: null,
    chromiumContext: 'web_page',
    apiFeatures: eligibleFeatures(contract.features.api, {
      platform,
      manifestVersion: 3,
      channel: 'stable',
      context: 'web_page'
    })
  }
  return {
    schemaVersion: 1,
    chromium: contract.chromium,
    platform,
    collectorURL,
    extensionIds: {
      mv2: extensionIdFromKey(extensionKeys[2]),
      mv3: extensionIdFromKey(extensionKeys[3])
    },
    manifests,
    contexts
  }
}

function safePermissions(permissionFeatures) {
  return permissionFeatures.filter((permission) => !permission.endsWith('Private') && !permission.includes('Private.') && !permission.startsWith('experimental'))
}

function commonScript(collectorURL) {
  return `(() => {
  const collectorURL = ${JSON.stringify(collectorURL)}
  function surface() {
    const namespaces = Object.keys(globalThis.chrome || {}).sort()
    const members = {}
    for (const namespace of namespaces) {
      members[namespace] = {}
      try {
        for (const member of Object.keys(chrome[namespace] || {}).sort()) {
          try { members[namespace][member] = typeof chrome[namespace][member] }
          catch (error) { members[namespace][member] = '<error:' + error.message + '>' }
        }
      } catch (error) { members[namespace].__error = error.message }
    }
    return { namespaces, members }
  }
  async function test(id, feature, operation) {
    try {
      const result = await operation()
      return { id, feature, status: result === false ? 'fail' : 'pass' }
    } catch (error) {
      return { id, feature, status: 'fail', error: String(error && (error.stack || error.message) || error) }
    }
  }
  async function behavior(context) {
    const manifest = chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest() : null
    const results = [
      await test('runtime.getManifest', 'runtime', () => Boolean(manifest && manifest.manifest_version)),
      await test('runtime.getURL', 'runtime', () => chrome.runtime.getURL('/').startsWith('chrome-extension://' + chrome.runtime.id + '/'))
    ]
    if (chrome.storage && chrome.storage.local) {
      results.push(await test('storage.local.roundtrip', 'storage', async () => {
        const key = '__oracle_' + context
        await chrome.storage.local.set({ [key]: context })
        const value = await chrome.storage.local.get(key)
        await chrome.storage.local.remove(key)
        return value[key] === context
      }))
    }
    if (!context.endsWith('background') && !context.endsWith('service_worker') && chrome.runtime && chrome.runtime.sendMessage) {
      results.push(await test('runtime.sendMessage.roundtrip', 'runtime', async () => {
        const reply = await chrome.runtime.sendMessage({ oracleProbe: true, context })
        return reply && reply.oraclePong === context
      }))
    }
    return results
  }
  async function report(context) {
    const payload = {
      context,
      extensionId: chrome.runtime && chrome.runtime.id,
      manifestVersion: chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().manifest_version : null,
      userAgent: navigator.userAgent,
      surface: surface(),
      behavior: await behavior(context)
    }
    await fetch(collectorURL + '/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  }
  globalThis.oracleProbe = { report }
})()
`
}

async function writeJSON(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function generateProbeFixtures(output, options = {}) {
  const contract = options.contract || loadContract()
  const platform = options.platform || ({ darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform])
  const collectorURL = options.collectorURL
  if (!collectorURL) throw new Error('collectorURL is required')
  if (!contract.targetPlatforms.includes(platform)) throw new Error(`Unsupported probe platform: ${platform}`)
  const matrix = buildProbeMatrix(contract, platform, collectorURL)
  await fs.rm(output, { recursive: true, force: true })
  await fs.mkdir(output, { recursive: true })
  for (const manifestVersion of [2, 3]) {
    const directory = path.join(output, `mv${manifestVersion}`)
    await fs.mkdir(directory, { recursive: true })
    const permissions = matrix.manifests[manifestVersion].requestedPermissions
    const manifest = {
      manifest_version: manifestVersion,
      name: `Chromium oracle MV${manifestVersion}`,
      version: '1.0.0',
      key: extensionKeys[manifestVersion],
      permissions,
      content_scripts: [{
        matches: ['http://127.0.0.1/*'],
        js: ['probe-common.js', 'content.js'],
        run_at: 'document_idle'
      }]
    }
    if (manifestVersion === 2) {
      manifest.background = { scripts: ['probe-common.js', 'background.js'], persistent: true }
      manifest.browser_action = { default_popup: 'probe.html' }
      manifest.permissions = [...permissions, 'http://127.0.0.1/*']
    } else {
      manifest.background = { service_worker: 'service-worker.js' }
      manifest.action = { default_popup: 'probe.html' }
      manifest.host_permissions = ['http://127.0.0.1/*']
    }
    await writeJSON(path.join(directory, 'manifest.json'), manifest)
    await fs.writeFile(path.join(directory, 'probe-common.js'), commonScript(collectorURL))
    const backgroundContext = manifestVersion === 2 ? 'mv2_background' : 'mv3_service_worker'
    const background = `chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {\n  if (!message || !message.oracleProbe) return\n  sendResponse({ oraclePong: message.context })\n})\noracleProbe.report(${JSON.stringify(backgroundContext)})\n`
    await fs.writeFile(path.join(directory, manifestVersion === 2 ? 'background.js' : 'service-worker.js'), manifestVersion === 2 ? background : `importScripts('probe-common.js')\n${background}`)
    await fs.writeFile(path.join(directory, 'content.js'), `oracleProbe.report('mv${manifestVersion}_content_script')\n`)
    await fs.writeFile(path.join(directory, 'probe.js'), `oracleProbe.report(new URLSearchParams(location.search).get('context') || 'mv${manifestVersion}_extension_page')\n`)
    await fs.writeFile(path.join(directory, 'probe.html'), '<!doctype html><meta charset="utf-8"><title>Chromium oracle probe</title><script src="probe-common.js"></script><script defer src="probe.js"></script>\n')
  }
  await writeJSON(path.join(output, 'matrix.json'), matrix)
  return matrix
}

module.exports = {
  buildProbeMatrix,
  definitionEligible,
  eligibleFeatures,
  extensionIdFromKey,
  extensionKeys,
  generateProbeFixtures,
  root
}
