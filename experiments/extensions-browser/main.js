const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const { app, BaseWindow, WebContentsView, ipcMain, session } = require('electron')
const { ElectronChromeExtensions } = require('electron-chrome-extensions')

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
const artifacts = path.join(root, 'artifacts')

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
    const extension = await ses.extensions.loadExtension(
      path.join(extensionRoot, descriptor.directory),
      { allowFileAccess: true }
    )
    const view = new WebContentsView({
      webPreferences: { session: ses, contextIsolation: true, sandbox: true }
    })
    view.setBackgroundColor('#ffffff')
    view.setVisible(false)
    attachDiagnostics(`${descriptor.name}:popup`, view.webContents)
    loaded.set(descriptor.name, { ...descriptor, extension, view, loadedPopup: false })
  }
}

async function showExtension(name) {
  const item = loaded.get(name)
  if (!item) return
  if (activePopup && activePopup !== item) activePopup.view.setVisible(false)
  activePopup = item
  window.contentView.addChildView(item.view)
  item.view.setVisible(true)
  if (!item.loadedPopup) {
    await item.view.webContents.loadURL(`chrome-extension://${item.extension.id}/${item.popup}`)
    item.loadedPopup = true
  }
  await item.view.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
  )
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

async function runSmoke() {
  await fs.mkdir(artifacts, { recursive: true })
  const report = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
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
        api: await inventoryChromeAPIs(item.view.webContents)
      })
    } catch (error) {
      report.extensions[descriptor.name].error = error.stack || String(error)
    }
  }
  report.consoleEvents = consoleEvents
  await fs.writeFile(path.join(artifacts, 'compatibility.json'), JSON.stringify(report, null, 2))
  app.exit(0)
}

async function createWindow() {
  await createFixtureServer()
  const ses = session.fromPartition('persist:extension-lab')
  chromeExtensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: ses,
    requestPermissions: async () => true
  })
  ses.extensions.on('extension-loaded', (_event, extension) => {
    consoleEvents.push({ time: new Date().toISOString(), event: 'extension-loaded', id: extension.id, name: extension.name })
  })
  ses.extensions.on('extension-ready', (_event, extension) => {
    consoleEvents.push({ time: new Date().toISOString(), event: 'extension-ready', id: extension.id, name: extension.name })
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
  chromeExtensions.addTab(content.webContents, window)
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

  if (process.env.ELECTRON_EXTENSION_SMOKE === '1') await runSmoke()
}

ipcMain.on('lab:navigate', (_event, address) => content.webContents.loadURL(normalizeAddress(address)))
ipcMain.on('lab:show-extension', (_event, name) => showExtension(String(name)))
ipcMain.on('lab:hide-popup', hidePopup)

app.whenReady().then(createWindow).catch((error) => {
  console.error(error)
  app.exit(1)
})
app.on('window-all-closed', () => app.quit())
