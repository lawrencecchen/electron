const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const { app, BaseWindow, WebContentsView, ipcMain, session } = require('electron')
const {
  evaluateCoverage,
  loadContract,
  loadSupportLedger
} = require('./scripts/platform-contract.cjs')

const extensions = [
  { name: 'ublock', directory: 'ublock', popup: 'popup-fenix.html' },
  { name: 'bitwarden', directory: 'bitwarden', popup: 'popup/index.html' }
]

let window
let toolbar
let content
let activePopup
let fixtureServer
let fixtureURL
let chromeExtensions
const loaded = new Map()
const consoleEvents = []
const expectedRendererExits = new Set()
const stressDiagnostics = {
  childProcessGone: [],
  extensionEvents: [],
  memory: [],
  renderProcessGone: [],
  serviceWorkers: [],
  unexpectedRendererExits: [],
  unresponsive: []
}

process.on('warning', (warning) => {
  consoleEvents.push({
    time: new Date().toISOString(),
    type: warning.name,
    message: warning.message,
    stack: warning.stack
  })
})

const root = __dirname
const extensionRoot = path.join(root, 'fixtures', 'extensions')
const defaultArtifacts = path.join(root, 'artifacts')
const requiredAPI = require('./required-api.json')
const platformContract = loadContract()
const supportLedger = loadSupportLedger()
const providerArgument = process.argv.find((argument) => argument.startsWith('--extension-provider='))?.split('=')[1]
const extensionProviderMode = providerArgument || process.env.ELECTRON_EXTENSION_PROVIDER || 'native'
const smokeMode = process.argv.includes('--smoke') || process.env.ELECTRON_EXTENSION_SMOKE === '1'
const stressMode = process.argv.includes('--stress')
const integerArgument = (name, fallback) => {
  const value = process.argv.find((argument) => argument.startsWith(`${name}=`))?.split('=')[1]
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
const stringArgument = (name, fallback) => (
  process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1) || fallback
)
const artifacts = stressMode
  ? path.resolve(stringArgument('--stress-artifacts', defaultArtifacts))
  : defaultArtifacts
const stressIterations = integerArgument('--stress-iterations', 100)
const stressReloadEvery = integerArgument('--stress-reload-every', 10)
const stressCrashEvery = integerArgument('--stress-crash-every', 20)
const stressCycle = integerArgument('--stress-cycle', 0)
const stressOperationTimeoutMS = integerArgument('--stress-operation-timeout-ms', 10_000)

if (stressMode) {
  const profile = path.resolve(stringArgument('--stress-profile', path.join(artifacts, 'stress-profile')))
  const crashDumps = path.join(artifacts, 'crashes')
  fsSync.mkdirSync(profile, { recursive: true })
  fsSync.mkdirSync(crashDumps, { recursive: true })
  app.setPath('userData', profile)
  app.setPath('crashDumps', crashDumps)
}

if (!['native', 'shim'].includes(extensionProviderMode)) {
  throw new Error(`Unknown extension provider: ${extensionProviderMode}`)
}

app.on('child-process-gone', (_event, details) => {
  stressDiagnostics.childProcessGone.push(details)
})

async function writeStressProgress(phase, details = {}) {
  if (!stressMode) return
  await fs.mkdir(artifacts, { recursive: true })
  await fs.writeFile(path.join(artifacts, `stress-${stressCycle}-progress.json`), `${JSON.stringify({
    time: new Date().toISOString(),
    phase,
    ...details
  }, null, 2)}\n`)
}

