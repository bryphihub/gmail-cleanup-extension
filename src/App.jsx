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
import Onboarding from './Onboarding.jsx'
import SearchTab from './SearchTab.jsx'
import SendersTab from './SendersTab.jsx'
import useBackgroundQueue from './useBackgroundQueue.js'

// Give large background actions the longest allowed Undo window. The toast
// appears immediately, so these 15 seconds are fully usable by the person.
const UNDO_SECONDS = 15

export default function App() {
  const [account, setAccount] = useState(null)
  const [status, setStatus] = useState('')
  const [activeTab, setActiveTab] = useState('search')
  const { enqueueBackgroundAction, cancelBackgroundActions } = useBackgroundQueue()

  // content.js keeps the iframe alive when the panel is hidden. It sends this
  // signal first so panel-lifetime background jobs stop between Gmail batches
  // instead of silently continuing after the person closes the UI.
  useEffect(() => {
    const handlePanelHidden = (event) => {
      if (event.data?.type === 'PANEL_HIDDEN') cancelBackgroundActions()
    }
    window.addEventListener('message', handlePanelHidden)
    return () => window.removeEventListener('message', handlePanelHidden)
  }, [cancelBackgroundActions])

  // Boot state: false until we've checked storage for the onboarding flag
  // AND tried a silent token — prevents the onboarding welcome flashing for
  // a split second before an already-connected panel appears.
  const [booted, setBooted] = useState(false)
  // True once the person has completed the onboarding flow (or was already
  // connected before it existed). When true, a signed-out open goes straight
  // to the Connect screen instead of the full welcome tour.
  const [onboardingDone, setOnboardingDone] = useState(false)

  function markOnboardingDone() {
    setOnboardingDone(true)
    chrome.storage.local.set({ onboardingDone: true })
  }

  // True once any Gmail action in either tab hits an expired/revoked token
  // (a GmailAuthError — see auth.js/gmail.js). Shown as a small banner with a
  // Reconnect button instead of leaving the person staring at a raw "401"
  // error with no obvious next step.
  const [needsReconnect, setNeedsReconnect] = useState(false)

  // --- Undo ---
  // Lives here (not in each tab) so it can pop up as one consistent toast at
  // the very bottom of the whole panel, regardless of which tab the action
  // happened in. `lastAction` is null when there's nothing to undo, or
  // { type, ids, count, ... } right after a Trash/Archive/Delete action —
  // both tabs report actions here via onAction instead of showing separate
  // Undo controls. Auto-dismisses after UNDO_SECONDS, matching the countdown
  // bar animating across the toast.
  const [lastAction, setLastAction] = useState(null)
  const [undoing, setUndoing] = useState(false)
  const undoTimeoutRef = useRef(null)

  // `restoreLocal` puts removed rows back into the reporting tab. Background
  // jobs may additionally provide `prepareUndo`: App restores the rows first,
  // then that callback cancels untouched batches and returns only the IDs that
  // actually reached Gmail and therefore need an API-side reversal.
  function rememberUndo(type, ids = [], restoreLocal, options = {}) {
    const count = options.count ?? ids.length
    if (count === 0) return
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current)
    setLastAction({
      type,
      ids,
      count,
      restoreLocal,
      prepareUndo: options.prepareUndo,
      at: Date.now(),
    })
    undoTimeoutRef.current = setTimeout(() => setLastAction(null), UNDO_SECONDS * 1000)
  }

  function dismissUndo() {
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current)
    setLastAction(null)
  }

  async function handleUndo() {
    if (!lastAction) return
    const { type, ids, count, restoreLocal, prepareUndo } = lastAction
    setUndoing(true)
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current)
    setLastAction(null)
    try {
      let idsToRestore = ids

      if (prepareUndo) {
        // Re-populate the panel before waiting for an in-flight Gmail batch.
        // This is intentionally optimistic so Undo feels immediate even for
        // hundreds of emails.
        restoreLocal?.()
        idsToRestore = await prepareUndo()
      }

      if (idsToRestore.length > 0) {
        const token = await getToken(false)
        const apiFn = type === 'archive' ? restoreToInbox : untrashMessage
        for (let i = 0; i < idsToRestore.length; i += 10) {
          const batch = idsToRestore.slice(i, i + 10)
          await Promise.allSettled(batch.map((id) => apiFn(token, id)))
          if (i + 10 < idsToRestore.length) await new Promise((r) => setTimeout(r, 300))
        }
      }

      // Completed (non-background) actions still wait for Gmail before their
      // local rows return. Background actions already restored them above.
      if (!prepareUndo) restoreLocal?.()
      setStatus(`Undone — ${count} email${count !== 1 ? 's' : ''} restored.`)
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

  // On mount: read the onboarding flag, then try to connect silently (no
  // consent popup) using a token we already have permission for from a
  // previous session. A silent success also marks onboarding done — people
  // who connected before the onboarding flow existed shouldn't see it.
  useEffect(() => {
    chrome.storage.local.get('onboardingDone', (r) => {
      if (r.onboardingDone) setOnboardingDone(true)
      getToken(false)
        .then(async (token) => {
          await fetchAccount(token)
          markOnboardingDone()
        })
        .catch(() => {})
        .finally(() => setBooted(true))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Still deciding what to show (storage + silent-token check) — render just
  // the panel background for a beat rather than flashing the wrong screen.
  if (!booted) {
    return <div className="h-screen" style={{ background: 'var(--bg)' }} />
  }

  // Not connected: the onboarding flow owns the whole panel (each of its
  // screens renders its own header). People who completed onboarding before
  // but are signed out start directly on the Connect screen.
  if (!account) {
    return (
      <Onboarding
        skipWelcome={onboardingDone}
        onComplete={(email) => {
          setAccount(email)
          setNeedsReconnect(false)
          markOnboardingDone()
        }}
      />
    )
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
          style={{ width: 22, height: 22, borderRadius: 6, background: 'linear-gradient(135deg,#6bb3f4,#2f6bc4)', color: 'var(--accent-ink)' }}
        >
          {/* envelope mark — same logo as onboarding screen 1a and the extension icon */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 7l8 6 8-6" />
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
          onClick={() => {
            cancelBackgroundActions()
            window.parent.postMessage({ type: 'CLOSE_PANEL' }, '*')
          }}
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
            {/* The horizontal slide-in lives HERE, on a wrapper inside each
                display-toggled container — flipping display from none to
                block restarts CSS animations, so it replays exactly when a
                tab is switched to. Phase changes inside a tab animate
                vertically instead (see the tabs themselves), keeping
                "horizontal = tab change, vertical = phase change". */}
            <div className="flex-1 min-h-0" style={{ display: activeTab === 'search' ? 'block' : 'none' }}>
              <div className="h-full" style={{ animation: 'gcInL .22s ease' }}>
                <SearchTab
                  onAuthError={() => setNeedsReconnect(true)}
                  onAction={rememberUndo}
                  enqueueBackgroundAction={enqueueBackgroundAction}
                />
              </div>
            </div>
            <div className="flex-1 min-h-0" style={{ display: activeTab === 'senders' ? 'block' : 'none' }}>
              <div className="h-full" style={{ animation: 'gcInR .22s ease' }}>
                <SendersTab
                  onAuthError={() => setNeedsReconnect(true)}
                  onAction={rememberUndo}
                  enqueueBackgroundAction={enqueueBackgroundAction}
                />
              </div>
            </div>
          </div>
      </>

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
              {lastAction.count} email{lastAction.count !== 1 ? 's' : ''}{' '}
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
