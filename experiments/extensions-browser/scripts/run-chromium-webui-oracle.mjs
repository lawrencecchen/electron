import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(scriptPath), '..')
const electronRoot = path.resolve(root, '..', '..')
const probeRoot = path.join(root, 'oracle-probe')
const probeManifest = JSON.parse(await fs.readFile(path.join(probeRoot, 'manifest.json'), 'utf8'))
const oracleFeatures = ['Webium', 'SurfaceEmbed', 'ExtensionsMenuAccessControl']
const fixtureNames = ['ublock', 'bitwarden']
const webuiBrowserURL = 'chrome://webui-browser/'

function fail(message) {
  throw new Error(message)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function extensionIdFromKey(key) {
  const digest = sha256(Buffer.from(key, 'base64')).slice(0, 32)
  return [...digest].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('')
}

const probeId = extensionIdFromKey(probeManifest.key)
const probeURL = `chrome-extension://${probeId}/report.html`

export function canonicalJSONString(value) {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJSONString(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSONString(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function parseDevToolsActivePort(value) {
  const [portText, browserPath] = value.trim().split(/\r?\n/)
  const port = Number.parseInt(portText, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail('DevToolsActivePort contains an invalid port')
  if (!browserPath?.startsWith('/devtools/browser/')) fail('DevToolsActivePort contains an invalid browser endpoint')
  return { browserPath, port }
}

export function decodeProbeTitle(title) {
  const match = title.match(/ORACLE_(READY|ERROR):([A-Za-z0-9+/=]+)/)
  if (!match) return undefined
  return {
    status: match[1].toLowerCase(),
    value: JSON.parse(Buffer.from(match[2], 'base64').toString('utf8'))
  }
}

export function parseBrowserRevision(value) {
  const revision = value?.replace(/^@/, '')
  if (!revision || !/^[a-f0-9]{40}$/.test(revision)) fail(`Chrome reported an invalid source revision: ${value}`)
  return revision
}

export function matchFixtures(fixtures, extensions) {
  return fixtures.map((fixture) => {
    const candidates = extensions.filter((extension) => {
      if (fixture.expectedId) return extension.id === fixture.expectedId
      return extension.name === fixture.displayName && extension.version === fixture.version
    })
    const status = candidates.length === 1 ? 'loaded' : candidates.length ? 'ambiguous' : 'not-loaded'
    const extension = candidates.length === 1 ? candidates[0] : undefined
    return {
      displayName: fixture.displayName,
      enabled: extension?.enabled,
      id: extension?.id,
      installType: extension?.installType,
      label: fixture.label,
      requested: true,
      status,
      type: extension?.type,
      version: fixture.version
    }
  })
}

function parseOptions(args) {
  const options = { chromeArgs: [] }
  const valueOptions = new Map([
    ['--chrome', 'chrome'],
    ['--chromium-root', 'chromiumRoot'],
    ['--out-dir', 'outDir'],
    ['--profile-dir', 'profileDir'],
    ['--metadata', 'metadata'],
    ['--url', 'url'],
    ['--startup-timeout-ms', 'startupTimeout']
  ])
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (valueOptions.has(argument)) {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`)
      options[valueOptions.get(argument)] = value
      index += 1
    } else if (argument === '--chrome-arg') {
      const value = args[index + 1]
      if (!value) fail('--chrome-arg requires a value')
      options.chromeArgs.push(value)
      index += 1
    } else if (argument === '--exit-after-ready') {
      options.exitAfterReady = true
    } else if (argument === '--print-command') {
      options.printCommand = true
    } else if (argument === '--reuse-profile') {
      options.reuseProfile = true
    } else if (argument === '--allow-patched-source') {
      options.allowPatchedSource = true
    } else if (argument === '--help') {
      options.help = true
    } else {
      fail(`unknown argument: ${argument}`)
    }
  }
  return options
}

function usage() {
  return `Usage: node scripts/run-chromium-oracle.mjs [options]

  --chromium-root <src>       Chromium src checkout containing chrome/
  --out-dir <directory>       GN output directory, default out/ChromeOracle
  --chrome <executable>       Override the chrome binary path
  --profile-dir <directory>   Dedicated user-data directory
  --metadata <file>           Startup metadata output path
  --url <url>                 Initial content URL
  --chrome-arg <argument>     Additional Chrome argument, repeatable
  --reuse-profile             Preserve the dedicated profile before launch
  --allow-patched-source      Permit Electron patch commits for a non-oracle smoke run
  --exit-after-ready          Stop Chrome after verified metadata is written
  --print-command             Print the resolved launch command without running it
`
}

async function isDirectory(directory) {
  try {
    return (await fs.stat(directory)).isDirectory()
  } catch {
    return false
  }
}

async function resolveChromiumRoot(value) {
  const candidates = [value, process.env.CHROMIUM_SRC, path.resolve(electronRoot, '..')].filter(Boolean)
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    if (await isDirectory(path.join(resolved, 'chrome', 'browser'))) return resolved
  }
  fail('Chromium src was not found. Pass --chromium-root or set CHROMIUM_SRC.')
}

function defaultChromePath(outDir) {
  if (process.platform === 'win32') return path.join(outDir, 'chrome.exe')
  if (process.platform === 'darwin') return path.join(outDir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
  return path.join(outDir, 'chrome')
}

function runGit(chromiumRoot, args, allowFailure = false) {
  const result = spawnSync('git', args, { cwd: chromiumRoot, encoding: 'utf8' })
  if (!allowFailure && result.status !== 0) fail(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`)
  return result
}

function readChromiumVersion(deps) {
  const match = deps.match(/'chromium_version'\s*:\s*\n?\s*'([^']+)'/)
  if (!match) fail('Electron DEPS does not contain chromium_version')
  return match[1]
}

async function hashDirectory(directory) {
  const files = []
  async function visit(current, prefix = '') {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(absolute, relative)
      else if (entry.isFile()) files.push({ absolute, relative })
      else fail(`fixture contains an unsupported filesystem entry: ${absolute}`)
    }
  }
  await visit(directory)
  const hash = crypto.createHash('sha256')
  for (const file of files) {
    const content = await fs.readFile(file.absolute)
    hash.update(file.relative)
    hash.update('\0')
    hash.update(String(content.length))
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
  }
  return { files: files.length, sha256: hash.digest('hex') }
}

async function localizedManifestName(directory, manifest) {
  const match = manifest.name?.match(/^__MSG_(.+)__$/)
  if (!match) return manifest.name
  if (!manifest.default_locale) fail(`${directory} uses a localized name without default_locale`)
  const messagesPath = path.join(directory, '_locales', manifest.default_locale, 'messages.json')
  const messages = JSON.parse(await fs.readFile(messagesPath, 'utf8'))
  const message = messages[match[1]]?.message
  if (!message) fail(`${messagesPath} does not define ${match[1]}`)
  return message
}

async function readExtension(directory, label) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'))
  const tree = await hashDirectory(directory)
  return {
    directory,
    displayName: await localizedManifestName(directory, manifest),
    expectedId: manifest.key ? extensionIdFromKey(manifest.key) : undefined,
    label,
    manifestVersion: manifest.manifest_version,
    tree,
    version: manifest.version
  }
}

async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function waitForFile(file, child, deadline) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`Chrome exited before startup with code ${child.exitCode}`)
    try {
      return await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  fail(`timed out waiting for ${file}`)
}

async function fetchJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
  if (!response.ok) fail(`${url} returned ${response.status}`)
  return response.json()
}

