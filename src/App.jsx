// App.jsx — top-level component. Handles connecting to Gmail and switching
// between the two tabs. Each tab manages its own data/state in its own file
// (SearchTab.jsx, SendersTab.jsx) — App.jsx just decides which one is visible.

import { useState, useEffect, useRef } from 'react'
import { getToken, GmailAuthError } from './auth.js'
import { untrashMessage, restoreToInbox } from './gmail.js'
import Tabs from './Tabs.jsx'
import SearchTab from './SearchTab.jsx'
import SendersTab from './SendersTab.jsx'

export default function App() {
  const [account, setAccount] = useState(null)
  const [status, setStatus] = useState('')
  const [activeTab, setActiveTab] = useState('search')

  // True once any Gmail action in either tab hits an expired/revoked token
  // (a GmailAuthError — see auth.js/gmail.js). Shown as a small banner with a
  // Reconnect button instead of leaving the person staring at a raw "401"
  // error with no obvious next step.
  const [needsReconnect, setNeedsReconnect] = useState(false)

  // --- Undo ---
  // Lives here (not in each tab) so it can pop up as one consistent toast at
  // the very bottom of the whole panel, regardless of which tab the action
  // happened in. `lastAction` is null when there's nothing to undo, or
  // { type: 'trash' | 'archive', ids } right after a Trash/Archive/Delete
  // action — both tabs report their actions here via the onAction prop
  // instead of showing their own Undo control. Auto-dismisses after a short
  // delay so it doesn't linger like a permanent part of the UI.
  const [lastAction, setLastAction] = useState(null)
  const [undoing, setUndoing] = useState(false)
  const undoTimeoutRef = useRef(null)

  // `restoreLocal` is an optional callback the reporting tab provides — once
  // the Gmail-side untrash below actually succeeds, it puts the removed rows
  // back into that tab's own list (so Undo visibly returns them, not just
  // reverses things silently on Gmail's side).
  function rememberUndo(type, ids, restoreLocal) {
    if (!ids || ids.length === 0) return
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current)
    setLastAction({ type, ids, restoreLocal })
    undoTimeoutRef.current = setTimeout(() => setLastAction(null), 20000)
  }

  function dismissUndo() {
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current)
    setLastAction(null)
  }

  async function handleUndo() {
    if (!lastAction) return
    const { type, ids, restoreLocal } = lastAction
    setUndoing(true)
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current)
    setLastAction(null)
    try {
      const token = await getToken(false)
      const apiFn = type === 'archive' ? restoreToInbox : untrashMessage
      for (let i = 0; i < ids.length; i += 10) {
        const batch = ids.slice(i, i + 10)
        await Promise.allSettled(batch.map((id) => apiFn(token, id)))
        if (i + 10 < ids.length) await new Promise((r) => setTimeout(r, 300))
      }
      restoreLocal?.()
      setStatus(`Undone — ${ids.length} email${ids.length !== 1 ? 's' : ''} restored.`)
    } catch (err) {
      if (err instanceof GmailAuthError) {
        setNeedsReconnect(true)
        setStatus('Your Gmail connection expired — click "Reconnect Gmail" above to continue.')
      } else {
        setStatus('Error undoing: ' + err.message)
      }
    } finally {
      setUndoing(false)
    }
  }

  // Fetches the Gmail profile to confirm the token works and show "Connected as ...".
  async function fetchAccount(token) {
    const data = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json())
    setAccount(data.emailAddress)
    setNeedsReconnect(false)
  }

  // On mount: try to connect silently (no consent popup) using a token we
  // already have permission for from a previous session.
  useEffect(() => {
    getToken(false)
      .then(fetchAccount)
      .catch(() => {})
  }, [])

  // Only called when the user clicks Connect for the first time.
  // interactive=true shows the OAuth consent screen.
  function handleConnect() {
    setStatus('Connecting...')
    getToken(true)
      .then(fetchAccount)
      .then(() => setStatus(''))
      .catch((err) => setStatus('Error: ' + err.message))
  }

  return (
    // h-screen + flex-col gives the panel a real, fixed height to work with —
    // the tab area below (flex-1) fills whatever's left after the header, so
    // a tab's results list can stretch to fill the panel instead of stopping
    // short and leaving blank space underneath it.
    <div className="h-screen flex flex-col p-4 font-sans relative">

      {/* Close button — posts a message to content.js, which hides the panel */}
      <button
        onClick={() => window.parent.postMessage({ type: 'CLOSE_PANEL' }, '*')}
        className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 text-base leading-none"
        title="Close panel"
      >
        ✕
      </button>

      <h1 className="shrink-0 text-lg font-bold mb-3">Gmail Cleanup</h1>

      {!account ? (
        <button
          onClick={handleConnect}
          className="shrink-0 px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
        >
          Connect Gmail
        </button>
      ) : (
        <p className="shrink-0 text-xs text-gray-500">Connected as {account}</p>
      )}

      {status && <p className="shrink-0 mt-2 text-sm text-gray-600">{status}</p>}

      {/* Reconnect prompt — small and inline, not a full-screen blocker, so
          whatever the person was looking at (scan/search results) stays put.
          They just need to click through Google's sign-in again before
          further Gmail actions will work. */}
      {needsReconnect && (
        <div className="shrink-0 mt-2 flex items-center gap-2 text-xs bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
          <span className="text-amber-700">Your Gmail connection expired.</span>
          <button
            onClick={handleConnect}
            className="px-2 py-0.5 bg-amber-600 text-white rounded hover:bg-amber-700 shrink-0"
          >
            Reconnect Gmail
          </button>
        </div>
      )}

      {account && (
        <div className="mt-4 flex-1 flex flex-col min-h-0">
          <Tabs active={activeTab} onChange={setActiveTab} />

          {/* Each tab is kept mounted once visited so switching tabs doesn't
              lose its scan results — only the one matching activeTab is shown.
              Both get flex-1 + min-h-0 so their own results list (which is
              itself flex-1 inside each tab) has real, bounded space to fill
              and scroll within, instead of growing past the panel and
              relying on the page itself to scroll. Both also get onAuthError
              (shows the Reconnect banner above) and onAction (reports a
              Trash/Archive/Delete so the Undo toast below can pop up),
              regardless of which tab is active. */}
          <div className="flex-1 min-h-0" style={{ display: activeTab === 'search' ? 'block' : 'none' }}>
            <SearchTab onAuthError={() => setNeedsReconnect(true)} onAction={rememberUndo} />
          </div>
          <div className="flex-1 min-h-0" style={{ display: activeTab === 'senders' ? 'block' : 'none' }}>
            <SendersTab onAuthError={() => setNeedsReconnect(true)} onAction={rememberUndo} />
          </div>
        </div>
      )}

      {/* Undo toast — pinned at the very bottom of the whole panel, only
          appearing right after a Trash/Archive/Delete action. `shrink-0`
          makes the tab area above shrink to make room for it (a small shift
          upward) rather than the toast floating over the content. */}
      {lastAction && (
        <div className="shrink-0 mt-2 flex items-center justify-between gap-2 text-xs bg-gray-800 text-white rounded px-3 py-2">
          <span>
            {lastAction.ids.length} email{lastAction.ids.length !== 1 ? 's' : ''}{' '}
            {lastAction.type === 'archive' ? 'archived' : 'moved to Trash'}.
          </span>
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={handleUndo}
              disabled={undoing}
              className="text-blue-300 hover:text-blue-200 hover:underline disabled:opacity-50 font-medium"
            >
              {undoing ? 'Undoing...' : 'Undo'}
            </button>
            <button
              onClick={dismissUndo}
              title="Dismiss"
              className="text-gray-400 hover:text-gray-200 leading-none"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
