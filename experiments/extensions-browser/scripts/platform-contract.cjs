const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function loadSourceManifest() {
  return readJSON(path.join(root, 'platform', 'source-manifest.json'))
}

function loadContract() {
  const sourceManifest = loadSourceManifest()
  return readJSON(path.join(root, 'platform', sourceManifest.snapshot))
}

function loadSupportLedger() {
  return readJSON(path.join(root, 'platform', 'support-ledger.json'))
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function stripJSONComments(value) {
  let output = ''
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]
    const next = value[index + 1]
    if (lineComment) {
      if (current === '\n') {
        lineComment = false
        output += current
      }
      continue
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false
        index += 1
      } else if (current === '\n') {
        output += current
      }
      continue
    }
    if (inString) {
      output += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') inString = false
      continue
    }
    if (current === '"') {
      inString = true
      output += current
    } else if (current === '/' && next === '/') {
      lineComment = true
      index += 1
    } else if (current === '/' && next === '*') {
      blockComment = true
      index += 1
    } else {
      output += current
    }
  }
  return output
}

function stripTrailingCommas(value) {
  let output = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]
    if (inString) {
      output += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') inString = false
      continue
    }
    if (current === '"') {
      inString = true
      output += current
      continue
    }
    if (current === ',') {
      let lookahead = index + 1
      while (/\s/.test(value[lookahead] || '')) lookahead += 1
      if (value[lookahead] === '}' || value[lookahead] === ']') continue
    }
    output += current
  }
  return output
}

function parseJSONC(value, source) {
  try {
    return JSON.parse(stripTrailingCommas(stripJSONComments(value)))
  } catch (error) {
    throw new Error(`Unable to parse Chromium schema ${source}: ${error.message}`)
  }
}

function uniqueSorted(values) {
  return [...new Set(values)].sort()
}

function parseJSONSchema(value, source) {
  const parsed = parseJSONC(value, source)
  const schemas = Array.isArray(parsed) ? parsed : [parsed]
  return schemas.filter((schema) => schema && typeof schema.namespace === 'string').map((schema) => ({
    namespace: schema.namespace,
    functions: uniqueSorted((schema.functions || []).map((item) => item.name).filter(Boolean)),
    events: uniqueSorted((schema.events || []).map((item) => item.name).filter(Boolean)),
    properties: uniqueSorted(Object.keys(schema.properties || {})),
    types: uniqueSorted((schema.types || []).map((item) => item.id).filter(Boolean))
  }))
}

function parseIDLInterfaceMembers(body) {
  const members = []
  for (const declaration of body.split(';')) {
    const normalized = declaration.replace(/\[[\s\S]*?\]/g, ' ')
    const openParen = normalized.indexOf('(')
    if (openParen === -1) continue
    const prefix = normalized.slice(0, openParen)
    const identifiers = prefix.match(/[A-Za-z_$][\w$]*/g) || []
    const name = identifiers.at(-1)
    if (name && !['constructor', 'callback'].includes(name)) members.push(name)
  }
  return uniqueSorted(members)
}

function parseIDLAttributes(body) {
  const attributes = []
  for (const declaration of body.split(';')) {
    if (!/\battribute\b/.test(declaration)) continue
    const normalized = declaration.replace(/\[[\s\S]*?\]/g, ' ')
    const match = normalized.match(/\battribute\s+([A-Za-z_$][\w$]*)\s+([A-Za-z_$][\w$]*)\s*$/)
    if (match) attributes.push({ type: match[1], name: match[2] })
  }
  return attributes
}

function parseIDLConstants(body) {
  const constants = []
  for (const declaration of body.split(';')) {
    const normalized = declaration.replace(/\[[\s\S]*?\]/g, ' ')
    const match = normalized.match(/\bconst\s+[^=]+?\s+([A-Za-z_$][\w$]*)\s*=/)
    if (match) constants.push(match[1])
  }
  return uniqueSorted(constants)
}

