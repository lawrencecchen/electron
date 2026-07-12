import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { generateProbeFixtures, root } = require('./oracle-contract.cjs')
const { behaviorDifferences, surfaceDifference } = require('./oracle-diff.cjs')
const { loadContract } = require('./platform-contract.cjs')
const args = process.argv.slice(2)

function option(name, fallback) {
  const direct = args.find((argument) => argument.startsWith(`${name}=`))
  if (direct) return direct.slice(name.length + 1)
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

const chromiumBinary = option('--chromium-binary')
if (!chromiumBinary) throw new Error('--chromium-binary is required')
const electronBinary = option('--electron-binary', require('electron'))
const platform = option('--platform', { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform])
const timeoutMs = Number(option('--timeout-ms', '20000'))
const headed = args.includes('--headed')
const noSandbox = args.includes('--no-sandbox')
const allowVersionMismatch = args.includes('--allow-version-mismatch')
const output = path.resolve(option('--output', path.join(root, 'artifacts', 'chromium-oracle.json')))
const generatedRoot = path.resolve(option('--fixture-root', path.join(root, '.generated', 'oracle-probes')))
const profileRoot = path.join(root, '.generated', 'oracle-profiles', `${Date.now()}-${process.pid}`)
const contract = loadContract()

function chromeVersion(value) {
  return value?.match(/(?:Chrome|Chromium)\/(\d+\.\d+\.\d+\.\d+)/)?.[1] ||
    value?.match(/(?:Chrome|Chromium)(?: for Testing)?\s+(\d+\.\d+\.\d+\.\d+)/)?.[1]
}

function binaryVersion(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.trim() }
}

function ordinaryPage(collectorURL) {
  return `<!doctype html><meta charset="utf-8"><title>Chromium oracle ordinary page</title><script>
  (() => {
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
    const hasPrivilegedRuntime = Boolean(globalThis.chrome && chrome.runtime && chrome.runtime.id)
    fetch(${JSON.stringify(collectorURL)} + '/report', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: 'ordinary_page', manifestVersion: null, userAgent: navigator.userAgent,
        surface: { namespaces, members },
        behavior: [{ id: 'ordinary.noPrivilegedRuntime', feature: null, status: hasPrivilegedRuntime ? 'fail' : 'pass' }]
      })
    })
  })()
  </script>`
}

function createCollector() {
  const reports = { chromium: new Map(), electron: new Map() }
  let activeEngine
  let pageHTML = ''
  const server = http.createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', '*')
    response.setHeader('access-control-allow-headers', 'content-type')
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    if (request.url === '/page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(pageHTML)
      return
    }
    if (request.url === '/report' && request.method === 'POST') {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 8 * 1024 * 1024) {
          response.writeHead(413)
          response.end()
          return
        }
        chunks.push(chunk)
      }
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!activeEngine || !reports[activeEngine]) throw new Error('no active engine')
        reports[activeEngine].set(payload.context, { ...payload, receivedAt: new Date().toISOString() })
        response.writeHead(204)
      } catch (error) {
        response.writeHead(400, { 'content-type': 'text/plain' })
        response.end(error.message)
        return
      }
      response.end()
      return
    }
    response.writeHead(404)
    response.end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`
      pageHTML = ordinaryPage(url)
      resolve({
        url,
        reports,
        setActiveEngine: (engine) => { activeEngine = engine },
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

function launch(binary, launchArgs) {
  const child = spawn(binary, launchArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      output.push(chunk.toString())
      if (output.join('').length > 2_000_000) output.shift()
    })
  }
  return { child, output }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'])
    return
  }
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

async function waitForReports(engineReports, expected, child) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (expected.every((context) => engineReports.has(context))) break
    if (child.exitCode !== null || child.signalCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return expected.filter((context) => !engineReports.has(context))
}

async function waitForDevToolsPort(profile, child) {
  const file = path.join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Chromium exited before DevTools started')
    try {
      const [port] = (await fs.readFile(file, 'utf8')).split(/\r?\n/)
      if (/^\d+$/.test(port)) return Number(port)
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for Chromium DevToolsActivePort')
}

async function openChromeTarget(port, url) {
  let lastError
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
      if (response.ok) return
      lastError = new Error(`${response.status} ${await response.text()}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Unable to open Chromium target ${url}: ${lastError?.message}`)
}

const preflight = {
  chromium: binaryVersion(chromiumBinary),
  electron: binaryVersion(electronBinary)
}
const suppliedChromiumVersion = chromeVersion(preflight.chromium.output)
if (!allowVersionMismatch && suppliedChromiumVersion !== contract.chromium.version) {
  throw new Error(`Chromium oracle ${suppliedChromiumVersion || preflight.chromium.output} does not match Electron DEPS ${contract.chromium.version}`)
}

await fs.mkdir(path.dirname(output), { recursive: true })
await fs.mkdir(profileRoot, { recursive: true })
const collector = await createCollector()
const matrix = await generateProbeFixtures(generatedRoot, { contract, platform, collectorURL: collector.url })
const expected = Object.keys(matrix.contexts).sort()
const extensionPaths = [path.join(generatedRoot, 'mv2'), path.join(generatedRoot, 'mv3')]
const extensionURLs = [2, 3].flatMap((manifestVersion) => {
  const id = matrix.extensionIds[`mv${manifestVersion}`]
  return [
    `chrome-extension://${id}/probe.html?context=mv${manifestVersion}_extension_page`,
    `chrome-extension://${id}/probe.html?context=mv${manifestVersion}_popup`
  ]
})
const engines = {}
const runningProcesses = []