function withStressDeadline(promise, label) {
  if (!stressMode) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${stressOperationTimeoutMS} ms`)),
      stressOperationTimeoutMS
    )
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function emitState(extra = {}) {
  if (!toolbar || toolbar.webContents.isDestroyed()) return
  toolbar.webContents.send('lab:state', {
    url: content?.webContents.getURL() || '',
    extensions: [...loaded.values()].map(({ name, extension }) => ({
      name,
      id: extension.id,
      version: extension.version
    })),
    activePopup: activePopup?.name || null,
    ...extra
  })
}

function attachDiagnostics(label, webContents) {
  webContents.on('console-message', (event) => {
    consoleEvents.push({
      time: new Date().toISOString(),
      label,
      level: event.level,
      message: event.message,
      sourceId: event.sourceId,
      lineNumber: event.lineNumber
    })
  })
  webContents.on('render-process-gone', (_event, details) => {
    consoleEvents.push({ time: new Date().toISOString(), label, renderProcessGone: details })
    const entry = { label, webContentsId: webContents.id, ...details }
    stressDiagnostics.renderProcessGone.push(entry)
    if (expectedRendererExits.delete(webContents.id)) return
    if (details.reason !== 'clean-exit') stressDiagnostics.unexpectedRendererExits.push(entry)
  })
  webContents.on('unresponsive', () => {
    stressDiagnostics.unresponsive.push({ label, webContentsId: webContents.id })
  })
}

function layout() {
  if (!window) return
  const { width, height } = window.getContentBounds()
  toolbar.setBounds({ x: 0, y: 0, width, height: 72 })
  content.setBounds({ x: 0, y: 72, width, height: Math.max(0, height - 72) })
  for (const item of loaded.values()) {
    item.view.setBounds({
      x: Math.max(12, width - 438),
      y: 64,
      width: Math.min(420, width - 24),
      height: Math.min(680, height - 82)
    })
  }
}

function normalizeAddress(value) {
  const text = String(value).trim()
  if (!text) return fixtureURL
  try { return new URL(text).toString() } catch {}
  if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(text)) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}

function createFixtureServer() {
  return new Promise((resolve, reject) => {
    fixtureServer = http.createServer((request, response) => {
      if (request.url === '/ad-banner.js') {
        response.writeHead(200, { 'content-type': 'application/javascript' })
        response.end("document.querySelector('#ad-status').textContent='ad script loaded'\n")
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Extension test page</title>
        <style>body{font:16px system-ui;max-width:760px;margin:64px auto;padding:0 24px}label{display:grid;gap:6px;margin:18px 0}input{font:inherit;padding:10px}.ad{padding:16px;background:#fee2e2}</style>
        </head><body><h1>Extension compatibility test page</h1>
        <p>Bitwarden should detect this login form. uBlock Origin should inject its content runtime.</p>
        <form><label>Email<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>
        <div class="ad adsbox" id="ad-status">ad script pending</div><script src="/ad-banner.js"></script>
        </body></html>`)
    })
    fixtureServer.once('error', reject)
    fixtureServer.listen(0, '127.0.0.1', () => {
      fixtureURL = `http://127.0.0.1:${fixtureServer.address().port}/`
      resolve()
    })
  })
}

async function loadExtensions(ses) {
  for (const descriptor of extensions) {
    await writeStressProgress('load-extension:start', { extension: descriptor.name })
    const extension = await withStressDeadline(ses.extensions.loadExtension(
      path.join(extensionRoot, descriptor.directory),
      { allowFileAccess: true }
    ), `load ${descriptor.name}`)
    const view = new WebContentsView({
      webPreferences: { session: ses, contextIsolation: true, sandbox: true }
    })
    view.setBackgroundColor('#ffffff')
    view.setVisible(false)
    attachDiagnostics(`${descriptor.name}:popup`, view.webContents)
    loaded.set(descriptor.name, { ...descriptor, extension, view, loadedPopup: false })
    await writeStressProgress('load-extension:complete', { extension: descriptor.name, id: extension.id })
  }
}

function destroyPopupViews() {
  activePopup = undefined
  for (const item of loaded.values()) {
    window?.contentView.removeChildView(item.view)
    if (!item.view.webContents.isDestroyed()) item.view.webContents.close()
  }
}

async function reloadExtensions(ses) {
  await writeStressProgress('reload-extensions:start')
  const extensionIds = [...loaded.values()].map((item) => item.extension.id)
  destroyPopupViews()
  loaded.clear()
  for (const id of extensionIds) {
    await writeStressProgress('remove-extension:start', { id })
    ses.extensions.removeExtension(id)
    await writeStressProgress('remove-extension:complete', { id })
  }
  await loadExtensions(ses)
  for (const item of loaded.values()) window.contentView.addChildView(item.view)
  layout()
  await writeStressProgress('reload-extensions:complete')
}

