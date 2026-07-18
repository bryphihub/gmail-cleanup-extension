// Onboarding.jsx — the first-run flow shown before Gmail is connected,
// implemented from the "Onboarding Flow" design (screens 1a–1e):
//
//   'welcome' (1a) — what the extension does + trust bullets → Get started
//   'connect' (1b) — what access is requested and why → Continue with Google
//   'waiting' (1c) — Google's sign-in window is open; Cancel / Try again
//   'setup'   (1d) — post-approval checklist while we verify + fetch the
//                    mailbox profile (quick — a couple of seconds)
//   'done'    (1e) — connected: real numbers from the Gmail profile, then
//                    "Start cleaning" hands off to the main panel
//
// Only real data is shown: the 1e tiles come straight from Gmail's profile
// (total emails / conversations). No scanning happens here — the first
// sender scan stays in the Top Senders tab.
//
// `skipWelcome` starts returning users (who completed onboarding before but
// are signed out) directly on the Connect screen. `onComplete(email)` is
// called from "Start cleaning" — App.jsx then shows the main panel.

import { useState, useRef } from 'react'
import { getToken } from './auth.js'
import { PrimaryButton } from './ui.jsx'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Small blue checkmark used by the welcome bullets and the setup checklist.
function Check({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 8.5 6 12l7.5-8" />
    </svg>
  )
}

