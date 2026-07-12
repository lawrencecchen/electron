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

async function captureSmokeArtifacts() {
  const artifacts = path.join(__dirname, 'artifacts')
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

  if (process.env.ELECTRON_OVERLAY_SMOKE === '1') {
    Promise.all([
      new Promise((resolve) => contentView.webContents.once('did-finish-load', resolve)),
      new Promise((resolve) => omnibarView.webContents.once('did-finish-load', resolve)),
      new Promise((resolve) => overlayView.webContents.once('did-finish-load', resolve))
    ]).then(async () => {
      await captureSmokeArtifacts()
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
