import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(root, 'artifacts')
const electron = require('electron')
const args = process.argv.slice(2)

function integerOption(name, fallback) {
  const value = args.find((argument) => argument.startsWith(`${name}=`))?.split('=')[1]
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const cycles = integerOption('--cycles', 10)
const iterations = integerOption('--iterations', 200)
const crashEvery = integerOption('--crash-every', 25)
const timeoutMS = integerOption('--timeout-ms', 120_000)

async function runCycle(cycle) {
  const childArgs = [
    root,
    '--stress',
    `--stress-cycle=${cycle}`,
    `--stress-iterations=${iterations}`,
    `--stress-crash-every=${crashEvery}`
  ]
  const output = []
  const errors = []
  const startedAt = new Date().toISOString()
  const started = performance.now()

  const result = await new Promise((resolve) => {
    const child = spawn(electron, childArgs, {
      cwd: root,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    child.stdout.on('data', (chunk) => output.push(chunk))
    child.stderr.on('data', (chunk) => errors.push(chunk))
    child.once('error', (error) => resolve({ error: error.stack || String(error) }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ timeout: true })
    }, timeoutMS)
    child.once('close', () => clearTimeout(timeout))
  })

  const stdout = Buffer.concat(output).toString('utf8')
  const stderr = Buffer.concat(errors).toString('utf8')
  await Promise.all([
    fs.writeFile(path.join(artifacts, `stress-${cycle}.stdout.log`), stdout),
    fs.writeFile(path.join(artifacts, `stress-${cycle}.stderr.log`), stderr)
  ])

  let report
  try {
    report = JSON.parse(await fs.readFile(path.join(artifacts, `stress-${cycle}.json`), 'utf8'))
  } catch (error) {
    result.reportError = error.message
  }
  const pass = result.code === 0 && !result.signal && !result.timeout && !result.error && report?.pass === true
  return {
    cycle,
    startedAt,
    durationMS: performance.now() - started,
    result,
    report: report && {
      iterations: report.iterations,
      injectedRendererCrashes: report.injectedRendererCrashes,
      browserPrivateGrowthMB: report.browserPrivateGrowthMB,
      totalWorkingSetGrowthMB: report.totalWorkingSetGrowthMB,
      unexpectedRendererExits: report.diagnostics.unexpectedRendererExits.length,
      unresponsive: report.diagnostics.unresponsive.length,
      crashFiles: report.crashFiles
    },
    pass
  }
}

await fs.mkdir(artifacts, { recursive: true })
const results = []
for (let cycle = 1; cycle <= cycles; cycle += 1) {
  const result = await runCycle(cycle)
  results.push(result)
  console.log(JSON.stringify(result))
  if (!result.pass) break
}

const summary = {
  electron,
  cyclesRequested: cycles,
  cyclesCompleted: results.length,
  iterationsPerCycle: iterations,
  rendererCrashInterval: crashEvery,
  totalInjectedRendererCrashes: results.reduce(
    (total, result) => total + (result.report?.injectedRendererCrashes || 0),
    0
  ),
  results,
  pass: results.length === cycles && results.every((result) => result.pass)
}
await fs.writeFile(path.join(artifacts, 'stress-cycles.json'), `${JSON.stringify(summary, null, 2)}\n`)
if (!summary.pass) process.exitCode = 1
