const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const ghostty = require('./build/Release/ghostty_embed.node')

let window
let terminal

const artifacts = path.join(__dirname, 'artifacts')
const stressMode = process.argv.includes('--stress')
const integerArgument = (name, fallback) => {
  const value = process.argv.find((argument) => argument.startsWith(`${name}=`))?.split('=')[1]
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
const stressIterations = integerArgument('--stress-iterations', 100)
const stressResizes = integerArgument('--stress-resizes', 40)
const stressCycle = integerArgument('--stress-cycle', 0)
const diagnostics = { renderProcessGone: [], unresponsive: [], memory: [] }

const terminalBounds = () => {
  const [width, height] = window.getContentSize()
  return {
    x: 16,
    y: 64,
    width: Math.max(320, Math.floor(width * 0.62) - 24),
    height: Math.max(240, height - 80)
  }
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

async function sampleMemory(iteration) {
  diagnostics.memory.push({
    iteration,
    browser: await process.getProcessMemoryInfo(),
    processes: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      memory: metric.memory
    }))
  })
}

async function runStress() {
  await fs.mkdir(artifacts, { recursive: true })
  await sampleMemory(0)
  for (let iteration = 1; iteration <= stressIterations; iteration += 1) {
    terminal = ghostty.create(window.getNativeWindowHandle(), {
      ...terminalBounds(),
      workingDirectory: process.cwd(),
      command: process.env.SHELL || '/bin/zsh'
    })
    ghostty.sendText(
      terminal,
      `printf '\\033[3${iteration % 8}mghostty-stress-${stressCycle}-${iteration}\\033[0m\\n'; ` +
        `i=0; while [ $i -lt 300 ]; do printf 'row-%04d \\033[3%dmcolor\\033[0m\\n' $i $((i % 8)); i=$((i + 1)); done\n`
    )
    for (let resize = 0; resize < stressResizes; resize += 1) {
      const bounds = terminalBounds()
      ghostty.setBounds(terminal, {
        ...bounds,
        width: Math.max(320, bounds.width - ((resize * 17) % 180)),
        height: Math.max(240, bounds.height - ((resize * 13) % 140))
      })
      if (resize % 5 === 0) await nextTurn()
    }
    await nextTurn()
    ghostty.destroy(terminal)
    terminal = undefined
    await nextTurn()
    if (iteration % 5 === 0 || iteration === stressIterations) await sampleMemory(iteration)
  }

  const first = diagnostics.memory.at(0)
  const last = diagnostics.memory.at(-1)
  const totalWorkingSet = (sample) => sample.processes.reduce(
    (total, metric) => total + (metric.memory?.workingSetSize || 0),
    0
  )
  const browserPrivateGrowthMB = (last.browser.private - first.browser.private) / 1024
  const totalWorkingSetGrowthMB = (totalWorkingSet(last) - totalWorkingSet(first)) / 1024
  const warmup = diagnostics.memory.find((sample) => sample.iteration >= Math.min(10, stressIterations)) || first
  const retainedGrowthAfterWarmupMB = (totalWorkingSet(last) - totalWorkingSet(warmup)) / 1024
  const peakGrowthAfterWarmupMB = (
    Math.max(...diagnostics.memory.filter((sample) => sample.iteration >= warmup.iteration).map(totalWorkingSet)) -
    totalWorkingSet(warmup)
  ) / 1024
  const maxRetainedGrowthMB = Number.parseInt(
    process.env.GHOSTTY_STRESS_MAX_RETAINED_GROWTH_MB || '64',
    10
  )
  const report = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    cycle: stressCycle,
    iterations: stressIterations,
    resizesPerIteration: stressResizes,
    browserPrivateGrowthMB,
    totalWorkingSetGrowthMB,
    warmupIteration: warmup.iteration,
    retainedGrowthAfterWarmupMB,
    peakGrowthAfterWarmupMB,
    maxRetainedGrowthMB,
    diagnostics,
    pass: diagnostics.renderProcessGone.length === 0 &&
      diagnostics.unresponsive.length === 0 &&
      retainedGrowthAfterWarmupMB <= maxRetainedGrowthMB &&
      peakGrowthAfterWarmupMB <= maxRetainedGrowthMB
  }
  await fs.writeFile(path.join(artifacts, `stress-${stressCycle}.json`), `${JSON.stringify(report, null, 2)}\n`)
  if (!report.pass) throw new Error(`libghostty stress failed: ${JSON.stringify({
    renderProcessGone: diagnostics.renderProcessGone.length,
    unresponsive: diagnostics.unresponsive.length,
    browserPrivateGrowthMB,
    totalWorkingSetGrowthMB,
    retainedGrowthAfterWarmupMB,
    peakGrowthAfterWarmupMB
  })}`)
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

  window.webContents.on('render-process-gone', (_event, details) => {
    diagnostics.renderProcessGone.push(details)
  })
  window.on('unresponsive', () => diagnostics.unresponsive.push({ time: new Date().toISOString() }))

  if (stressMode) {
    await runStress()
    app.exit(0)
    return
  }

  terminal = ghostty.create(window.getNativeWindowHandle(), {
    ...terminalBounds(),
    workingDirectory: process.cwd(),
    command: process.env.SHELL || '/bin/zsh'
  })

  window.on('resize', () => {
    if (terminal) ghostty.setBounds(terminal, terminalBounds())
  })

  window.on('closed', () => {
    if (terminal) ghostty.destroy(terminal)
    terminal = undefined
    window = undefined
  })
}).catch((error) => {
  console.error(error)
  app.exit(1)
})

app.on('window-all-closed', () => app.quit())
