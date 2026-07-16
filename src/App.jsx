// App.jsx — top-level component. Handles connecting to Gmail and switching
// between the two tabs. Each tab manages its own data/state in its own file
// (SearchTab.jsx, SendersTab.jsx) — App.jsx just decides which one is visible.
//
// Visual design follows the "Porcelain" handoff (see design tokens in
// index.css): header bar with the app mark + connected account, segmented
// tab switch with a sliding thumb, and a dark Undo toast with a countdown
// bar pinned to the bottom of the panel.

import { useState, useEffect, useRef } from 'react'
import { getToken, GmailAuthError } from './auth.js'
import { untrashMessage, restoreToInbox } from './gmail.js'
import { Segmented } from './ui.jsx'
import SearchTab from './SearchTab.jsx'
import SendersTab from './SendersTab.jsx'

// How long the Undo toast stays up (and how long its countdown bar takes to
// empty). The design allows 3–15s; 10 is its default.
const UNDO_SECONDS = 10

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
  // instead of showing their own Undo control. Auto-dismisses after
  // UNDO_SECONDS, matching the countdown bar animating across the toast.
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
    setLastAction({ type, ids, restoreLocal, at: Date.now() })
    undoTimeoutRef.current = setTimeout(() => setLastAction(null), UNDO_SECONDS * 1000)
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

  // Fetches the Gmail profile to confirm the token works and show the account.
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
    // a tab's results list can stretch to fill the panel.
    <div className="h-screen flex flex-col relative overflow-hidden">

      {/* Header — app mark, title, connected account, close */}
      <div className="flex items-center gap-2 shrink-0" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
        <div
          className="grid place-items-center shrink-0"
          style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--accent-grad)', color: 'var(--accent-ink)' }}
        >
          {/* little broom mark from the design */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M2 9.5h8" /><path d="M4 6.5 6 2l2 4.5" /><path d="M3.2 9.5 4 6.5h4l.8 3" />
          </svg>
        </div>
        <div style={{ fontWeight: 600, fontSize: 13, letterSpacing: '-0.01em' }}>Gmail Cleanup</div>
        {account && (
          <div
            className="ml-auto overflow-hidden text-ellipsis whitespace-nowrap"
            style={{ fontSize: 11, color: 'var(--sub)', maxWidth: 160 }}
            title="Connected Google account"
          >
            {account}
          </div>
        )}
        {/* Close button — posts a message to content.js, which hides the panel */}
        <button
          onClick={() => window.parent.postMessage({ type: 'CLOSE_PANEL' }, '*')}
          title="Close panel"
          className={`grid place-items-center border-none bg-transparent cursor-pointer p-0.5 ${account ? '' : 'ml-auto'}`}
          style={{ color: 'var(--faint)' }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ink)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--faint)')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </div>

      {!account ? (
        // Not connected yet — a single card inviting the person to connect.
        <div style={{ padding: '20px 14px' }}>
          <div className="gc-card" style={{ padding: 16 }}>
            <div style={{ fontWeight: 600, fontSize: '12.5px', marginBottom: 4 }}>Connect your Gmail</div>
            <div style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 12 }}>
              Sign in with Google to find and clean up storage-heavy email. Nothing is ever removed without your confirmation.
            </div>
            <button onClick={handleConnect} className="gc-btn gc-btn-primary w-full">
              <span>Connect Gmail</span>
            </button>
            {status && <div style={{ fontSize: 11, color: 'var(--sub)', marginTop: 10, textAlign: 'center' }}>{status}</div>}
          </div>
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div className="shrink-0" style={{ margin: '10px 14px 0' }}>
            <Segmented
              value={activeTab}
              onChange={setActiveTab}
              options={[
                { value: 'search', label: 'Search' },
                { value: 'senders', label: 'Top Senders' },
              ]}
            />
          </div>

          {/* Reconnect prompt — small and inline, not a full-screen blocker, so
              whatever the person was looking at (scan/search results) stays put. */}
          {needsReconnect && (
            <div
              className="shrink-0 flex items-center gap-2"
              style={{
                margin: '10px 14px 0', fontSize: 11, padding: '6px 10px',
                background: '#faf3df', border: '1px solid #e3c98a', borderRadius: 'var(--radius-sm)',
              }}
            >
              <span style={{ color: '#a4770f' }}>Your Gmail connection expired.</span>
              <button onClick={handleConnect} className="gc-btn-pill shrink-0 ml-auto" style={{ borderColor: '#e3c98a', background: '#faf3df', color: '#8a6516' }}>
                Reconnect Gmail
              </button>
            </div>
          )}

          {status && (
            <p className="shrink-0" style={{ margin: '8px 14px 0', fontSize: 11, color: 'var(--sub)' }}>{status}</p>
          )}

          <div className="mt-1 flex-1 flex flex-col min-h-0">
            {/* Each tab is kept mounted once visited so switching tabs doesn't
                lose its scan results — only the one matching activeTab is shown.
                Both get flex-1 + min-h-0 so their own scrollable body has real,
                bounded space to fill. Both also get onAuthError (shows the
                Reconnect banner above) and onAction (reports a Trash/Archive/
                Delete so the Undo toast below can pop up). */}
            <div className="flex-1 min-h-0" style={{ display: activeTab === 'search' ? 'block' : 'none' }}>
              <SearchTab onAuthError={() => setNeedsReconnect(true)} onAction={rememberUndo} />
            </div>
            <div className="flex-1 min-h-0" style={{ display: activeTab === 'senders' ? 'block' : 'none' }}>
              <SendersTab onAuthError={() => setNeedsReconnect(true)} onAction={rememberUndo} />
            </div>
          </div>
        </>
      )}

      {/* Undo toast — floats over the very bottom of the panel right after a
          Trash/Archive/Delete action. The thin bar along its bottom edge
          empties over UNDO_SECONDS, showing how long Undo remains available.
          `key={lastAction.at}` restarts that animation if a new action lands
          while a previous toast is still up. */}
      {lastAction && (
        <div
          key={lastAction.at}
          className="fixed z-40 overflow-hidden"
          style={{
            left: 12, right: 12, bottom: 12,
            background: 'var(--ink)', color: '#fff', borderRadius: 'var(--radius)',
            padding: '10px 12px', boxShadow: '0 12px 30px rgba(0,0,0,.3)', animation: 'gcRise .18s ease',
          }}
        >
          <div className="flex items-center gap-2.5">
            <span className="flex-1 min-w-0" style={{ fontSize: 12 }}>
              {lastAction.ids.length} email{lastAction.ids.length !== 1 ? 's' : ''}{' '}
              {lastAction.type === 'archive' ? 'archived' : 'moved to Trash'}.
            </span>
            <button
              onClick={handleUndo}
              disabled={undoing}
              className="shrink-0 cursor-pointer disabled:opacity-50"
              style={{
                border: '1px solid rgba(255,255,255,.35)', background: 'transparent', color: '#fff',
                borderRadius: 999, padding: '4px 12px', fontFamily: 'inherit', fontSize: '11.5px', fontWeight: 700,
              }}
            >
              {undoing ? 'Undoing...' : 'Undo'}
            </button>
            <button
              onClick={dismissUndo}
              title="Dismiss"
              className="shrink-0 grid place-items-center border-none bg-transparent cursor-pointer p-0.5"
              style={{ color: 'rgba(255,255,255,.55)' }}
            >
              <svg width="12" height="12" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          </div>
          <div
            className="absolute left-0 bottom-0"
            style={{ height: 2, background: 'rgba(255,255,255,.45)', animation: `gcShrink ${UNDO_SECONDS}s linear forwards` }}
          />
        </div>
      )}
    </div>
  )
}
