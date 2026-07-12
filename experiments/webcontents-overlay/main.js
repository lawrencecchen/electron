const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BaseWindow, WebContentsView, ipcMain } = require('electron')

const TOOLBAR_HEIGHT = 64
const OVERLAY_WIDTH = 390
const OVERLAY_HEIGHT = 250

let window
let contentView
let omnibarView
let overlayView
let overlayVisible = true

const artifacts = path.join(__dirname, 'artifacts')
const stressMode = process.argv.includes('--stress')
const integerArgument = (name, fallback) => {
  const value = process.argv.find((argument) => argument.startsWith(`${name}=`))?.split('=')[1]
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
const stressIterations = integerArgument('--stress-iterations', 200)
const stressCrashEvery = integerArgument('--stress-crash-every', 25)
const stressCycle = integerArgument('--stress-cycle', 0)
const expectedRendererExits = new Set()
const diagnostics = {
  events: [],
  memory: [],
  unexpectedRendererExits: [],
  unresponsive: []
}

if (stressMode) {
  const crashDumps = path.join(artifacts, 'crashes')
  fsSync.mkdirSync(crashDumps, { recursive: true })
  app.setPath('crashDumps', crashDumps)
}

const uiPath = (name) => path.join(__dirname, 'ui', name)

function normalizeAddress(input) {
  const value = input.trim()
  if (!value) return 'https://example.com'
  try {
    return new URL(value).toString()
  } catch {
    if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(value)) {
      return new URL(`https://${value}`).toString()
    }
    return `https://www.google.com/search?q=${encodeURIComponent(value)}`
  }
}

function layout() {
  if (!window) return
  const { width, height } = window.getContentBounds()
  contentView.setBounds({
    x: 0,
    y: TOOLBAR_HEIGHT,
    width,
    height: Math.max(0, height - TOOLBAR_HEIGHT)
  })
  omnibarView.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT })
  overlayView.setBounds({
    x: Math.max(16, width - OVERLAY_WIDTH - 24),
    y: TOOLBAR_HEIGHT - 14,
    width: Math.min(OVERLAY_WIDTH, width - 32),
    height: OVERLAY_HEIGHT
  })
}

function syncNavigationState() {
  if (!contentView || !omnibarView || omnibarView.webContents.isDestroyed()) return
  omnibarView.webContents.send('browser-state', {
    url: contentView.webContents.getURL(),
    canGoBack: contentView.webContents.navigationHistory.canGoBack(),
    canGoForward: contentView.webContents.navigationHistory.canGoForward(),
    loading: contentView.webContents.isLoading()
  })
}

function setOverlayVisible(visible) {
  overlayVisible = visible
  overlayView.setVisible(visible)
  if (visible) window.contentView.addChildView(overlayView)
  omnibarView.webContents.send('overlay-state', { visible })
}

function registerShortcuts(webContents) {
  webContents.on('before-input-event', (event, input) => {
    const command = input.control || input.meta
    if (command && !input.shift && input.key.toLowerCase() === 'l') {
      event.preventDefault()
      omnibarView.webContents.focus()
      omnibarView.webContents.send('focus-address')
    }
    if (command && input.shift && input.key.toLowerCase() === 'p') {
      event.preventDefault()
      setOverlayVisible(!overlayVisible)
    }
  })
}

function attachDiagnostics(label, webContents) {
  webContents.on('render-process-gone', (_event, details) => {
    const entry = { label, webContentsId: webContents.id, ...details }
    diagnostics.events.push({ type: 'render-process-gone', ...entry })
    if (expectedRendererExits.delete(webContents.id)) return
    if (details.reason !== 'clean-exit') diagnostics.unexpectedRendererExits.push(entry)
  })
  webContents.on('unresponsive', () => {
    const entry = { label, webContentsId: webContents.id }
    diagnostics.events.push({ type: 'unresponsive', ...entry })
    diagnostics.unresponsive.push(entry)
  })
  webContents.on('responsive', () => {
    diagnostics.events.push({ type: 'responsive', label, webContentsId: webContents.id })
  })
}

async function sampleMemory(iteration) {
  const browser = await process.getProcessMemoryInfo()
  diagnostics.memory.push({
    iteration,
    browser,
    processes: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      memory: metric.memory
    }))
  })
}

