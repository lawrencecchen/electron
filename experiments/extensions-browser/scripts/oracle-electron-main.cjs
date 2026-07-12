const path = require('node:path')
const { app, BrowserWindow, session } = require('electron')

const args = process.argv.slice(2)
function option(name) {
  const argument = args.find((value) => value.startsWith(`${name}=`))
  return argument?.slice(name.length + 1)
}

const fixtureRoot = option('--fixture-root')
const pageURL = option('--page-url')
const matrixPath = option('--matrix')
const userData = option('--user-data-dir')
if (!fixtureRoot || !pageURL || !matrixPath || !userData) throw new Error('fixture-root, page-url, matrix, and user-data-dir are required')
app.setPath('userData', path.resolve(userData))
const matrix = require(path.resolve(matrixPath))
const windows = []

async function openURL(url, ses) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { session: ses, contextIsolation: true, sandbox: true }
  })
  windows.push(window)
  await window.loadURL(url)
}

app.whenReady().then(async () => {
  const ses = session.fromPartition(`persist:oracle-${Date.now()}`)
  for (const manifestVersion of [2, 3]) {
    try {
      const extension = await ses.extensions.loadExtension(path.join(fixtureRoot, `mv${manifestVersion}`), { allowFileAccess: false })
      const expectedId = matrix.extensionIds[`mv${manifestVersion}`]
      if (extension.id !== expectedId) throw new Error(`MV${manifestVersion} extension id ${extension.id} differs from ${expectedId}`)
    } catch (error) {
      console.error(`MV${manifestVersion} load failed:`, error.stack || error)
    }
  }
  await openURL(pageURL, ses)
  for (const manifestVersion of [2, 3]) {
    const id = matrix.extensionIds[`mv${manifestVersion}`]
    for (const context of [`mv${manifestVersion}_extension_page`, `mv${manifestVersion}_popup`]) {
      try {
        await openURL(`chrome-extension://${id}/probe.html?context=${context}`, ses)
      } catch (error) {
        console.error(`${context} load failed:`, error.stack || error)
      }
    }
  }
}).catch((error) => {
  console.error(error.stack || error)
  app.exit(1)
})

app.on('window-all-closed', () => {})
