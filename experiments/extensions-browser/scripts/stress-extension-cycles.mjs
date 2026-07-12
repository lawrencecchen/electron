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

const cycles = integerOption('--cycles', 5)
const iterations = integerOption('--iterations', 50)
const reloadEvery = integerOption('--reload-every', 5)
const crashEvery = integerOption('--crash-every', 10)
const timeoutMS = integerOption('--timeout-ms', 180_000)
const profile = path.resolve(
  args.find((argument) => argument.startsWith('--profile='))?.slice('--profile='.length) ||
  path.join(artifacts, 'stress-profile')
)

function capture(stream, limit = 5 * 1024 * 1024) {
  const chunks = []
  let size = 0
  stream.on('data', (chunk) => {
    const buffer = Buffer.from(chunk)
    if (size + buffer.length <= limit) {
      chunks.push(buffer)
      size += buffer.length
    }
  })
  return chunks
}

async function runCycle(cycle) {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const result = await new Promise((resolve) => {
    const child = spawn(electron, [
      root,
      '--stress',
      `--stress-cycle=${cycle}`,
      `--stress-iterations=${iterations}`,
      `--stress-reload-every=${reloadEvery}`,
      `--stress-crash-every=${crashEvery}`,
      `--stress-profile=${profile}`
    ], {
      cwd: root,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const io = { stdout: capture(child.stdout), stderr: capture(child.stderr) }
    child.once('error', (error) => resolve({ error: error.stack || String(error), ...io }))
    child.once('exit', (code, signal) => resolve({ code, signal, ...io }))
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ timeout: true, ...io })
    }, timeoutMS)
    child.once('close', () => clearTimeout(timeout))
  })

  await Promise.all([
    fs.writeFile(path.join(artifacts, `stress-${cycle}.stdout.log`), Buffer.concat(result.stdout || [])),
    fs.writeFile(path.join(artifacts, `stress-${cycle}.stderr.log`), Buffer.concat(result.stderr || []))
  ])
  delete result.stdout
  delete result.stderr
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
      extensionReloads: report.extensionReloads,
      injectedRendererCrashes: report.injectedRendererCrashes,
      retainedGrowthAfterWarmupMB: report.retainedGrowthAfterWarmupMB,
      peakGrowthAfterWarmupMB: report.peakGrowthAfterWarmupMB,
      unexpectedRendererExits: report.diagnostics?.unexpectedRendererExits?.length || 0,
      unexpectedChildProcessExits: report.unexpectedChildProcessExits?.length || 0,
      unresponsive: report.diagnostics?.unresponsive?.length || 0,
      crashFiles: report.crashFiles || [],
      error: report.error
    },
    pass
  }
}

await fs.mkdir(artifacts, { recursive: true })
await fs.rm(profile, { recursive: true, force: true })
await fs.rm(path.join(artifacts, 'crashes'), { recursive: true, force: true })
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
  reloadEvery,
  crashEvery,
  totalExtensionReloads: results.reduce(
    (total, result) => total + (result.report?.extensionReloads || 0),
    0
  ),
  totalInjectedRendererCrashes: results.reduce(
    (total, result) => total + (result.report?.injectedRendererCrashes || 0),
    0
  ),
  results,
  pass: results.length === cycles && results.every((result) => result.pass)
}
await fs.writeFile(path.join(artifacts, 'stress-cycles.json'), `${JSON.stringify(summary, null, 2)}\n`)
if (!summary.pass) process.exitCode = 1
