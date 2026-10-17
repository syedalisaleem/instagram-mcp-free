/**
 * Status only. Everything real happens in the offscreen document — this panel just reads the
 * state the service worker persists on its behalf and can request a re-dial when the port
 * changes. If the offscreen document recorded a fault, it is shown here rather than leaving
 * "Not connected" as the only possible explanation.
 */

const DEFAULT_URL = 'ws://127.0.0.1:48233/'

const dot = document.getElementById('dot')
const label = document.getElementById('label')
const meta = document.getElementById('meta')
const url = document.getElementById('url')
const save = document.getElementById('save')

const render = state => {
  const fault = state.error ? ` — ${state.error}` : ''

  if (state.connected) {
    dot.className = 'dot on'
    label.textContent = 'Paired'
    const since = state.since ? new Date(state.since).toLocaleTimeString() : ''
    meta.textContent = `${since ? `Connected since ${since}` : ''}${fault}`
    return
  }

  if (state.connecting) {
    dot.className = 'dot busy'
    label.textContent = 'Connecting…'
    meta.textContent = `Is the driver running?${fault}`
    return
  }

  dot.className = 'dot'
  label.textContent = 'Not connected'
  meta.textContent = `Start the driver, then reopen this panel.${fault}`
}

const refresh = async () => {
  const state = ((await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'status' })) ??
    (await chrome.storage.local.get('driver')).driver) ?? {}
  url.value = state.url || DEFAULT_URL
  render(state)
}

save.addEventListener('click', async () => {
  const next = url.value.trim() || DEFAULT_URL
  await chrome.storage.local.set({ driver: { url: next, connected: false, connecting: true } })
  await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'reconnect' })
  save.textContent = 'Reconnecting…'
  setTimeout(() => {
    save.textContent = 'Save & reconnect'
    void refresh()
  }, 1200)
})

// Follow live state while the panel is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.driver) render(changes.driver.newValue ?? {})
})

void refresh()
setInterval(() => void refresh(), 2000)
