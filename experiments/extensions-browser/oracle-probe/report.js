function encodeReport(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function setResult(prefix, value) {
  const encoded = encodeReport(value)
  document.title = `${prefix}:${encoded}`
  document.querySelector('#status').textContent = prefix === 'ORACLE_READY'
    ? 'Native chrome.management inventory captured.'
    : 'The native inventory failed.'
  document.querySelector('#report').textContent = JSON.stringify(value, null, 2)
}

chrome.management.getAll((items) => {
  if (chrome.runtime.lastError) {
    setResult('ORACLE_ERROR', { message: chrome.runtime.lastError.message })
    return
  }

  chrome.runtime.getPlatformInfo((platform) => {
    if (chrome.runtime.lastError) {
      setResult('ORACLE_ERROR', { message: chrome.runtime.lastError.message })
      return
    }

    const extensions = items.map((item) => ({
      enabled: item.enabled,
      id: item.id,
      installType: item.installType,
      mayDisable: item.mayDisable,
      name: item.name,
      type: item.type,
      version: item.version
    })).sort((left, right) => left.id.localeCompare(right.id))
    setResult('ORACLE_READY', { extensions, platform })
  })
})
