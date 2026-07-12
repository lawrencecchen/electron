const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const ghostty = require('./build/Release/ghostty_embed.node')

let window
let terminal

const terminalBounds = () => {
  const [width, height] = window.getContentSize()
  return {
    x: 16,
    y: 64,
    width: Math.max(320, Math.floor(width * 0.62) - 24),
    height: Math.max(240, height - 80)
  }
}

app.whenReady().then(async () => {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0b0d10',
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  })

  await window.loadFile(path.join(__dirname, 'renderer.html'))

  terminal = ghostty.create(window.getNativeWindowHandle(), {
    ...terminalBounds(),
    workingDirectory: process.cwd(),
    command: process.env.SHELL || '/bin/zsh'
  })

  window.on('resize', () => {
    if (terminal) ghostty.setBounds(terminal, terminalBounds())
  })

  window.on('closed', () => {
    terminal = undefined
    window = undefined
  })
})

app.on('window-all-closed', () => app.quit())