async function showExtension(name) {
  const item = loaded.get(name)
  if (!item) return
  if (activePopup && activePopup !== item) activePopup.view.setVisible(false)
  activePopup = item
  window.contentView.addChildView(item.view)
  item.view.setVisible(true)
  if (!item.loadedPopup) {
    await writeStressProgress('popup-load:start', { extension: name })
    await withStressDeadline(
      item.view.webContents.loadURL(`chrome-extension://${item.extension.id}/${item.popup}`),
      `load ${name} popup`
    )
    item.loadedPopup = true
    await writeStressProgress('popup-load:complete', { extension: name })
  }
  await writeStressProgress('popup-frame:start', { extension: name })
  await withStressDeadline(
    item.view.webContents.executeJavaScript(stressMode
      ? 'document.readyState'
      : 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'),
    `ready ${name} popup`
  )
  await writeStressProgress('popup-frame:complete', { extension: name })
  item.view.webContents.focus()
  emitState()
}

function hidePopup() {
  if (activePopup) activePopup.view.setVisible(false)
  activePopup = undefined
  emitState()
}

async function inventoryChromeAPIs(webContents) {
  return webContents.executeJavaScript(`(() => {
    const namespaces = Object.keys(globalThis.chrome || {}).sort()
    const members = {}
    for (const namespace of namespaces) {
      try { members[namespace] = Object.keys(chrome[namespace] || {}).sort() }
      catch (error) { members[namespace] = ['<error: ' + error.message + '>'] }
    }
    return { namespaces, members, href: location.href, title: document.title }
  })()`)
}

async function checkRequiredAPIs(webContents, requirements) {
  return webContents.executeJavaScript(`(() => {
    const requirements = ${JSON.stringify(requirements)}
    return requirements.map(path => {
      let value = globalThis.chrome
      for (const component of path.split('.')) value = value?.[component]
      return { path, present: value !== undefined, type: typeof value }
    })
  })()`)
}

async function sampleStressState(ses, iteration) {
  stressDiagnostics.memory.push({
    iteration,
    browser: await process.getProcessMemoryInfo(),
    processes: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      memory: metric.memory
    }))
  })
  stressDiagnostics.serviceWorkers.push({
    iteration,
    workers: ses.serviceWorkers.getAllRunning()
  })
}

async function forceContentRendererRestart(url) {
  expectedRendererExits.add(content.webContents.id)
  const gone = new Promise((resolve) => content.webContents.once('render-process-gone', resolve))
  content.webContents.forcefullyCrashRenderer()
  await withStressDeadline(gone, 'wait for content renderer crash')
  await withStressDeadline(content.webContents.loadURL(url), 'reload content renderer')
}

