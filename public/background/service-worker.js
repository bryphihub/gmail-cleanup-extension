// Background service worker — runs separately from the page.

chrome.runtime.onInstalled.addListener(() => {
  console.log('Gmail Cleanup extension installed.')
})

// When the user clicks the extension icon, tell the Gmail tab to show/hide the panel.
// The content script (content.js) receives this message and handles the toggle.
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' })
})

// Fetches an unsubscribe URL on behalf of App.jsx and returns the response body.
// The service worker has full cross-origin access (via host_permissions in manifest.json),
// so it can read the response — unlike fetch() calls from the page context.
// App.jsx sends { type: 'FETCH_UNSUB', url } and gets back { ok, status, body }.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_UNSUB') {
    fetch(msg.url, { redirect: 'follow' })
      .then(async (res) => {
        // Read enough of the body to detect whether it's a confirmation form or a success page.
        const text = await res.text()
        sendResponse({ ok: true, status: res.status, body: text.slice(0, 5000) })
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message })
      })
    return true // tells Chrome to keep the message channel open for the async response
  }
})