async function browserVersionFromCDP(webSocketURL) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketURL)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('Browser.getVersion timed out'))
    }, 5_000)
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }))
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      if (message.error) reject(new Error(`Browser.getVersion failed: ${message.error.message}`))
      else resolve(message.result)
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Browser.getVersion WebSocket failed'))
    })
  })
}

async function waitForTargets(port, child, deadline) {
  let lastTargets = []
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`Chrome exited during startup with code ${child.exitCode}`)
    try {
      lastTargets = await fetchJSON(`http://127.0.0.1:${port}/json/list`)
      const webuiTarget = lastTargets.find((target) => target.url === webuiBrowserURL)
      const reportTarget = lastTargets.find((target) => target.url === probeURL)
      const report = reportTarget && decodeProbeTitle(reportTarget.title)
      if (report?.status === 'error') fail(`oracle probe failed: ${report.value.message}`)
      if (webuiTarget && report?.status === 'ready') return { report: report.value, reportTarget, targets: lastTargets, webuiTarget }
    } catch (error) {
      if (!['AbortError', 'TimeoutError'].includes(error.name) && !/fetch failed|ECONNREFUSED/.test(error.message)) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  const urls = lastTargets.map((target) => target.url).sort()
  fail(`timed out waiting for Webium and the extension probe; observed targets: ${JSON.stringify(urls)}`)
}

