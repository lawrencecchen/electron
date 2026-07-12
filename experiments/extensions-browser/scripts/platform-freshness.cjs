function compareChromiumVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0)
  }
  return 0
}

function chromiumVersionFromVersionFile(value) {
  const fields = Object.fromEntries(value.trim().split(/\r?\n/).map((line) => line.split('=', 2)))
  for (const key of ['MAJOR', 'MINOR', 'BUILD', 'PATCH']) {
    if (!/^\d+$/.test(fields[key] || '')) throw new Error(`Chromium VERSION is missing ${key}`)
  }
  return `${fields.MAJOR}.${fields.MINOR}.${fields.BUILD}.${fields.PATCH}`
}

function newestTaggedVersion(refs, major) {
  // Electron rolls Chromium's buildable branch snapshots, whose PATCH is 0.
  // Release patch tags such as x.y.z.1 are not Electron DEPS roll targets.
  const pattern = new RegExp(`^${major}\\.\\d+\\.\\d+\\.0$`)
  return Object.keys(refs).filter((version) => pattern.test(version)).sort(compareChromiumVersions).at(-1)
}

module.exports = { chromiumVersionFromVersionFile, compareChromiumVersions, newestTaggedVersion }