try {
  collector.setActiveEngine('chromium')
  const chromiumProfile = path.join(profileRoot, 'chromium')
  const chromium = launch(chromiumBinary, [
    `--user-data-dir=${chromiumProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--allow-legacy-extension-manifests',
    '--remote-debugging-port=0',
    `--disable-extensions-except=${extensionPaths.join(',')}`,
    `--load-extension=${extensionPaths.join(',')}`,
    '--disable-features=ExtensionManifestV2Disabled,ExtensionManifestV2Unsupported',
    ...(noSandbox ? ['--no-sandbox'] : []),
    ...(headed ? [] : ['--headless=new']),
    `${collector.url}/page`
  ])
  runningProcesses.push(chromium.child)
  const devToolsPort = await waitForDevToolsPort(chromiumProfile, chromium.child)
  for (const url of extensionURLs) await openChromeTarget(devToolsPort, url)
  const chromiumMissing = await waitForReports(collector.reports.chromium, expected, chromium.child)
  await stopProcess(chromium.child)
  engines.chromium = {
    command: chromiumBinary,
    versionOutput: preflight.chromium.output,
    exitCode: chromium.child.exitCode,
    missingContexts: chromiumMissing,
    output: chromium.output.join('')
  }

  collector.setActiveEngine('electron')
  const electron = launch(electronBinary, [
    ...(noSandbox ? ['--no-sandbox'] : []),
    path.join(root, 'scripts', 'oracle-electron-main.cjs'),
    `--fixture-root=${generatedRoot}`,
    `--matrix=${path.join(generatedRoot, 'matrix.json')}`,
    `--page-url=${collector.url}/page`,
    `--user-data-dir=${path.join(profileRoot, 'electron')}`
  ])
  runningProcesses.push(electron.child)
  const electronMissing = await waitForReports(collector.reports.electron, expected, electron.child)
  await stopProcess(electron.child)
  engines.electron = {
    command: electronBinary,
    versionOutput: preflight.electron.output,
    exitCode: electron.child.exitCode,
    missingContexts: electronMissing,
    output: electron.output.join('')
  }
} finally {
  await Promise.all(runningProcesses.map(stopProcess))
  await collector.close()
  await fs.rm(profileRoot, { recursive: true, force: true })
}

const reports = Object.fromEntries(Object.entries(collector.reports).map(([engine, contexts]) => [engine, Object.fromEntries(contexts)]))
const observedVersions = {
  chromium: suppliedChromiumVersion,
  electron: chromeVersion(Object.values(reports.electron)[0]?.userAgent)
}
const pinnedVersions = observedVersions.chromium === contract.chromium.version && observedVersions.electron === contract.chromium.version
const differences = {}
const ledgerEvidenceCandidates = []
for (const context of expected) {
  const chromium = reports.chromium[context]
  const electron = reports.electron[context]
  const behavior = behaviorDifferences(chromium, electron, pinnedVersions)
  differences[context] = {
    missing: { chromium: !chromium, electron: !electron },
    comparable: Boolean(chromium && electron),
    surface: surfaceDifference(chromium, electron),
    behavior
  }
  for (const result of behavior.filter((item) => item.evidenceCandidate && item.feature && matrix.contexts[context].apiFeatures.includes(item.feature))) {
    ledgerEvidenceCandidates.push({
      kind: 'api',
      feature: result.feature,
      platform,
      context,
      test: result.id,
      coverage: result.coverage,
      ledgerEligible: false,
      reason: 'This behavior test covers a member path. A feature ledger entry requires complete feature coverage.'
    })
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  contract: { chromium: contract.chromium, platform, contextMatrix: matrix.contexts },
  preflight,
  observedVersions,
  pinnedVersions,
  engines,
  reports,
  differences,
  ledgerEvidenceCandidates,
  comparisonSummary: {
    comparableContexts: expected.filter((context) => differences[context].comparable),
    chromiumUnavailableContexts: expected.filter((context) => !reports.chromium[context]),
    electronMissingAgainstChromium: expected.filter((context) => reports.chromium[context] && !reports.electron[context])
  }
}
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({
  output,
  contract: contract.chromium,
  observedVersions,
  pinnedVersions,
  contexts: Object.fromEntries(expected.map((context) => [context, differences[context].missing])),
  surfaceDifferenceCount: Object.values(differences).filter((item) => item.comparable).reduce((total, item) => total + item.surface.added.length + item.surface.removed.length + item.surface.typeChanged.length, 0),
  behaviorMismatchCount: Object.values(differences).filter((item) => item.comparable).flatMap((item) => item.behavior).filter((item) => !item.match).length,
  ledgerEvidenceCandidates: ledgerEvidenceCandidates.length,
  comparisonSummary: report.comparisonSummary
}, null, 2))
const electronRegressions = report.comparisonSummary.electronMissingAgainstChromium
if (!allowVersionMismatch && (!pinnedVersions || electronRegressions.length)) process.exitCode = 1
