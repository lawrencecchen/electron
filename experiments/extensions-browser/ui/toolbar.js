const address = document.querySelector('#address')
const status = document.querySelector('#status')
document.querySelector('#omnibar').addEventListener('submit', (event) => {
  event.preventDefault()
  window.extensionLab.navigate(address.value)
})
for (const button of document.querySelectorAll('[data-extension]')) {
  button.addEventListener('click', () => window.extensionLab.showExtension(button.dataset.extension))
}
document.querySelector('#close').addEventListener('click', window.extensionLab.hidePopup)
window.extensionLab.onState((state) => {
  if (document.activeElement !== address) address.value = state.url
  status.classList.toggle('ready', state.extensions.length === 2)
  for (const button of document.querySelectorAll('[data-extension]')) {
    button.classList.toggle('active', button.dataset.extension === state.activePopup)
  }
})