async function runStress(ses) {
  await fs.mkdir(artifacts, { recursive: true })
  await sampleStressState(ses, 0)
  for (let iteration = 1; iteration <= stressIterations; iteration += 1) {
    await writeStressProgress('iteration:start', { iteration })
    const url = `${fixtureURL}?cycle=${stressCycle}&iteration=${iteration}`
    await withStressDeadline(content.webContents.loadURL(url), 'load stress content')
    await writeStressProgress('content-load:complete', { iteration, url })
    await content.webContents.executeJavaScript(`(() => {
      const username = document.querySelector('[name=username]')
      const password = document.querySelector('[name=password]')
      if (!username || !password) throw new Error('login fixture missing')
      username.value = ${JSON.stringify(`stress-${stressCycle}-${iteration}@example.test`)}
      password.value = ${JSON.stringify(`password-${iteration}`)}
      username.dispatchEvent(new Event('input', { bubbles: true }))
      password.dispatchEvent(new Event('input', { bubbles: true }))
      return document.querySelector('#ad-status').textContent
    })()`)

    for (const descriptor of extensions) {
      await writeStressProgress('popup:start', { iteration, extension: descriptor.name })
      await showExtension(descriptor.name)
      const inventory = await inventoryChromeAPIs(loaded.get(descriptor.name).view.webContents)
      if (!Array.isArray(inventory.namespaces)) throw new Error(`${descriptor.name} API inventory failed`)
      hidePopup()
      await writeStressProgress('popup:complete', { iteration, extension: descriptor.name })
    }

    if (stressCrashEvery > 0 && iteration % stressCrashEvery === 0) {
      await writeStressProgress('renderer-restart:start', { iteration })
      await forceContentRendererRestart(url)
      await writeStressProgress('renderer-restart:complete', { iteration })
    }
    if (stressReloadEvery > 0 && iteration % stressReloadEvery === 0) {
      await reloadExtensions(ses)
    }
    if (iteration % 5 === 0 || iteration === stressIterations) {
      await sampleStressState(ses, iteration)
    }
    await writeStressProgress('iteration:complete', { iteration })
  }

  const first = stressDiagnostics.memory.at(0)
  const last = stressDiagnostics.memory.at(-1)
  const totalWorkingSet = (sample) => sample.processes.reduce(
    (total, metric) => total + (metric.memory?.workingSetSize || 0),
    0
  )
  const warmup = stressDiagnostics.memory.find(
    (sample) => sample.iteration >= Math.min(10, stressIterations)
  ) || first
  const retainedGrowthAfterWarmupMB = (totalWorkingSet(last) - totalWorkingSet(warmup)) / 1024
  const peakGrowthAfterWarmupMB = (
    Math.max(...stressDiagnostics.memory
      .filter((sample) => sample.iteration >= warmup.iteration)
      .map(totalWorkingSet)) - totalWorkingSet(warmup)
  ) / 1024
  const maxRetainedGrowthMB = Number.parseInt(
    process.env.ELECTRON_EXTENSION_STRESS_MAX_RETAINED_GROWTH_MB || '384',
    10
  )
  const unexpectedChildProcessExits = stressDiagnostics.childProcessGone.filter(
    (entry) => entry.reason !== 'clean-exit'
  )
  const crashFiles = await fs.readdir(path.join(artifacts, 'crashes')).catch(() => [])
  const report = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    cycle: stressCycle,
    iterations: stressIterations,
    reloadEvery: stressReloadEvery,
    crashEvery: stressCrashEvery,
    injectedRendererCrashes: stressCrashEvery > 0 ? Math.floor(stressIterations / stressCrashEvery) : 0,
    extensionReloads: stressReloadEvery > 0 ? Math.floor(stressIterations / stressReloadEvery) : 0,
    extensions: [...loaded.values()].map((item) => ({
      id: item.extension.id,
      name: item.name,
      version: item.extension.version
    })),
    warmupIteration: warmup.iteration,
    retainedGrowthAfterWarmupMB,
    peakGrowthAfterWarmupMB,
    maxRetainedGrowthMB,
    crashFiles,
    unexpectedChildProcessExits,
    diagnostics: stressDiagnostics,
    pass: stressDiagnostics.unexpectedRendererExits.length === 0 &&
      stressDiagnostics.unresponsive.length === 0 &&
      unexpectedChildProcessExits.length === 0 &&
      retainedGrowthAfterWarmupMB <= maxRetainedGrowthMB &&
      peakGrowthAfterWarmupMB <= maxRetainedGrowthMB
  }
  await fs.writeFile(path.join(artifacts, `stress-${stressCycle}.json`), `${JSON.stringify(report, null, 2)}\n`)
  if (!report.pass) throw new Error(`extension stress failed: ${JSON.stringify({
    unexpectedRendererExits: stressDiagnostics.unexpectedRendererExits.length,
    unresponsive: stressDiagnostics.unresponsive.length,
    unexpectedChildProcessExits: unexpectedChildProcessExits.length,
    retainedGrowthAfterWarmupMB,
    peakGrowthAfterWarmupMB
  })}`)
}

async function runSmoke() {
  await fs.mkdir(artifacts, { recursive: true })
  const report = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] || process.platform,
    provider: {
      mode: extensionProviderMode,
      nativeConformance: extensionProviderMode === 'native',
      injectedAPIs: extensionProviderMode === 'shim' ? ['electron-chrome-extensions'] : []
    },
    platformContract: {
      chromium: platformContract.chromium,
      denominator: platformContract.summary
    },
    fixtureURL,
    extensions: {},
    consoleEvents
  }
  for (const descriptor of extensions) {
    const item = loaded.get(descriptor.name)
    report.extensions[descriptor.name] = {
      id: item.extension.id,
      name: item.extension.name,
      version: item.extension.version,
      manifestVersion: item.extension.manifest.manifest_version,
      permissions: item.extension.manifest.permissions || []
    }
    try {
      await showExtension(descriptor.name)
      const image = await item.view.webContents.capturePage()
      await fs.writeFile(path.join(artifacts, `${descriptor.name}-popup.png`), image.toPNG())
      Object.assign(report.extensions[descriptor.name], {
        popupURL: item.view.webContents.getURL(),
        api: await inventoryChromeAPIs(item.view.webContents),
        canaryRequirements: await checkRequiredAPIs(item.view.webContents, requiredAPI[descriptor.name])
      })
    } catch (error) {
      report.extensions[descriptor.name].error = error.stack || String(error)
    }
  }
  report.consoleEvents = consoleEvents
  report.coverage = evaluateCoverage(platformContract, supportLedger, report)
  await fs.writeFile(path.join(artifacts, 'compatibility.json'), JSON.stringify(report, null, 2))
  app.exit(0)
}