function parseIDLSchema(value) {
  const source = stripJSONComments(value)
  const namespaces = [...source.matchAll(/\bnamespace\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[{;]/g)]
    .map((match) => match[1])
  const interfaces = new Map()
  const interfacePattern = /\b(?:partial\s+)?interface\s+([A-Za-z_$][\w$]*)\s*(?::[^\{]+)?\{([\s\S]*?)\}\s*;/g
  for (const match of source.matchAll(interfacePattern)) {
    const item = interfaces.get(match[1]) || { functions: [], attributes: [], constants: [] }
    item.functions.push(...parseIDLInterfaceMembers(match[2]))
    item.attributes.push(...parseIDLAttributes(match[2]))
    item.constants.push(...parseIDLConstants(match[2]))
    interfaces.set(match[1], item)
  }

  if (namespaces.length) {
    const functions = interfaces.get('Functions')?.functions || []
    const eventsInterface = interfaces.get('Events') || { functions: [], attributes: [] }
    const events = [...eventsInterface.functions, ...eventsInterface.attributes.map((attribute) => attribute.name)]
    const propertiesInterface = interfaces.get('Properties') || { attributes: [], constants: [] }
    const properties = [...propertiesInterface.attributes.map((attribute) => attribute.name), ...propertiesInterface.constants]
    return uniqueSorted(namespaces).map((namespace) => ({
      namespace,
      functions: uniqueSorted(functions),
      events: uniqueSorted(events),
      properties: uniqueSorted(properties),
      types: []
    }))
  }

  const browser = interfaces.get('Browser')
  if (!browser) return []
  const schemas = new Map()
  function visit(namespace, interfaceName, visited) {
    if (visited.has(interfaceName)) return
    const definition = interfaces.get(interfaceName)
    if (!definition) return
    const nextVisited = new Set([...visited, interfaceName])
    const schema = schemas.get(namespace) || { namespace, functions: [], events: [], properties: [], types: [] }
    schema.functions.push(...definition.functions)
    schema.properties.push(...definition.constants)
    for (const attribute of definition.attributes) {
      if (/^on[A-Z]/.test(attribute.name)) schema.events.push(attribute.name)
      else if (interfaces.has(attribute.type)) visit(`${namespace}.${attribute.name}`, attribute.type, nextVisited)
      else schema.properties.push(attribute.name)
    }
    schemas.set(namespace, schema)
  }
  for (const attribute of browser.attributes) visit(attribute.name, attribute.type, new Set(['Browser']))
  return [...schemas.values()].map((schema) => ({
    ...schema,
    functions: uniqueSorted(schema.functions),
    events: uniqueSorted(schema.events),
    properties: uniqueSorted(schema.properties)
  }))
}

function parseSchema(value, source) {
  if (source.endsWith('.json')) return parseJSONSchema(value, source)
  return parseIDLSchema(value)
}

function summarizeFeatures(featureSources) {
  const result = { api: {}, manifest: {}, permission: {}, behavior: {} }
  for (const source of featureSources) {
    const parsed = parseJSONC(source.content, source.path)
    for (const [name, definition] of Object.entries(parsed)) {
      result[source.kind][name] ||= []
      result[source.kind][name].push({
        source: source.path,
        override: source.override,
        definition
      })
    }
  }
  for (const entries of Object.values(result)) {
    for (const name of Object.keys(entries)) entries[name].sort((left, right) => left.source.localeCompare(right.source))
  }
  return result
}

function summarizeSchemas(schemaSources) {
  const namespaces = {}
  for (const source of schemaSources) {
    for (const schema of parseSchema(source.content, source.path)) {
      namespaces[schema.namespace] ||= {
        functions: [],
        events: [],
        properties: [],
        types: [],
        sources: []
      }
      const target = namespaces[schema.namespace]
      for (const key of ['functions', 'events', 'properties', 'types']) {
        target[key] = uniqueSorted([...target[key], ...schema[key]])
      }
      target.sources = uniqueSorted([...target.sources, source.path])
    }
  }
  return Object.fromEntries(Object.entries(namespaces).sort(([left], [right]) => left.localeCompare(right)))
}

function schemaMemberPaths(namespaces) {
  const members = []
  for (const [namespace, schema] of Object.entries(namespaces)) {
    members.push(namespace)
    for (const key of ['functions', 'events', 'properties']) {
      for (const member of schema[key]) members.push(`${namespace}.${member}`)
    }
  }
  return uniqueSorted(members)
}

function contractSummary(contract) {
  const summary = {
    namespaces: Object.keys(contract.namespaces).length,
    schemaMembers: contract.schemaMembers.length,
    apiFeatures: Object.keys(contract.features.api).length,
    manifestFeatures: Object.keys(contract.features.manifest).length,
    permissionFeatures: Object.keys(contract.features.permission).length,
    behaviorFeatures: Object.keys(contract.features.behavior).length,
    sourceFiles: contract.sources.length
  }
  summary.platforms = Object.fromEntries(contract.targetPlatforms.map((platform) => [platform, platformSummary(contract, platform)]))
  return summary
}

function featureDefinitions(entries) {
  return entries.flatMap((entry) => Array.isArray(entry.definition) ? entry.definition : [entry.definition])
}

function featureApplies(entries, platform) {
  return featureDefinitions(entries).some((definition) => !definition.platforms || definition.platforms.includes(platform))
}

function featureNamesForPlatform(contract, key, platform) {
  return Object.entries(contract.features[key])
    .filter(([, entries]) => featureApplies(entries, platform))
    .map(([name]) => name)
    .sort()
}

function platformSummary(contract, platform) {
  return {
    apiFeatures: featureNamesForPlatform(contract, 'api', platform).length,
    manifestFeatures: featureNamesForPlatform(contract, 'manifest', platform).length,
    permissionFeatures: featureNamesForPlatform(contract, 'permission', platform).length,
    behaviorFeatures: featureNamesForPlatform(contract, 'behavior', platform).length
  }
}

function createContract(sourceManifest, sources, mode) {
  const featureSources = sources.filter((source) => source.kind)
  const schemaSources = sources.filter((source) => !source.kind && !path.basename(source.path).startsWith('_'))
  const namespaces = summarizeSchemas(schemaSources)
  const contract = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generationMode: mode,
    chromium: sourceManifest.chromium,
    repository: sourceManifest.repository,
    roots: sourceManifest.roots,
    targetPlatforms: sourceManifest.targetPlatforms,
    sources: sources.map((source) => ({ path: source.path, sha256: sha256(source.content) })),
    namespaces,
    schemaMembers: schemaMemberPaths(namespaces),
    features: summarizeFeatures(featureSources)
  }
  contract.summary = contractSummary(contract)
  return contract
}

function observedPaths(inventories) {
  const paths = new Set()
  for (const inventory of inventories) {
    for (const namespace of inventory?.namespaces || []) paths.add(namespace)
    for (const [namespace, members] of Object.entries(inventory?.members || {})) {
      paths.add(namespace)
      for (const member of members) paths.add(`${namespace}.${member}`)
    }
  }
  return paths
}

function evidenceSummary(contract, ledger, key, platform) {
  const contractNames = featureNamesForPlatform(contract, key, platform)
  const ledgerKey = `${key}Features`
  const evidence = ledger[ledgerKey] || {}
  const applies = (entry) => Array.isArray(entry?.platforms) && entry.platforms.includes(platform)
  const supported = contractNames.filter((name) => applies(evidence[name]) && evidence[name].status === 'supported' && Array.isArray(evidence[name].tests) && evidence[name].tests.length > 0)
  const failing = contractNames.filter((name) => applies(evidence[name]) && evidence[name].status === 'failing')
  const unverified = contractNames.filter((name) => !applies(evidence[name]) || !['supported', 'failing'].includes(evidence[name].status))
  const invalid = contractNames.filter((name) => applies(evidence[name]) && evidence[name].status === 'supported' && (!Array.isArray(evidence[name].tests) || evidence[name].tests.length === 0))
  return { total: contractNames.length, supported, failing, invalid, unverified: uniqueSorted([...unverified, ...invalid]) }
}

function evaluateCoverage(contract, ledger, report, requestedPlatform) {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' }
  const platform = requestedPlatform || report.platform || platformMap[process.platform]
  if (!contract.targetPlatforms.includes(platform)) throw new Error(`Unsupported conformance platform: ${platform}`)
  const inventories = Object.values(report.extensions || {}).map((extension) => extension.api).filter(Boolean)
  const observed = observedPaths(inventories)
  const observedSchemaMembers = contract.schemaMembers.filter((member) => observed.has(member))
  const missingSchemaMembers = contract.schemaMembers.filter((member) => !observed.has(member))
  const observedAPIFeatures = Object.keys(contract.features.api).filter((feature) => observed.has(feature)).sort()
  const unobservedAPIFeatures = Object.keys(contract.features.api).filter((feature) => !observed.has(feature)).sort()
  return {
    contract: {
      chromium: contract.chromium,
      runtimeChrome: report.chrome,
      runtimeVersionMatches: report.chrome === contract.chromium.version,
      targetPlatform: platform,
      denominator: contract.summary.platforms[platform],
      fullDenominator: contract.summary
    },
    provider: report.provider,
    runtimeObservation: {
      conclusive: false,
      reason: 'Chrome exposes APIs by permission, manifest version, extension type, context, channel, platform, policy, and allowlist. Canary visibility is diagnostic and is not conformance evidence.',
      schemaMembers: {
        total: contract.schemaMembers.length,
        observed: observedSchemaMembers,
        notObserved: missingSchemaMembers
      },
      apiFeatures: {
        total: Object.keys(contract.features.api).length,
        observed: observedAPIFeatures,
        notObserved: unobservedAPIFeatures
      }
    },
    conformanceEvidence: {
      api: evidenceSummary(contract, ledger, 'api', platform),
      manifest: evidenceSummary(contract, ledger, 'manifest', platform),
      permission: evidenceSummary(contract, ledger, 'permission', platform),
      behavior: evidenceSummary(contract, ledger, 'behavior', platform)
    }
  }
}

function conformanceFailures(coverage) {
  const failures = []
  if (!coverage.contract.runtimeVersionMatches) {
    failures.push(`runtime Chromium ${coverage.contract.runtimeChrome} does not match contract ${coverage.contract.chromium.version}`)
  }
  if (coverage.provider?.mode !== 'native') failures.push('provider mode is not native')
  for (const [kind, result] of Object.entries(coverage.conformanceEvidence)) {
    if (result.invalid.length) failures.push(`${kind}: ${result.invalid.length} supported claim(s) have no test evidence`)
    if (result.failing.length) failures.push(`${kind}: ${result.failing.length} failing feature(s)`)
    if (result.unverified.length) failures.push(`${kind}: ${result.unverified.length} unverified feature(s)`)
  }
  return failures
}

module.exports = {
  conformanceFailures,
  contractSummary,
  createContract,
  evaluateCoverage,
  featureNamesForPlatform,
  loadContract,
  loadSourceManifest,
  loadSupportLedger,
  parseJSONC,
  parseSchema,
  root,
  sha256
}