async function gnArguments(chromiumRoot, outDir) {
  const argsFile = path.join(outDir, 'args.gn')
  const argsFileContent = await fs.readFile(argsFile, 'utf8')
  const resolved = spawnSync('gn', ['args', outDir, '--list', '--short'], {
    cwd: chromiumRoot,
    encoding: 'utf8'
  })
  if (resolved.status === 0) {
    const content = resolved.stdout.trim()
    return { content, mode: 'resolved', sha256: sha256(content) }
  }
  return { content: argsFileContent.trim(), mode: 'args-file', sha256: sha256(argsFileContent.trim()) }
}

async function stopChrome(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit')
  }
}

function normalizedTargets(targets) {
  return targets.map((target) => ({
    title: target.title,
    type: target.type,
    url: target.url
  })).sort((left, right) => `${left.type}\0${left.url}\0${left.title}`.localeCompare(`${right.type}\0${right.url}\0${right.title}`))
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const chromiumRoot = await resolveChromiumRoot(options.chromiumRoot)
  const outDir = path.resolve(chromiumRoot, options.outDir || path.join('out', 'ChromeOracle'))
  const chrome = path.resolve(options.chrome || defaultChromePath(outDir))
  const profileDir = path.resolve(options.profileDir || path.join(root, 'artifacts', 'chromium-oracle-profile'))
  const metadataPath = path.resolve(options.metadata || path.join(root, 'artifacts', 'chromium-oracle-startup.json'))
  const contentURL = options.url || 'https://example.com/'
  const fixturesRoot = path.join(root, 'fixtures', 'extensions')
  const fixtures = await Promise.all(fixtureNames.map((name) => readExtension(path.join(fixturesRoot, name), name)))
  const probe = await readExtension(probeRoot, 'oracle-probe')
  if (probe.expectedId !== probeId) fail('oracle probe ID does not match its manifest key')

  await fs.access(chrome)
  for (const extension of [...fixtures, probe]) {
    if (extension.directory.includes(',')) fail(`Chrome cannot load an extension path containing a comma: ${extension.directory}`)
  }

  const launchArguments = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    `--enable-features=${oracleFeatures.join(',')}`,
    `--load-extension=${[...fixtures, probe].map((extension) => extension.directory).join(',')}`,
    '--new-window',
    contentURL,
    probeURL,
    ...options.chromeArgs
  ]

  if (options.printCommand) {
    console.log(JSON.stringify({ arguments: launchArguments, chrome }, null, 2))
    return
  }

  if (!options.reuseProfile) await fs.rm(profileDir, { force: true, recursive: true })
  await fs.mkdir(profileDir, { recursive: true })
  await fs.mkdir(path.dirname(metadataPath), { recursive: true })

  const sourceManifest = await readJSON(path.join(root, 'platform', 'source-manifest.json'))
  const contractPath = path.join(root, 'platform', sourceManifest.snapshot)
  const contractContent = await fs.readFile(contractPath, 'utf8')
  const contract = JSON.parse(contractContent)
  const deps = await fs.readFile(path.join(electronRoot, 'DEPS'), 'utf8')
  const depsVersion = readChromiumVersion(deps)
  if (sourceManifest.chromium.version !== depsVersion) {
    fail(`contract Chromium ${sourceManifest.chromium.version} differs from Electron DEPS ${depsVersion}`)
  }
  if (contract.chromium.version !== sourceManifest.chromium.version ||
      contract.chromium.revision !== sourceManifest.chromium.revision) {
    fail('generated conformance contract differs from platform/source-manifest.json')
  }

  const expectedRevision = sourceManifest.chromium.revision
  const ancestor = runGit(chromiumRoot, ['merge-base', '--is-ancestor', expectedRevision, 'HEAD'], true)
  if (ancestor.status !== 0) fail(`Chromium checkout does not descend from ${expectedRevision} (${depsVersion})`)
  const sourceHead = runGit(chromiumRoot, ['rev-parse', 'HEAD']).stdout.trim()
  const commitsAfterPin = Number.parseInt(runGit(chromiumRoot, ['rev-list', '--count', `${expectedRevision}..HEAD`]).stdout.trim(), 10)
  const sourceDirty = runGit(chromiumRoot, ['status', '--porcelain']).stdout.trim() !== ''
  const stockSource = sourceHead === expectedRevision && !sourceDirty
  if (!stockSource && !options.allowPatchedSource) {
    fail(`exact oracle requires clean Chromium ${expectedRevision}; pass --allow-patched-source only for an architectural smoke run`)
  }
  const electronHead = runGit(electronRoot, ['rev-parse', 'HEAD']).stdout.trim()
  const gn = await gnArguments(chromiumRoot, outDir)

  let child
  try {
    child = spawn(chrome, launchArguments, { stdio: 'inherit' })
    const timeout = Number.parseInt(options.startupTimeout || '45000', 10)
    if (!Number.isInteger(timeout) || timeout < 1_000) fail('--startup-timeout-ms must be an integer of at least 1000')
    const deadline = Date.now() + timeout
    const activePortText = await waitForFile(path.join(profileDir, 'DevToolsActivePort'), child, deadline)
    const devtools = parseDevToolsActivePort(activePortText)
    const version = await fetchJSON(`http://127.0.0.1:${devtools.port}/json/version`)
    const browserWebSocketURL = `ws://127.0.0.1:${devtools.port}${devtools.browserPath}`
    const cdpVersion = await browserVersionFromCDP(browserWebSocketURL)
    const actualVersion = version.Browser?.match(/\/([0-9]+(?:\.[0-9]+){3})$/)?.[1]
    if (actualVersion !== depsVersion) fail(`Chrome binary is ${actualVersion || version.Browser}; expected ${depsVersion}`)
    const actualRevision = parseBrowserRevision(cdpVersion.revision)
    if (stockSource && actualRevision !== expectedRevision) {
      fail(`Chrome binary revision is ${actualRevision}; exact oracle requires ${expectedRevision}`)
    }
    const targetState = await waitForTargets(devtools.port, child, deadline)
    const fixtureResults = matchFixtures(fixtures, targetState.report.extensions)
    const requestedExtensions = [...fixtures, probe].map((extension) => ({
      displayName: extension.displayName,
      files: extension.tree.files,
      label: extension.label,
      manifestVersion: extension.manifestVersion,
      sha256: extension.tree.sha256,
      version: extension.version
    }))
    const comparable = {
      build: {
        gnArguments: gn.content,
        gnArgumentsMode: gn.mode,
        gnArgumentsSha256: gn.sha256,
        official: false
      },
      chromium: {
        actualVersion,
        actualRevision,
        browserProduct: version.Browser,
        channel: 'unknown-self-built-chromium',
        expectedRevision,
        expectedVersion: depsVersion,
        protocolVersion: version['Protocol-Version'],
        v8Version: version['V8-Version']
      },
      contract: {
        sha256: sha256(contractContent),
        summary: contract.summary
      },
      fixtures: fixtureResults.map(({ id, ...fixture }) => fixture),
      oracle: {
        electronBrowserContextParityProven: false,
        kind: 'stock-chromium-webui-extension-oracle',
        schemaVersion: 1
      },
      platform: targetState.report.platform,
      requestedExtensions,
      source: {
        commitsAfterPin,
        dirty: sourceDirty,
        head: sourceHead,
        stockSource
      },
      webui: {
        features: oracleFeatures,
        targetURL: targetState.webuiTarget.url,
        verified: true
      }
    }
    const metadata = {
      comparable,
      comparableSha256: sha256(canonicalJSONString(comparable)),
      instance: {
        binary: chrome,
        chromiumRoot,
        devtools: {
          browserWebSocketURL,
          port: devtools.port
        },
        electronHead,
        metadataPath,
        profileDir,
        reportTargetId: targetState.reportTarget.id,
        webuiTargetId: targetState.webuiTarget.id
      },
      nativeExtensionInventory: targetState.report.extensions,
      targets: normalizedTargets(targetState.targets)
    }
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
    console.log(JSON.stringify({
      chromium: `${actualVersion}@${expectedRevision}`,
      comparableSha256: metadata.comparableSha256,
      fixtures: fixtureResults,
      metadata: metadataPath,
      webuiBrowser: true
    }, null, 2))
    console.log(`ORACLE_METADATA ${metadataPath}`)

    if (options.exitAfterReady) await stopChrome(child)
    else if (child.exitCode === null) await once(child, 'exit')
  } catch (error) {
    if (child) await stopChrome(child)
    throw error
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(scriptPath)) {
  main().catch((error) => {
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}
