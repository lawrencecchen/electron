import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { gunzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const { createContract, loadElectronChromiumVersion, loadSourceManifest, root } = require('./platform-contract.cjs')
const configuredSourceManifest = loadSourceManifest()
const args = process.argv.slice(2)

function option(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function featureKind(filename) {
  for (const [kind, prefix] of Object.entries(configuredSourceManifest.featureFiles)) {
    if (filename.startsWith(prefix) && filename.endsWith('.json')) return kind
  }
  return undefined
}

function isSchema(filename) {
  return configuredSourceManifest.schemaExtensions.some((extension) => filename.endsWith(extension))
}

async function directoryExists(directory) {
  try {
    return (await fs.stat(directory)).isDirectory()
  } catch {
    return false
  }
}

async function findChromiumRoot() {
  const candidates = [
    option('--chromium-root'),
    process.env.CHROMIUM_SRC,
    path.resolve(root, '..', '..', '..')
  ].filter(Boolean).map((candidate) => path.resolve(candidate))
  for (const candidate of candidates) {
    if (await directoryExists(path.join(candidate, 'chrome', 'common', 'extensions', 'api')) &&
        await directoryExists(path.join(candidate, 'extensions', 'common', 'api'))) return candidate
  }
  return undefined
}

async function readDirectorySources(chromiumRoot, prefix = '') {
  const sources = []
  for (const apiRoot of configuredSourceManifest.roots) {
    const directory = path.join(chromiumRoot, prefix, apiRoot)
    if (!await directoryExists(directory)) continue
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !isSchema(entry.name)) continue
      const relativePath = path.posix.join(prefix.split(path.sep).join('/'), apiRoot, entry.name).replace(/^\//, '')
      sources.push({
        path: relativePath,
        content: await fs.readFile(path.join(directory, entry.name), 'utf8'),
        kind: featureKind(entry.name),
        override: entry.name.includes('.override.')
      })
    }
  }
  return sources
}

async function readLocalSources(chromiumRoot) {
  const sources = await readDirectorySources(chromiumRoot)
  const outRoot = path.join(chromiumRoot, 'out')
  if (await directoryExists(outRoot)) {
    for (const entry of await fs.readdir(outRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      sources.push(...await readDirectorySources(chromiumRoot, path.join('out', entry.name, 'gen')))
    }
  }
  const deduplicated = new Map()
  for (const source of sources) deduplicated.set(`${source.path}:${source.kind || 'schema'}`, source)
  return [...deduplicated.values()].sort((left, right) => left.path.localeCompare(right.path))
}

async function fetchResponse(url) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url)
    if (response.ok) return response
    if (response.status !== 429 && response.status < 500) {
      throw new Error(`${response.status} ${response.statusText}: ${url}`)
    }
    const retryAfter = Number(response.headers.get('retry-after'))
    const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * (2 ** attempt)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(`Retries exhausted: ${url}`)
}

async function fetchBuffer(url) {
  const response = await fetchResponse(url)
  return Buffer.from(await response.arrayBuffer())
}

function readTarArchive(compressed) {
  const archive = gunzipSync(compressed)
  const files = []
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((value) => value === 0)) break
    const readField = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '')
    const name = readField(0, 100)
    const prefix = readField(345, 155)
    const filename = prefix ? `${prefix}/${name}` : name
    const size = Number.parseInt(readField(124, 12).trim() || '0', 8)
    const type = readField(156, 1)
    offset += 512
    if (type === '' || type === '0') files.push({ name: filename, content: archive.subarray(offset, offset + size).toString('utf8') })
    offset += Math.ceil(size / 512) * 512
  }
  return files
}

async function readRemoteSources() {
  const sources = []
  for (const apiRoot of configuredSourceManifest.roots) {
    const archive = await fetchBuffer(`${configuredSourceManifest.repository}/+archive/${sourceManifest.chromium.revision}/${apiRoot}.tar.gz`)
    for (const entry of readTarArchive(archive)) {
      if (entry.name.includes('/') || !isSchema(entry.name)) continue
      sources.push({
        path: `${apiRoot}/${entry.name}`,
        content: entry.content,
        kind: featureKind(entry.name),
        override: entry.name.includes('.override.')
      })
    }
  }
  return sources.sort((left, right) => left.path.localeCompare(right.path))
}

async function resolveChromiumRevision(version) {
  const response = await fetchResponse(`${configuredSourceManifest.repository}/+refs/tags/${version}?format=JSON`)
  const payload = JSON.parse((await response.text()).replace(/^\)\]\}'\n/, ''))
  const revision = payload[`refs/tags/${version}`]?.value
  if (!revision) throw new Error(`Chromium tag ${version} has no exact revision`)
  return revision
}

function localRevision(chromiumRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: chromiumRoot, encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}

const forceRemote = args.includes('--remote')
const chromiumVersion = loadElectronChromiumVersion()
const chromiumRevision = await resolveChromiumRevision(chromiumVersion)
const sourceManifest = {
  ...configuredSourceManifest,
  chromium: {
    version: chromiumVersion,
    revision: chromiumRevision,
    pinSource: configuredSourceManifest.electronDeps
  }
}
const chromiumRoot = forceRemote ? undefined : await findChromiumRoot()
const sources = chromiumRoot ? await readLocalSources(chromiumRoot) : await readRemoteSources()
const mode = chromiumRoot ? 'chromium-checkout' : 'pinned-gitiles-fallback'
const contract = createContract(sourceManifest, sources, mode)
if (chromiumRoot) {
  contract.chromium.checkoutRevision = localRevision(chromiumRoot)
}
const output = path.resolve(option('--output') || path.join(root, 'platform', sourceManifest.snapshot))
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, `${JSON.stringify(contract, null, 2)}\n`)
if (args.includes('--reset-ledger')) {
  const ledger = {
    schemaVersion: 1,
    chromiumRevision,
    apiFeatures: {},
    manifestFeatures: {},
    permissionFeatures: {},
    behaviorFeatures: {}
  }
  await fs.writeFile(path.join(root, 'platform', 'support-ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`)
}
console.log(JSON.stringify({ output, mode, chromium: contract.chromium, summary: contract.summary }, null, 2))