async function createWindow() {
  await createFixtureServer()
  const ses = session.fromPartition('persist:extension-lab')
  if (extensionProviderMode === 'shim') {
    const { ElectronChromeExtensions } = require('electron-chrome-extensions')
    chromeExtensions = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: ses,
      requestPermissions: async () => true
    })
  }
  ses.extensions.on('extension-loaded', (_event, extension) => {
    consoleEvents.push({ time: new Date().toISOString(), event: 'extension-loaded', id: extension.id, name: extension.name })
    stressDiagnostics.extensionEvents.push({ event: 'extension-loaded', id: extension.id, name: extension.name })
  })
  ses.extensions.on('extension-ready', (_event, extension) => {
    consoleEvents.push({ time: new Date().toISOString(), event: 'extension-ready', id: extension.id, name: extension.name })
    stressDiagnostics.extensionEvents.push({ event: 'extension-ready', id: extension.id, name: extension.name })
  })
  ses.extensions.on('extension-unloaded', (_event, extension) => {
    stressDiagnostics.extensionEvents.push({ event: 'extension-unloaded', id: extension.id, name: extension.name })
  })
  ses.serviceWorkers.on('registration-completed', (_event, details) => {
    stressDiagnostics.extensionEvents.push({ event: 'service-worker-registration-completed', ...details })
  })
  ses.serviceWorkers.on('running-status-changed', (details) => {
    stressDiagnostics.extensionEvents.push({ event: 'service-worker-running-status-changed', ...details })
  })
  window = new BaseWindow({ width: 1360, height: 860, minWidth: 800, minHeight: 520, title: 'Electron extension compatibility lab' })
  toolbar = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: path.join(root, 'preload.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  content = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, sandbox: true } })
  toolbar.setBackgroundColor('#111827')
  content.setBackgroundColor('#ffffff')
  attachDiagnostics('toolbar', toolbar.webContents)
  attachDiagnostics('content', content.webContents)
  chromeExtensions?.addTab(content.webContents, window)
  window.contentView.addChildView(content)
  window.contentView.addChildView(toolbar)
  await loadExtensions(ses)
  for (const item of loaded.values()) window.contentView.addChildView(item.view)
  layout()
  await toolbar.webContents.loadFile(path.join(root, 'ui', 'toolbar.html'))
  await content.webContents.loadURL(fixtureURL)
  content.webContents.on('did-navigate', emitState)
  content.webContents.on('did-navigate-in-page', emitState)
  emitState()

  window.on('resize', layout)
  window.on('closed', () => {
    for (const view of [toolbar, content, ...[...loaded.values()].map((item) => item.view)]) {
      if (view && !view.webContents.isDestroyed()) view.webContents.close()
    }
    fixtureServer?.close()
    window = undefined
  })

  if (stressMode) {
    await runStress(ses)
    app.exit(0)
  } else if (smokeMode) {
    await runSmoke()
  }
}

ipcMain.on('lab:navigate', (_event, address) => content.webContents.loadURL(normalizeAddress(address)))
ipcMain.on('lab:show-extension', (_event, name) => showExtension(String(name)))
ipcMain.on('lab:hide-popup', hidePopup)

app.whenReady().then(createWindow).catch(async (error) => {
  if (stressMode) {
    await fs.mkdir(artifacts, { recursive: true })
    await fs.writeFile(path.join(artifacts, `stress-${stressCycle}.json`), `${JSON.stringify({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      cycle: stressCycle,
      iterations: stressIterations,
      error: error.stack || String(error),
      diagnostics: stressDiagnostics,
      pass: false
    }, null, 2)}\n`)
  }
  console.error(error)
  app.exit(1)
})
app.on('window-all-closed', () => app.quit())