// Shared screen chrome: header row (optional back arrow, title, ✕ close)
// over a vertically-centered body.
function Screen({ title, onBack, children, footer }) {
  return (
    <div className="h-screen flex flex-col" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
      <div className="flex items-center gap-2 shrink-0" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
        {onBack && (
          <button
            onClick={onBack}
            title="Back"
            className="flex items-center border-none bg-transparent cursor-pointer p-0.5"
            style={{ color: 'var(--sub)' }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 2.5 4.5 7 9 11.5" />
            </svg>
          </button>
        )}
        <div style={{ fontWeight: 600, fontSize: 13, letterSpacing: '-0.01em' }}>{title}</div>
        <button
          onClick={() => window.parent.postMessage({ type: 'CLOSE_PANEL' }, '*')}
          title="Close panel"
          className="ml-auto grid place-items-center border-none bg-transparent cursor-pointer p-0.5"
          style={{ color: 'var(--faint)' }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </div>
      <div className="flex-1 flex flex-col justify-center min-h-0" style={{ padding: '0 32px' }}>
        {children}
      </div>
      {footer && (
        <div className="shrink-0 text-center" style={{ padding: '14px 32px 18px', fontSize: 11, color: 'var(--faint)' }}>
          {footer}
        </div>
      )}
    </div>
  )
}

// One row of the 1b permissions card: icon chip + label + explanation.
function PermissionRow({ icon, title, body }) {
  return (
    <div className="flex items-start gap-3">
      <span className="grid place-items-center shrink-0" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--sel)', color: 'var(--accent)' }}>
        {icon}
      </span>
      <div>
        <div style={{ fontSize: '12.5px', fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: '11.5px', color: 'var(--sub)', lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  )
}

export default function Onboarding({ skipWelcome = false, onComplete }) {
  const [step, setStep] = useState(skipWelcome ? 'connect' : 'welcome')
  const [error, setError] = useState('')
  const [account, setAccount] = useState(null)
  const [stats, setStats] = useState(null)      // { messages, threads } from the Gmail profile
  const [setupStage, setSetupStage] = useState(0) // completed items in the 1d checklist

  // Increments on every connect attempt AND on Cancel — a finished Google
  // flow only applies if its run id is still current, so a cancelled
  // attempt that later resolves is simply ignored.
  const runRef = useRef(0)

  async function startConnect() {
    const run = ++runRef.current
    setError('')
    setStep('waiting')
    try {
      const token = await getToken(true) // opens Google's own sign-in window
      if (runRef.current !== run) return // cancelled while waiting
      setStep('setup')
      setSetupStage(1) // account connected
      await sleep(500)

      const profile = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json())
      if (runRef.current !== run) return
      setAccount(profile.emailAddress)
      setSetupStage(2) // permissions verified (the API call worked)
      await sleep(600)

      setStats({ messages: profile.messagesTotal ?? null, threads: profile.threadsTotal ?? null })
      setSetupStage(3) // mailbox summary fetched
      await sleep(700)

      setStep('done')
    } catch (err) {
      if (runRef.current !== run) return
      // Most common cause: the person closed Google's window without
      // approving. Nothing has changed — invite them to try again.
      setError("Google sign-in didn't finish — nothing was changed. Try again whenever you're ready.")
      setStep('connect')
    }
  }

  function cancelConnect() {
    runRef.current++ // orphan the in-flight attempt
    setStep('connect')
  }

  /* ---------- 1a · Welcome ---------- */
  if (step === 'welcome') {
    return (
      <Screen title="Gmail Cleanup" footer="Works with Gmail · Takes about a minute">
        <div
          className="grid place-items-center"
          style={{
            width: 56, height: 56, borderRadius: 14, marginBottom: 20,
            background: 'linear-gradient(135deg,#6bb3f4,#2f6bc4)', boxShadow: '0 4px 12px rgba(43,95,174,.25)',
          }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7l8 6 8-6" /><rect x="4" y="5" width="16" height="14" rx="2" />
          </svg>
        </div>
        <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.25, marginBottom: 10, textWrap: 'pretty' }}>
          Declutter your inbox in minutes.
        </div>
        <div style={{ fontSize: 13, color: 'var(--sub)', lineHeight: 1.55, marginBottom: 24, textWrap: 'pretty' }}>
          Find old, unread, and oversized emails. Unsubscribe from senders you never read. Delete to free up storage.
        </div>
        <div className="grid gap-3" style={{ marginBottom: 28 }}>
          {[
            'Nothing is deleted without your say-so',
            'Undo window on every bulk action',
            'Your mail never leaves your browser',
          ].map((line) => (
            <div key={line} className="flex items-start gap-2.5">
              <span className="shrink-0" style={{ width: 16, height: 16, color: 'var(--accent)', marginTop: 1 }}><Check /></span>
              <div style={{ fontSize: '12.5px' }}>{line}</div>
            </div>
          ))}
        </div>
        <PrimaryButton onClick={() => setStep('connect')}>Get started</PrimaryButton>
      </Screen>
    )
  }

  /* ---------- 1b · Connect your Gmail ---------- */
  if (step === 'connect') {
    return (
      <Screen title="Connect your Gmail" onBack={skipWelcome ? undefined : () => setStep('welcome')}>
        <div style={{ fontSize: 13, color: 'var(--sub)', lineHeight: 1.55, marginBottom: 20, textWrap: 'pretty' }}>
          Gmail Cleanup asks Google for the minimum access it needs. You'll approve this on Google's own sign-in page.
        </div>
        <div className="gc-card grid gap-3.5" style={{ padding: 16, marginBottom: 24 }}>
          <PermissionRow
            icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></svg>}
            title="Read message metadata"
            body="Scans sender, subject, size, age, and keywords to find what's worth cleaning."
          />
          <PermissionRow
            icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V5h6v2m-9 0 1 13h8l1-13" /></svg>}
            title="Move mail to Trash or Archive"
            body="Only the messages you select, always with an undo window."
          />
          <PermissionRow
            icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 7l8 6 8-6" /></svg>}
            title="Send unsubscribe requests"
            body="Uses each newsletter's own unsubscribe link on your behalf."
          />
        </div>
        <PrimaryButton onClick={startConnect}>
          <span className="flex items-center justify-center gap-2.5">
            <span
              className="grid place-items-center"
              style={{ width: 18, height: 18, background: '#fff', borderRadius: '50%', fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}
            >
              G
            </span>
            Continue with Google
          </span>
        </PrimaryButton>
        {error && (
          <div style={{ fontSize: 11.5, color: 'var(--danger)', textAlign: 'center', marginTop: 12, lineHeight: 1.5 }}>{error}</div>
        )}
        <div style={{ fontSize: 11, color: 'var(--faint)', textAlign: 'center', marginTop: 12, lineHeight: 1.5 }}>
          You can disconnect anytime in Settings.<br />We never see your login info.
        </div>
      </Screen>
    )
  }

  /* ---------- 1c · Waiting on Google sign-in ---------- */
  if (step === 'waiting') {
    return (
      <Screen title="Connect your Gmail">
        <div className="flex flex-col items-center text-center">
          <div
            style={{
              width: 44, height: 44, borderRadius: '50%', marginBottom: 20,
              border: '3px solid var(--line)', borderTopColor: 'var(--accent)', animation: 'obSpin .9s linear infinite',
            }}
          />
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Finish signing in with Google</div>
          <div style={{ fontSize: '12.5px', color: 'var(--sub)', lineHeight: 1.55, maxWidth: 260, textWrap: 'pretty' }}>
            A Google window is open. Choose your account and approve access, we'll pick up from there automatically.
          </div>
          <button onClick={cancelConnect} className="gc-btn gc-btn-neutral" style={{ marginTop: 24, padding: '8px 16px', fontSize: 12, background: 'var(--card)', color: 'var(--sub)' }}>
            Cancel
          </button>
          <div style={{ marginTop: 16, fontSize: 11, color: 'var(--faint)' }}>
            Window didn't open?{' '}
            <button onClick={startConnect} className="gc-link" style={{ fontSize: 11, fontWeight: 600 }}>Try again</button>
          </div>
        </div>
      </Screen>
    )
  }

  /* ---------- 1d · Setting things up (post-approval) ---------- */
  if (step === 'setup') {
    const items = ['Account connected', 'Permissions verified', 'Fetching mailbox summary…']
    const pct = [10, 40, 70, 100][setupStage]
    return (
      <Screen title="Gmail Cleanup">
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Setting things up…</div>
        <div style={{ fontSize: 12, color: 'var(--sub)', marginBottom: 24 }}>{account || ' '}</div>
        <div className="grid gap-3.5">
          {items.map((label, i) => {
            const done = setupStage > i
            const active = setupStage === i
            return (
              <div key={label} className="flex items-center gap-2.5" style={{ opacity: done || active ? 1 : .45 }}>
                {done ? (
                  <span className="shrink-0" style={{ width: 16, height: 16, color: 'var(--accent)' }}><Check /></span>
                ) : (
                  <span
                    className="shrink-0 box-border"
                    style={{
                      width: 16, height: 16, borderRadius: '50%', border: '2px solid var(--line)',
                      ...(active ? { borderTopColor: 'var(--accent)', animation: 'obSpin .9s linear infinite' } : {}),
                    }}
                  />
                )}
                <div style={{ fontSize: '12.5px', animation: active ? 'obPulse 1.4s ease infinite' : undefined }}>{label}</div>
              </div>
            )
          })}
        </div>
        <div className="overflow-hidden" style={{ marginTop: 28, height: 6, borderRadius: 999, background: 'var(--chip)' }}>
          <div className="h-full" style={{ width: `${pct}%`, borderRadius: 999, background: 'linear-gradient(90deg,#6bb3f4,#2f6bc4)', transition: 'width .5s ease' }} />
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--faint)', textAlign: 'center' }}>
          Reading metadata only. No message bodies leave Gmail.
        </div>
      </Screen>
    )
  }

  /* ---------- 1e · Connected ---------- */
  const tiles = [
    stats?.messages != null && { value: stats.messages.toLocaleString(), label: 'emails' },
    stats?.threads != null && { value: stats.threads.toLocaleString(), label: 'conversations' },
  ].filter(Boolean)
  return (
    <Screen title="Gmail Cleanup">
      <div
        className="grid place-items-center"
        style={{
          width: 56, height: 56, borderRadius: '50%', marginBottom: 18,
          background: 'var(--sel)', color: 'var(--accent)', animation: 'obPop .45s var(--spring)',
        }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 12.5 9.5 18 20 6.5" />
        </svg>
      </div>
      <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.02em', marginBottom: 8 }}>You're connected.</div>
      <div style={{ fontSize: '12.5px', color: 'var(--sub)', lineHeight: 1.55, marginBottom: 22, textWrap: 'pretty' }}>
        Here's a first look at your inbox. Start with a search, or review senders you're subscribed to.
      </div>
      {tiles.length > 0 && (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${tiles.length}, 1fr)`, marginBottom: 24 }}>
          {tiles.map((t) => (
            <div key={t.label} className="gc-card text-center" style={{ padding: '12px 10px' }}>
              <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{t.value}</div>
              <div style={{ fontSize: '10.5px', color: 'var(--sub)' }}>{t.label}</div>
            </div>
          ))}
        </div>
      )}
      <PrimaryButton onClick={() => onComplete?.(account)}>Start cleaning</PrimaryButton>
    </Screen>
  )
}
