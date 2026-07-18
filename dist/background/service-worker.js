// Background service worker — runs separately from the page.

chrome.runtime.onInstalled.addListener(() => {
  console.log('Gmail Cleanup extension installed.')
})

// When the user clicks the extension icon, tell the Gmail tab to show/hide the panel.
// The content script (content.js) receives this message and handles the toggle.
//
// Two cases used to throw "Could not establish connection. Receiving end does
// not exist." — a message sent to a tab with nothing listening:
//   1. The click happened on a non-Gmail tab (content.js only runs on Gmail).
//      → Open Gmail in a new tab instead.
//   2. The Gmail tab was already open BEFORE the extension was installed or
//      reloaded, so content.js was never injected into it.
//      → Reload that tab (which injects content.js), then open the panel.
// Tries to open the panel in a tab, retrying for a few seconds. Needed after
// opening/reloading a Gmail tab: content.js is injected at document_idle,
// which can land a moment AFTER the tab reports "complete" — so a single
// immediate message could still find nobody listening.
function togglePanelWhenReady(tabId, attemptsLeft = 15) {
  chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_PANEL' }).catch(() => {
    if (attemptsLeft > 1) {
      setTimeout(() => togglePanelWhenReady(tabId, attemptsLeft - 1), 400)
    }
  })
}

// Runs togglePanelWhenReady once the given tab finishes loading.
function togglePanelAfterLoad(tabId) {
  const onLoaded = (updatedTabId, info) => {
    if (updatedTabId === tabId && info.status === 'complete') {
      chrome.tabs.onUpdated.removeListener(onLoaded)
      togglePanelWhenReady(tabId)
    }
  }
  chrome.tabs.onUpdated.addListener(onLoaded)
}

chrome.action.onClicked.addListener((tab) => {
  const isGmail = tab.url && tab.url.startsWith('https://mail.google.com/')

  if (!isGmail) {
    // Open Gmail in a new tab, then show the panel as soon as it's ready.
    chrome.tabs.create({ url: 'https://mail.google.com/' }, (newTab) => {
      togglePanelAfterLoad(newTab.id)
    })
    return
  }

  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' }).catch(() => {
    // Gmail tab predates the extension — reload it to inject content.js,
    // then show the panel once the page has finished loading.
    chrome.tabs.reload(tab.id)
    togglePanelAfterLoad(tab.id)
  })
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
