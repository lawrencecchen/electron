import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cache = path.join(root, 'fixtures', 'downloads')
const destination = path.join(root, 'fixtures', 'extensions')

const releases = [
  {
    name: 'ublock',
    version: '1.72.2',
    archive: 'uBlock0_1.72.2.chromium.zip',
    url: 'https://github.com/gorhill/uBlock/releases/download/1.72.2/uBlock0_1.72.2.chromium.zip',
    nestedDirectory: 'uBlock0.chromium'
  },
  {
    name: 'bitwarden',
    version: '2026.6.1',
    archive: 'dist-chrome-2026.6.1.zip',
    url: 'https://github.com/bitwarden/clients/releases/download/browser-v2026.6.1/dist-chrome-2026.6.1.zip'
  }
]

await fs.mkdir(cache, { recursive: true })
await fs.mkdir(destination, { recursive: true })

for (const release of releases) {
  const archivePath = path.join(cache, release.archive)
  try {
    await fs.access(archivePath)
  } catch {
    const response = await fetch(release.url)
    if (!response.ok) throw new Error(`download failed (${response.status}): ${release.url}`)
    await fs.writeFile(archivePath, Buffer.from(await response.arrayBuffer()))
  }

  const staging = path.join(destination, `${release.name}-staging`)
  const target = path.join(destination, release.name)
  await fs.rm(staging, { recursive: true, force: true })
  await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  new AdmZip(archivePath).extractAllTo(staging, true)
  if (release.nestedDirectory) {
    await fs.rename(path.join(staging, release.nestedDirectory), target)
    await fs.rm(staging, { recursive: true, force: true })
  } else {
    await fs.rename(staging, target)
  }
  const manifest = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8'))
  console.log(`${release.name}: ${manifest.name} ${manifest.version}, manifest v${manifest.manifest_version}`)
}
