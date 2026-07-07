// content.js — injected into Gmail pages by Chrome.
// Creates a floating side panel (an iframe) that houses the extension UI.
// The panel stays on the tab until the user closes it.

const PANEL_WIDTH = 400

let panel = null        // the wrapper div, once created
let visible = false
let nHObserver = null   // watches for Gmail resetting .nH's width

// Builds and attaches the panel to the Gmail page.
function createPanel() {
  const wrapper = document.createElement('div')
  wrapper.id = 'gmail-cleanup-panel'

  // Fixed panel on the right side, full height, on top of everything.
  wrapper.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    width: 400px;
    height: 100vh;
    z-index: 2147483647;
    box-shadow: -4px 0 20px rgba(0,0,0,0.2);
  `

  // The iframe loads the same index.html that was previously the popup.
  // chrome.runtime.getURL() gives us the correct chrome-extension:// URL.
  const iframe = document.createElement('iframe')
  iframe.src = chrome.runtime.getURL('index.html')
  iframe.style.cssText = `
    width: 100%;
    height: 100%;
    border: none;
    background: white;
  `

  wrapper.appendChild(iframe)
  document.body.appendChild(wrapper)
  return wrapper
}

function showPanel() {
  if (!panel) {
    panel = createPanel()
  } else {
    panel.style.display = 'block'
  }
  // Make .nH exactly 400px narrower than its current width.
  // We use setProperty with 'important' so it beats Gmail's own inline style.
  // A MutationObserver watches for Gmail resetting the width and re-applies ours.
  const nH = document.querySelector('.nH')
  if (nH) {
    const narrowed = nH.offsetWidth - PANEL_WIDTH

    function applyWidth() {
      nH.style.setProperty('width', narrowed + 'px', 'important')
    }
    applyWidth()

    nHObserver = new MutationObserver(() => {
      // If Gmail reset the width, put ours back
      if (nH.offsetWidth !== narrowed) applyWidth()
    })
    nHObserver.observe(nH, { attributes: true, attributeFilter: ['style'] })
  }
  visible = true
}

function hidePanel() {
  if (panel) panel.style.display = 'none'
  // Stop watching and let Gmail restore its own width
  if (nHObserver) { nHObserver.disconnect(); nHObserver = null }
  const nH = document.querySelector('.nH')
  if (nH) nH.style.removeProperty('width')
  visible = false
}

function togglePanel() {
  visible ? hidePanel() : showPanel()
}

// Background service worker sends this when the user clicks the extension icon.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TOGGLE_PANEL') togglePanel()
})

// App.jsx sends messages here for actions that require access to the Gmail page.
window.addEventListener('message', (event) => {
  if (event.data?.type === 'CLOSE_PANEL') hidePanel()

  // Navigate Gmail to a specific email by updating the URL hash.
  // Gmail responds to #all/<messageId> and opens that email directly.
  if (event.data?.type === 'OPEN_EMAIL') {
    window.location.hash = '#all/' + event.data.id
  }

  // Navigate Gmail to a search results view for the given query string, e.g.
  // "from:someone@example.com". Gmail responds to #search/<query> the same
  // way it would if you'd typed the query into its own search bar and hit enter.
  if (event.data?.type === 'OPEN_SEARCH') {
    window.location.hash = '#search/' + encodeURIComponent(event.data.query)
  }

  // Open a URL in the current tab — used for unsubscribe links.
  if (event.data?.type === 'OPEN_URL') {
    window.open(event.data.url, '_blank')
  }
})
