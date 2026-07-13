import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { generateProbeFixtures, root } = require('./oracle-contract.cjs')
const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

const matrix = await generateProbeFixtures(path.resolve(option('--output', path.join(root, '.generated', 'oracle-probes'))), {
  platform: option('--platform'),
  collectorURL: option('--collector-url')
})
console.log(JSON.stringify(matrix, null, 2))
