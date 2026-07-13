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

function integerOption(name, fallback, minimum = 0) {
  const value = args.find((argument) => argument.startsWith(`${name}=`))?.split('=')[1]
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback
}

const cycles = integerOption('--cycles', 5, 1)
const iterations = integerOption('--iterations', 50, 1)
const reloadEvery = integerOption('--reload-every', 5)
const crashEvery = integerOption('--crash-every', 10)
const timeoutMS = integerOption('--timeout-ms', 180_000, 1_000)
const runID = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`
const runArtifacts = path.resolve(
  args.find((argument) => argument.startsWith('--artifacts='))?.slice('--artifacts='.length) ||
  path.join(artifacts, 'stress-runs', runID)
)
const profile = path.resolve(
  args.find((argument) => argument.startsWith('--profile='))?.slice('--profile='.length) ||
  path.join(runArtifacts, 'profile')
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
  const reportPath = path.join(runArtifacts, `stress-${cycle}.json`)
  const stdoutPath = path.join(runArtifacts, `stress-${cycle}.stdout.log`)
  const stderrPath = path.join(runArtifacts, `stress-${cycle}.stderr.log`)
  const progressPath = path.join(runArtifacts, `stress-${cycle}-progress.json`)
  await Promise.all([
    fs.rm(reportPath, { force: true }),
    fs.rm(stdoutPath, { force: true }),
    fs.rm(stderrPath, { force: true }),
    fs.rm(progressPath, { force: true })
  ])
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
      `--stress-artifacts=${runArtifacts}`,
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
    fs.writeFile(stdoutPath, Buffer.concat(result.stdout || [])),
    fs.writeFile(stderrPath, Buffer.concat(result.stderr || []))
  ])
  delete result.stdout
  delete result.stderr
  let report
  try {
    report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
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
await fs.mkdir(runArtifacts, { recursive: true })
await fs.rm(profile, { recursive: true, force: true })
const results = []
for (let cycle = 1; cycle <= cycles; cycle += 1) {
  const result = await runCycle(cycle)
  results.push(result)
  console.log(JSON.stringify(result))
  if (!result.pass) break
}

const summary = {
  electron,
  runID,
  runArtifacts,
  profile,
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
const serializedSummary = `${JSON.stringify(summary, null, 2)}\n`
await Promise.all([
  fs.writeFile(path.join(runArtifacts, 'stress-cycles.json'), serializedSummary),
  fs.writeFile(path.join(artifacts, 'stress-cycles.json'), serializedSummary)
])
if (!summary.pass) process.exitCode = 1
