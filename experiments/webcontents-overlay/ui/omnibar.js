const address = document.querySelector('#address')
const back = document.querySelector('#back')
const forward = document.querySelector('#forward')
const status = document.querySelector('#status')
const overlay = document.querySelector('#overlay')

document.querySelector('#address-form').addEventListener('submit', (event) => {
  event.preventDefault()
  window.demo.navigate(address.value)
})
back.addEventListener('click', window.demo.back)
forward.addEventListener('click', window.demo.forward)
document.querySelector('#reload').addEventListener('click', window.demo.reload)
overlay.addEventListener('click', window.demo.toggleOverlay)

window.demo.onBrowserState((state) => {
  if (document.activeElement !== address) address.value = state.url
  back.disabled = !state.canGoBack
  forward.disabled = !state.canGoForward
  status.classList.toggle('loading', state.loading)
})
window.demo.onOverlayState(({ visible }) => {
  overlay.classList.toggle('active', visible)
})
window.demo.onFocusAddress(() => {
  address.focus()
  address.select()
})
