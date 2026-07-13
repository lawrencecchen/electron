function memberPaths(surface) {
  const result = new Map()
  for (const namespace of surface?.namespaces || []) result.set(namespace, 'object')
  for (const [namespace, members] of Object.entries(surface?.members || {})) {
    for (const [member, type] of Object.entries(members)) result.set(`${namespace}.${member}`, type)
  }
  return result
}

function surfaceDifference(chromium, electron) {
  const left = memberPaths(chromium?.surface)
  const right = memberPaths(electron?.surface)
  const removed = [...left.keys()].filter((key) => !right.has(key)).sort()
  const added = [...right.keys()].filter((key) => !left.has(key)).sort()
  const typeChanged = [...left.keys()].filter((key) => right.has(key) && left.get(key) !== right.get(key))
    .sort().map((key) => ({ path: key, chromium: left.get(key), electron: right.get(key) }))
  return {
    evidenceEligible: false,
    reason: 'Namespace and member visibility is surface diagnostics, not semantic conformance proof.',
    added,
    removed,
    typeChanged
  }
}

function behaviorDifferences(chromium, electron, pinnedVersions) {
  const left = new Map((chromium?.behavior || []).map((result) => [result.id, result]))
  const right = new Map((electron?.behavior || []).map((result) => [result.id, result]))
  return [...new Set([...left.keys(), ...right.keys()])].sort().map((id) => {
    const chromiumResult = left.get(id)
    const electronResult = right.get(id)
    const matchedPass = chromiumResult?.status === 'pass' && electronResult?.status === 'pass'
    return {
      id,
      feature: chromiumResult?.feature || electronResult?.feature || null,
      chromium: chromiumResult || null,
      electron: electronResult || null,
      match: chromiumResult?.status === electronResult?.status,
      evidenceCandidate: matchedPass && pinnedVersions,
      coverage: 'partial'
    }
  })
}

module.exports = { behaviorDifferences, memberPaths, surfaceDifference }