async function forceRendererRestart(view, url) {
  const { webContents } = view
  expectedRendererExits.add(webContents.id)
  const gone = new Promise((resolve) => webContents.once('render-process-gone', resolve))
  webContents.forcefullyCrashRenderer()
  await gone
  await webContents.loadURL(url)
}

async function runStress() {
  await fs.mkdir(artifacts, { recursive: true })
  const initialURL = contentView.webContents.getURL()
  await sampleMemory(0)

  for (let iteration = 1; iteration <= stressIterations; iteration += 1) {
    const width = 760 + ((iteration * 97) % 720)
    const height = 500 + ((iteration * 53) % 420)
    window.setContentSize(width, height)
    layout()

    setOverlayVisible(false)
    setOverlayVisible(true)
    const overlayInput = `stress cycle ${stressCycle} iteration ${iteration}`
    await overlayView.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('input')
      if (!input) throw new Error('overlay input missing')
      input.focus()
      input.value = ${JSON.stringify(overlayInput)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return input.value
    })()`)
    overlayView.webContents.sendInputEvent({ type: 'mouseMove', x: 80, y: 120 })
    overlayView.webContents.sendInputEvent({ type: 'mouseDown', x: 80, y: 120, button: 'left', clickCount: 1 })
    overlayView.webContents.sendInputEvent({ type: 'mouseUp', x: 80, y: 120, button: 'left', clickCount: 1 })

    const url = `data:text/html;charset=utf-8,${encodeURIComponent(
      `<!doctype html><title>stress-${iteration}</title><input autofocus value="${iteration}"><p>${'x'.repeat(iteration % 2048)}</p>`
    )}`
    await contentView.webContents.loadURL(url)
    contentView.webContents.focus()
    contentView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
    contentView.webContents.sendInputEvent({ type: 'char', keyCode: 'a' })
    contentView.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' })
    await contentView.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    )

    if (stressCrashEvery > 0 && iteration % stressCrashEvery === 0) {
      await forceRendererRestart(contentView, url)
    }
    if (iteration % 10 === 0 || iteration === stressIterations) await sampleMemory(iteration)
  }

  const first = diagnostics.memory.at(0)
  const last = diagnostics.memory.at(-1)
  const totalWorkingSet = (sample) => sample.processes.reduce(
    (total, metric) => total + (metric.memory?.workingSetSize || 0),
    0
  )
  const browserPrivateGrowthMB = (last.browser.private - first.browser.private) / 1024
  const totalWorkingSetGrowthMB = (totalWorkingSet(last) - totalWorkingSet(first)) / 1024
  const maxGrowthMB = Number.parseInt(process.env.ELECTRON_STRESS_MAX_RSS_GROWTH_MB || '256', 10)
  const crashFiles = await fs.readdir(path.join(artifacts, 'crashes')).catch(() => [])
  const report = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    cycle: stressCycle,
    iterations: stressIterations,
    injectedRendererCrashes: stressCrashEvery > 0 ? Math.floor(stressIterations / stressCrashEvery) : 0,
    initialURL,
    finalURL: contentView.webContents.getURL(),
    childViewCount: window.contentView.children.length,
    browserPrivateGrowthMB,
    totalWorkingSetGrowthMB,
    maxWorkingSetGrowthMB: maxGrowthMB,
    crashFiles,
    diagnostics,
    pass: diagnostics.unexpectedRendererExits.length === 0 &&
      diagnostics.unresponsive.length === 0 &&
      browserPrivateGrowthMB <= maxGrowthMB &&
      totalWorkingSetGrowthMB <= maxGrowthMB
  }
  await fs.writeFile(path.join(artifacts, `stress-${stressCycle}.json`), `${JSON.stringify(report, null, 2)}\n`)
  if (!report.pass) throw new Error(`overlay stress failed: ${JSON.stringify({
    unexpectedRendererExits: diagnostics.unexpectedRendererExits.length,
    unresponsive: diagnostics.unresponsive.length,
    browserPrivateGrowthMB,
    totalWorkingSetGrowthMB
  })}`)
}

async function captureSmokeArtifacts() {
  await fs.mkdir(artifacts, { recursive: true })
  const [content, omnibar, overlay] = await Promise.all([
    contentView.webContents.capturePage(),
    omnibarView.webContents.capturePage(),
    overlayView.webContents.capturePage()
  ])
  await Promise.all([
    fs.writeFile(path.join(artifacts, 'content.png'), content.toPNG()),
    fs.writeFile(path.join(artifacts, 'omnibar.png'), omnibar.toPNG()),
    fs.writeFile(path.join(artifacts, 'overlay.png'), overlay.toPNG())
  ])
  await fs.writeFile(path.join(artifacts, 'smoke.json'), JSON.stringify({
    childViewCount: window.contentView.children.length,
    zOrder: ['content', 'omnibar', 'overlay'],
    overlayVisible,
    contentURL: contentView.webContents.getURL(),
    bounds: {
      content: contentView.getBounds(),
      omnibar: omnibarView.getBounds(),
      overlay: overlayView.getBounds()
    }
  }, null, 2))
}

function createWindow() {
  window = new BaseWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'Electron layered browser views'
  })

  const uiPreferences = {
    contextIsolation: true,
    sandbox: true,
    preload: path.join(__dirname, 'preload.js')
  }
  contentView = new WebContentsView({
    webPreferences: { contextIsolation: true, sandbox: true }
  })
  omnibarView = new WebContentsView({ webPreferences: uiPreferences })
  overlayView = new WebContentsView({ webPreferences: uiPreferences })

  attachDiagnostics('content', contentView.webContents)
  attachDiagnostics('omnibar', omnibarView.webContents)
  attachDiagnostics('overlay', overlayView.webContents)

  contentView.setBackgroundColor('#ffffff')
  omnibarView.setBackgroundColor('#111827')
  // Keep the overlay surface opaque. Transparent WebContentsView backing
  // surfaces expose a rectangular compositor shadow on macOS.
  overlayView.setBackgroundColor('#0f172a')

  window.contentView.addChildView(contentView)
  window.contentView.addChildView(omnibarView)
  window.contentView.addChildView(overlayView)
  layout()

  registerShortcuts(contentView.webContents)
  registerShortcuts(omnibarView.webContents)
  registerShortcuts(overlayView.webContents)

  contentView.webContents.on('did-start-loading', syncNavigationState)
  contentView.webContents.on('did-stop-loading', syncNavigationState)
  contentView.webContents.on('did-navigate', syncNavigationState)
  contentView.webContents.on('did-navigate-in-page', syncNavigationState)

  omnibarView.webContents.loadFile(uiPath('omnibar.html'))
  overlayView.webContents.loadFile(uiPath('overlay.html'))
  contentView.webContents.loadURL('https://example.com')
  omnibarView.webContents.once('did-finish-load', () => {
    syncNavigationState()
    omnibarView.webContents.send('overlay-state', { visible: overlayVisible })
  })

  window.on('resize', layout)
  window.on('closed', () => {
    for (const view of [contentView, omnibarView, overlayView]) {
      if (view && !view.webContents.isDestroyed()) view.webContents.close()
    }
    window = undefined
    contentView = undefined
    omnibarView = undefined
    overlayView = undefined
  })

  if (process.env.ELECTRON_OVERLAY_SMOKE === '1' || stressMode) {
    Promise.all([
      new Promise((resolve) => contentView.webContents.once('did-finish-load', resolve)),
      new Promise((resolve) => omnibarView.webContents.once('did-finish-load', resolve)),
      new Promise((resolve) => overlayView.webContents.once('did-finish-load', resolve))
    ]).then(async () => {
      if (stressMode) await runStress()
      else await captureSmokeArtifacts()
      app.exit(0)
    }).catch((error) => {
      console.error(error)
      app.exit(1)
    })
  }
}

ipcMain.on('navigate', (_event, address) => {
  contentView.webContents.loadURL(normalizeAddress(String(address)))
})
ipcMain.on('navigate-back', () => contentView.webContents.navigationHistory.goBack())
ipcMain.on('navigate-forward', () => contentView.webContents.navigationHistory.goForward())
ipcMain.on('reload', () => contentView.webContents.reload())
ipcMain.on('toggle-overlay', () => setOverlayVisible(!overlayVisible))
ipcMain.on('dismiss-overlay', () => setOverlayVisible(false))

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
