import { spawn } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const printCommand = args.includes('--print-command')
const forwardedArgs = args.filter((argument) => argument !== '--print-command')
const electron = process.env.ELECTRON_BINARY || require('electron')
const childArgs = [root, ...forwardedArgs]
const env = { ...process.env, ELECTRON_OVERLAY_SMOKE: '1' }

if (printCommand) {
  console.log(JSON.stringify({
    arguments: childArgs,
    electron,
    environment: { ELECTRON_OVERLAY_SMOKE: env.ELECTRON_OVERLAY_SMOKE },
    platform: process.platform
  }, null, 2))
  process.exit(0)
}

const child = spawn(electron, childArgs, {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true
})

child.once('error', (error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`overlay smoke Electron exited from signal ${signal}`)
    process.exitCode = 1
  } else {
    process.exitCode = code ?? 1
  }
})
