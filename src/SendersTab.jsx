// SendersTab.jsx — the merged "Senders" tab. Replaces the old separate
// Subscriptions and Top Senders tabs, which were showing a lot of the same
// people (most subscriptions are also top senders). One scan now covers both
// jobs: it reads every message in the chosen scope (Inbox or All mail) and
// tags each one as a "subscription" if it carries a List-Unsubscribe header —
// the same signal the old Subscriptions tab used, just recorded per message
// instead of used to decide what to fetch in the first place.
//
// Filters (age, unread, size) and the "Show" toggle (Subscriptions /
// Non-subscriptions) are pure client-side — they re-slice the same scanned
// data instantly, no new API calls. Only changing "Where to look" (scope)
// requires clicking Scan/Rescan again, since that changes which messages were
// ever fetched in the first place.
//
// The full scan (every message record, not just the sender totals) is saved
// to chrome.storage.local after every scan and restored on mount, so opening
// the panel in a new session shows real, actionable results right away
// instead of just a "last scanned" timestamp with nothing behind it. This
// needs the "unlimitedStorage" permission in manifest.json — a large "All
// mail" scan of a big inbox can be several megabytes of JSON, past what
// storage.local normally allows.

import { useState, useRef, useMemo, useEffect } from 'react'
import { getToken, GmailAuthError } from './auth.js'
import { scanSenders, trashAllFromSender, attemptUnsubscribe, parseUnsubscribeUrl } from './gmail.js'
import { formatSize, formatTimeAgo, dragScrollSpeed } from './utils.js'

const DAY_MS = 24 * 60 * 60 * 1000
const FIVE_MB = 5 * 1024 * 1024

// Each filter is applied client-side against the already-scanned messages —
// none of these trigger a rescan.
const FILTERS = [
  { id: 'olderThan1y', label: 'Older than 1 year' },
  { id: 'olderThan6m', label: 'Older than 6 months' },
  { id: 'unread', label: 'Unread only' },
  { id: 'largerThan5mb', label: 'Larger than 5 MB' },
]

// `onAuthError` is called whenever a Gmail action fails because the token has
// expired or been revoked — App.jsx uses it to show a "Reconnect Gmail"
// banner above both tabs. `onAction` reports a completed Delete/Unsub &
// delete so App.jsx can pop up a shared "Undo" toast at the bottom of the
// panel — the Undo control itself lives there, not in this tab.
export default function SendersTab({ onAuthError, onAction }) {
  // Every message from the last scan, unfiltered. This is the single source
  // of truth — filters, the Show toggle, and sorting all derive from this
  // without needing to touch the network again.
  const [rawMessages, setRawMessages] = useState([])

  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [progress, setProgress] = useState({ loaded: 0, total: 0 })

  // Unix timestamp (ms) of the most recent completed scan, and which scope
  // ('inbox' or 'all') it covered — shown next to "Last scanned" regardless
  // of whether this session has scanned yet, since rawMessages (above) is
  // restored from storage on mount too.
  const [lastScanTime, setLastScanTime] = useState(null)
  const [lastScanScope, setLastScanScope] = useState(null)

  // Scope — 'inbox' or 'all'. The only control that requires a rescan to apply.
  const [scope, setScope] = useState('inbox')

  // Client-side filters and the subscription visibility toggle.
  const [activeFilters, setActiveFilters] = useState(new Set())
  const [showMode, setShowMode] = useState('sub') // 'sub' | 'nonsub'
  const [sortBy, setSortBy] = useState('size')

  function toggleFilter(id) {
    setActiveFilters((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Senders the user has already unsubscribed from or deleted — persisted so
  // they don't reappear on future scans either.
  const [dismissedSubs, setDismissedSubs] = useState(new Set())

  const [acting, setActing] = useState(null) // email currently being worked on
  const [bulkConfirm, setBulkConfirm] = useState(false)
  const [bulkProgress, setBulkProgress] = useState({ loaded: 0, total: 0 })
  const [needsManualUnsub, setNeedsManualUnsub] = useState([])

  // Manual multi-select — lets someone check off several senders (in either
  // Subscriptions or Non-subscriptions view) and delete them all at once,
  // separate from the "Unsub & Delete All Subscriptions" button above, which
  // only ever touches subscriptions.
  const [selectedSenders, setSelectedSenders] = useState(new Set())
  // Which bulk action (if any) is pending confirmation for the current
  // selection. On Subscriptions this can be 'unsub', 'delete', or
  // 'unsubDelete' — on Non-subscriptions only 'delete' is ever offered,
  // since those senders have nothing to unsubscribe from.
  const [selectedActionConfirm, setSelectedActionConfirm] = useState(null)

  // Every destructive action on a row (Unsub, Delete all, Unsub & delete)
  // asks for confirmation first instead of firing immediately on click — one
  // stray click on a small button in a dense list shouldn't be able to
  // unsubscribe from or delete mail from the wrong sender.
  const [confirmAction, setConfirmAction] = useState(null) // { sender, type: 'unsub' | 'delete' | 'unsubDelete' }

  // Shared by every catch block below: tells the difference between "your
  // Gmail login is no longer valid" (show Reconnect above, via onAuthError)
  // and every other kind of failure (just show the message as status text).
  function handleGmailError(err, prefix = 'Error: ') {
    if (err instanceof GmailAuthError) {
      onAuthError?.()
      setStatus('Your Gmail connection expired — click "Reconnect Gmail" above to continue.')
    } else {
      setStatus(prefix + err.message)
    }
  }

  // Builds the function passed to App.jsx as `onAction`'s third argument —
  // it only runs once App.jsx has confirmed the Gmail-side untrash actually
  // succeeded, and puts the given raw message records back into rawMessages
  // so the sender reappears in the list instead of Undo only working
  // silently on Gmail's side. `emailsToUndismiss` additionally un-dismisses
  // senders that were unsubscribed as part of the same action — the
  // unsubscribe request itself can't be called back, but there's no reason
  // to keep hiding a sender whose emails just came back to the list.
  function makeRestoreFn(records, emailsToUndismiss = []) {
    return () => {
      setRawMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id))
        const toAdd = records.filter((m) => !existingIds.has(m.id))
        const next = [...toAdd, ...prev]
        chrome.storage.local.set({ sendersLastScanData: next })
        return next
      })
      if (emailsToUndismiss.length > 0) {
        setDismissedSubs((prev) => {
          if (!emailsToUndismiss.some((e) => prev.has(e))) return prev
          const next = new Set(prev)
          for (const e of emailsToUndismiss) next.delete(e)
          chrome.storage.local.set({ dismissedSubs: [...next] })
          return next
        })
      }
    }
  }

  // Selection and any pending confirmation are scoped to whichever tab is
  // active — clear both when switching tabs so a checkbox or confirmation
  // left over from one view doesn't silently apply in the other.
  useEffect(() => {
    setSelectedSenders(new Set())
    setConfirmAction(null)
    setSelectedActionConfirm(null)
  }, [showMode])
  // Guards against the persist-effect below overwriting saved manual-unsub
  // data with an empty array before that data has finished loading from
  // storage on mount (see the mount effect and the persist effect further
  // down).
  const manualUnsubLoadedRef = useRef(false)

  const hasScannedRef = useRef(false)
  // Points at the single scrollable container for the whole tab — header,
  // filters, and the results list all scroll together as one unit, so
  // scrolling down moves the filters out of view and gives the list more
  // room, instead of the header staying pinned and only the list scrolling.
  const scrollRef = useRef(null)
  const [showBackToTop, setShowBackToTop] = useState(false)

  function handleScroll() {
    setShowBackToTop((scrollRef.current?.scrollTop || 0) > 200)
  }
  function scrollToTop() {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // --- Manual-unsubscribe panel: drag-to-resize ---
  // rootRef measures the Senders tab's own height, so "1/3 of the panel"
  // stays correct even if the extension window is resized. manualPanelHeight
  // is null by default, meaning "size itself to fit its content, up to the
  // 1/3 cap" (the original behavior) — once someone drags the handle, it
  // switches to a fixed pixel height so the panel stays wherever they left it.
  const rootRef = useRef(null)
  const manualPanelRef = useRef(null)
  const [manualPanelHeight, setManualPanelHeight] = useState(null)

  function startManualPanelDrag(e) {
    e.preventDefault()
    const startY = e.clientY
    const rootHeight = rootRef.current?.clientHeight || 0
    const maxHeight = rootHeight / 3
    // A comfortable floor — enough to still see the heading and grab the
    // handle again, without letting the panel disappear entirely (it's meant
    // to stay reachable; hiding it completely is already handled separately
    // by not rendering this panel at all when the queue is empty).
    const minHeight = 48
    const startHeight = manualPanelRef.current?.getBoundingClientRect().height || maxHeight

    function onMove(ev) {
      // Handle sits at the top of the panel, so moving the mouse up (smaller
      // clientY) should grow the panel, and moving it down should shrink it.
      const delta = startY - ev.clientY
      const next = Math.max(minHeight, Math.min(maxHeight, startHeight + delta))
      setManualPanelHeight(next)
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Load any previously-dismissed senders on mount so they stay hidden.
  useEffect(() => {
    chrome.storage.local.get('dismissedSubs', (r) => {
      if (r.dismissedSubs) setDismissedSubs(new Set(r.dismissedSubs))
    })
  }, [])

  // On mount: restore the last scan — both when it happened and the actual
  // data — from storage, so there's something real to look at (and act on)
  // immediately, not just a timestamp. Only if NO scan has ever been saved
  // (first time this account has ever connected) do we auto-run a fresh one.
  useEffect(() => {
    chrome.storage.local.get(
      ['sendersLastScanTime', 'sendersLastScanScope', 'sendersLastScanData', 'sendersNeedsManualUnsub'],
      (r) => {
        if (r.sendersLastScanTime) {
          setLastScanTime(r.sendersLastScanTime)
          setLastScanScope(r.sendersLastScanScope || 'all') // old data before this field existed was always an all-mail scan
          if (r.sendersLastScanData) {
            setRawMessages(r.sendersLastScanData)
            hasScannedRef.current = true
            setStatus(
              `Scanned ${r.sendersLastScanData.length.toLocaleString()} email${r.sendersLastScanData.length !== 1 ? 's' : ''}.`
            )
          }
          if (r.sendersNeedsManualUnsub) setNeedsManualUnsub(r.sendersNeedsManualUnsub)
          manualUnsubLoadedRef.current = true
        } else {
          runScan('all')
          manualUnsubLoadedRef.current = true
        }
      }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the manual-unsubscribe queue in storage so it survives closing the
  // panel or reloading the extension, the same way scan data does — without
  // this, finishing a manual unsubscribe meant losing the rest of the list
  // the moment the panel closed. Skipped until the mount effect above has
  // finished loading (or confirmed there's nothing to load), so this doesn't
  // fire with an empty array and wipe out saved data before it's restored.
  useEffect(() => {
    if (!manualUnsubLoadedRef.current) return
    chrome.storage.local.set({ sendersNeedsManualUnsub: needsManualUnsub }, () => {
      if (chrome.runtime.lastError) {
        console.warn('Could not save manual-unsubscribe queue:', chrome.runtime.lastError.message)
      }
    })
  }, [needsManualUnsub])

  // --- Scan ---

  // Saves the full scan to storage.local so it survives closing the panel or
  // reloading the extension. Fails silently (logs, doesn't throw) if it ever
  // runs into a storage error — worst case, the in-memory results the user is
  // currently looking at are unaffected, they just won't be there next time.
  function persistScan(messages, time, scanScope) {
    chrome.storage.local.set(
      { sendersLastScanData: messages, sendersLastScanTime: time, sendersLastScanScope: scanScope },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('Could not save scan results:', chrome.runtime.lastError.message)
        }
      }
    )
  }

  // `targetScope` lets a caller (like the first-time auto-scan above) force a
  // specific scope regardless of whatever the "Where to look" pills currently
  // show — the pills get updated to match so the UI doesn't end up lying
  // about what was actually scanned.
  async function runScan(targetScope) {
    const useScope = targetScope || scope
    if (targetScope && targetScope !== scope) setScope(targetScope)

    setLoading(true)
    setStatus('')
    setRawMessages([])
    setProgress({ loaded: 0, total: 0 })
    try {
      const token = await getToken(false)
      const results = await scanSenders(
        token,
        { scope: useScope },
        (loaded, total) => setProgress({ loaded, total }),
        (partial) => setRawMessages(partial)
      )
      setRawMessages(results)
      hasScannedRef.current = true
      const now = Date.now()
      setLastScanTime(now)
      setLastScanScope(useScope)
      persistScan(results, now, useScope)
      setStatus(`Scanned ${results.length.toLocaleString()} email${results.length !== 1 ? 's' : ''}.`)
    } catch (err) {
      handleGmailError(err)
    } finally {
      setLoading(false)
      setProgress({ loaded: 0, total: 0 })
    }
  }

  // --- Aggregation — recomputed whenever the scan data or any filter changes,
  // but never touches the network. This is what makes filters feel instant. ---

  // Every sender that survives the age/unread/size filters, regardless of the
  // Show toggle — this is the shared base that both the sub and non-sub totals
  // (below) and the currently-displayed list are derived from, so the two
  // totals always reflect the same filters as whatever's on screen.
  const aggregatedSenders = useMemo(() => {
    const now = Date.now()
    const cutoff1y = now - 365 * DAY_MS
    const cutoff6m = now - 182 * DAY_MS

    const map = new Map()
    for (const msg of rawMessages) {
      if (dismissedSubs.has(msg.email)) continue
      if (activeFilters.has('olderThan1y') && !(msg.dateMs && msg.dateMs < cutoff1y)) continue
      if (activeFilters.has('olderThan6m') && !(msg.dateMs && msg.dateMs < cutoff6m)) continue
      if (activeFilters.has('unread') && !msg.isUnread) continue
      if (activeFilters.has('largerThan5mb') && !(msg.sizeEstimate >= FIVE_MB)) continue

      const entry = map.get(msg.email) || {
        email: msg.email, name: msg.name, count: 0, totalBytes: 0,
        isSubscription: false, unsubHeader: null,
      }
      entry.count++
      entry.totalBytes += msg.sizeEstimate
      if (msg.isSubscription) {
        entry.isSubscription = true
        entry.unsubHeader = entry.unsubHeader || msg.unsubHeader
      }
      map.set(msg.email, entry)
    }

    return [...map.values()].sort((a, b) => (sortBy === 'count' ? b.count - a.count : b.totalBytes - a.totalBytes))
  }, [rawMessages, activeFilters, sortBy, dismissedSubs])

  // Split once so both the "Subscriptions vs non-subscriptions" comparison
  // and the Show toggle can reuse the same two slices.
  const subSenders = useMemo(() => aggregatedSenders.filter((s) => s.isSubscription), [aggregatedSenders])
  const nonSubSenders = useMemo(() => aggregatedSenders.filter((s) => !s.isSubscription), [aggregatedSenders])
  const subTotalBytes = subSenders.reduce((sum, s) => sum + s.totalBytes, 0)
  const nonSubTotalBytes = nonSubSenders.reduce((sum, s) => sum + s.totalBytes, 0)

  const filteredSenders = showMode === 'sub' ? subSenders : nonSubSenders

  const maxValue = filteredSenders.length > 0
    ? Math.max(...filteredSenders.map((s) => (sortBy === 'count' ? s.count : s.totalBytes)))
    : 1

  // The bulk action only ever acts on subscriptions within whatever's
  // currently displayed — it disappears on "Non-subscriptions" since there'd
  // be nothing in view for it to act on there.
  const visibleSubs = filteredSenders.filter((s) => s.isSubscription)
  const visibleSubBytes = visibleSubs.reduce((sum, s) => sum + s.totalBytes, 0)

  // Whether every sender currently on screen is checked — drives the
  // "Select all" checkbox's own checked state.
  const allVisibleSelected = filteredSenders.length > 0 && filteredSenders.every((s) => selectedSenders.has(s.email))

  // --- Actions ---

  // Removes a sender from view and remembers it so future scans skip them too.
  function dismissSender(email) {
    setDismissedSubs((prev) => {
      const next = new Set(prev)
      next.add(email)
      chrome.storage.local.set({ dismissedSubs: [...next] })
      return next
    })
  }

  // Updates rawMessages both in memory and in the cached scan, so a sender
  // that's just been deleted doesn't reappear if the panel is reopened later
  // before the next rescan.
  function pruneMessages(emailsToRemove) {
    setRawMessages((prev) => {
      const next = prev.filter((m) => !emailsToRemove.has(m.email))
      chrome.storage.local.set({ sendersLastScanData: next })
      return next
    })
    // Also drop any of these senders from the current selection, so a
    // deleted sender doesn't linger in the "Delete selected (N)" count.
    setSelectedSenders((prev) => {
      if (![...emailsToRemove].some((e) => prev.has(e))) return prev
      const next = new Set(prev)
      for (const email of emailsToRemove) next.delete(email)
      return next
    })
  }

  function toggleSelectAll() {
    setSelectedSenders(allVisibleSelected ? new Set() : new Set(filteredSenders.map((s) => s.email)))
  }

  // --- Drag-select over the checkbox column ---
  // The row itself already has its own click behavior (opens a Gmail search
  // for that sender), so drag-select is scoped to the checkboxes specifically
  // rather than the whole row — dragging down the checkbox column selects
  // (or deselects) everything it passes over, without also firing off a
  // string of Gmail searches. senderDragRef is a ref, not state, since only
  // the actual selection changes below should cause a re-render.
  const senderDragRef = useRef(null)
  // Tracks the mouse's latest position during a drag, and the animation
  // frame driving auto-scroll near the top/bottom edge of the scrollable
  // region (scrollRef) — see startSenderDrag below.
  const senderDragPosRef = useRef({ x: 0, y: 0 })
  const senderDragScrollRafRef = useRef(null)

  function applySenderSelection(email, shouldBeSelected) {
    setSelectedSenders((prev) => {
      if (prev.has(email) === shouldBeSelected) return prev
      const next = new Set(prev)
      shouldBeSelected ? next.add(email) : next.delete(email)
      return next
    })
  }

  // Runs every frame while a drag is active. Auto-scrolls the tab's main
  // scroll region when the cursor is near its top or bottom edge, so a drag
  // that starts on screen can still reach senders further up or down the
  // list without the user having to let go, scroll manually, and start a new
  // drag. After scrolling, re-checks whatever sender is now under the cursor
  // (scrolling the list doesn't itself fire mouseenter — the pointer hasn't
  // actually moved — so this is what keeps the selection extending smoothly
  // as new rows scroll into view underneath a stationary mouse).
  function senderDragScrollTick() {
    const container = scrollRef.current
    if (container) {
      const speed = dragScrollSpeed(container.getBoundingClientRect(), senderDragPosRef.current.y)
      if (speed !== 0) {
        container.scrollTop += speed
        const { x, y } = senderDragPosRef.current
        const rowEl = document.elementFromPoint(x, y)?.closest('[data-sender-email]')
        if (rowEl) senderDragOver(rowEl.getAttribute('data-sender-email'))
      }
    }
    senderDragScrollRafRef.current = requestAnimationFrame(senderDragScrollTick)
  }

  function startSenderDrag(email, event) {
    const target = !selectedSenders.has(email)
    senderDragRef.current = target
    senderDragPosRef.current = { x: event.clientX, y: event.clientY }
    applySenderSelection(email, target)

    function onMove(e) {
      senderDragPosRef.current = { x: e.clientX, y: e.clientY }
    }
    function onUp() {
      senderDragRef.current = null
      if (senderDragScrollRafRef.current !== null) {
        cancelAnimationFrame(senderDragScrollRafRef.current)
        senderDragScrollRafRef.current = null
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    if (senderDragScrollRafRef.current === null) {
      senderDragScrollRafRef.current = requestAnimationFrame(senderDragScrollTick)
    }
  }

  function senderDragOver(email) {
    if (senderDragRef.current === null) return
    applySenderSelection(email, senderDragRef.current)
  }

  // Text shown in the inline confirmation box for a row's action buttons —
  // one central place so the wording for Unsub / Delete all / Unsub & delete
  // stays consistent.
  function confirmActionText(type, sender) {
    const who = sender.name || sender.email
    if (type === 'unsub') return `Unsubscribe from ${who}?`
    if (type === 'delete') return `Delete all emails from ${who}? They'll be moved to Trash.`
    return `Unsubscribe from ${who} and delete all their emails? They'll be moved to Trash.`
  }

  function runConfirmedAction() {
    if (!confirmAction) return
    const { sender, type } = confirmAction
    setConfirmAction(null)
    if (type === 'unsub') handleUnsubscribe(sender)
    else if (type === 'delete') handleDeleteSender(sender)
    else handleUnsubAndDelete(sender)
  }

  async function handleUnsubscribe(sender) {
    dismissSender(sender.email)
    try {
      const token = await getToken(false)
      const result = await attemptUnsubscribe(token, sender.unsubHeader)
      if (result === 'manual') setNeedsManualUnsub((prev) => [...prev, sender])
    } catch (err) {
      // Otherwise fail silently — sender is already dismissed, and there's
      // nothing here to undo, so a raw error isn't actionable either way.
      if (err instanceof GmailAuthError) onAuthError?.()
    }
  }

  // Trashes every email from this sender (globally, not just what's currently
  // visible under the filters) — same as before, since the point is actually
  // freeing up storage, not just the filtered subset.
  async function handleDeleteSender(sender) {
    setActing(sender.email)
    try {
      const token = await getToken(false)
      const { ids } = await trashAllFromSender(token, sender.email)
      const idSet = new Set(ids)
      const removedRecords = rawMessages.filter((m) => idSet.has(m.id))
      pruneMessages(new Set([sender.email]))
      onAction?.('trash', ids, makeRestoreFn(removedRecords))
    } catch (err) {
      handleGmailError(err, 'Error deleting emails: ')
    } finally {
      setActing(null)
    }
  }

  async function handleUnsubAndDelete(sender) {
    dismissSender(sender.email)
    setActing(sender.email)
    try {
      const token = await getToken(false)
      const [unsubResult, trashResult] = await Promise.allSettled([
        attemptUnsubscribe(token, sender.unsubHeader),
        trashAllFromSender(token, sender.email),
      ])
      if (unsubResult.value === 'manual') setNeedsManualUnsub((prev) => [...prev, sender])
      if (trashResult.status === 'fulfilled') {
        const idSet = new Set(trashResult.value.ids)
        const removedRecords = rawMessages.filter((m) => idSet.has(m.id))
        pruneMessages(new Set([sender.email]))
        onAction?.('trash', trashResult.value.ids, makeRestoreFn(removedRecords, [sender.email]))
      } else {
        pruneMessages(new Set([sender.email]))
      }
    } catch (err) {
      handleGmailError(err)
    } finally {
      setActing(null)
    }
  }

  // --- Shared bulk operations ---
  // These three do the actual work for any "act on a group of senders"
  // button on this tab — both the "Unsub & Delete All Subscriptions" button
  // (which always passes every visible subscription) and the per-selection
  // Unsub / Delete / Unsub & delete buttons (which pass just the checked
  // senders) call into the same code, so the two paths can't drift apart.

  async function bulkUnsubscribe(senders) {
    const emailSet = new Set(senders.map((s) => s.email))
    setDismissedSubs((prev) => {
      const next = new Set([...prev, ...emailSet])
      chrome.storage.local.set({ dismissedSubs: [...next] })
      return next
    })
    // Unsubscribing doesn't delete any messages, so rawMessages is untouched —
    // but the senders are now dismissed and won't show up again, so drop them
    // from the selection the same way pruneMessages does for deletions.
    setSelectedSenders((prev) => {
      if (![...emailSet].some((e) => prev.has(e))) return prev
      const next = new Set(prev)
      for (const email of emailSet) next.delete(email)
      return next
    })

    setLoading(true)
    setStatus('')
    setBulkProgress({ loaded: 0, total: senders.length })
    const manualQueue = []
    try {
      const token = await getToken(false)
      for (let i = 0; i < senders.length; i++) {
        setBulkProgress({ loaded: i, total: senders.length })
        const result = await attemptUnsubscribe(token, senders[i].unsubHeader)
        if (result === 'manual') manualQueue.push(senders[i])
      }
      setBulkProgress({ loaded: senders.length, total: senders.length })
      const automated = senders.length - manualQueue.length
      setStatus(
        manualQueue.length > 0
          ? `Done — ${automated} unsubscribed automatically, ${manualQueue.length} need manual action below.`
          : `Unsubscribed from ${senders.length} sender${senders.length !== 1 ? 's' : ''}.`
      )
      if (manualQueue.length > 0) setNeedsManualUnsub((prev) => [...prev, ...manualQueue])
    } catch (err) {
      handleGmailError(err, 'Error during bulk unsubscribe: ')
    } finally {
      setLoading(false)
      setBulkProgress({ loaded: 0, total: 0 })
    }
  }

  async function bulkDelete(senders) {
    const emailSet = new Set(senders.map((s) => s.email))
    setLoading(true)
    setStatus('')
    setBulkProgress({ loaded: 0, total: senders.length })
    const allTrashedIds = []
    try {
      const token = await getToken(false)
      for (let i = 0; i < senders.length; i++) {
        setBulkProgress({ loaded: i, total: senders.length })
        const { ids } = await trashAllFromSender(token, senders[i].email)
        allTrashedIds.push(...ids)
      }
      setBulkProgress({ loaded: senders.length, total: senders.length })
      const idSet = new Set(allTrashedIds)
      const removedRecords = rawMessages.filter((m) => idSet.has(m.id))
      pruneMessages(emailSet)
      setStatus(`Deleted emails from ${senders.length} sender${senders.length !== 1 ? 's' : ''}.`)
      onAction?.('trash', allTrashedIds, makeRestoreFn(removedRecords))
    } catch (err) {
      onAction?.('trash', allTrashedIds) // whatever succeeded before the error is still undoable
      handleGmailError(err, 'Error during bulk delete: ')
    } finally {
      setLoading(false)
      setBulkProgress({ loaded: 0, total: 0 })
    }
  }

  async function bulkUnsubAndDelete(senders) {
    const emailSet = new Set(senders.map((s) => s.email))
    setDismissedSubs((prev) => {
      const next = new Set([...prev, ...emailSet])
      chrome.storage.local.set({ dismissedSubs: [...next] })
      return next
    })

    setLoading(true)
    setStatus('')
    setBulkProgress({ loaded: 0, total: senders.length })
    const manualQueue = []
    const allTrashedIds = []
    try {
      const token = await getToken(false)
      for (let i = 0; i < senders.length; i++) {
        const sender = senders[i]
        setBulkProgress({ loaded: i, total: senders.length })
        const [unsubResult, trashResult] = await Promise.allSettled([
          attemptUnsubscribe(token, sender.unsubHeader),
          trashAllFromSender(token, sender.email),
        ])
        if (unsubResult.value === 'manual') manualQueue.push(sender)
        if (trashResult.status === 'fulfilled') allTrashedIds.push(...trashResult.value.ids)
      }
      setBulkProgress({ loaded: senders.length, total: senders.length })
      const idSet = new Set(allTrashedIds)
      const removedRecords = rawMessages.filter((m) => idSet.has(m.id))
      pruneMessages(emailSet)
      const automated = senders.length - manualQueue.length
      setStatus(
        manualQueue.length > 0
          ? `Done — ${automated} unsubscribed automatically, ${manualQueue.length} need manual action below.`
          : `Unsubscribed and deleted emails from ${senders.length} sender${senders.length !== 1 ? 's' : ''}.`
      )
      if (manualQueue.length > 0) setNeedsManualUnsub((prev) => [...prev, ...manualQueue])
      onAction?.('trash', allTrashedIds, makeRestoreFn(removedRecords, [...emailSet]))
    } catch (err) {
      onAction?.('trash', allTrashedIds)
      handleGmailError(err, 'Error during bulk operation: ')
    } finally {
      setLoading(false)
      setBulkProgress({ loaded: 0, total: 0 })
    }
  }

  // "Unsub & Delete All Subscriptions" button — always acts on every
  // subscription currently visible under the active filters, regardless of
  // what's checked.
  function handleBulkUnsubAndDelete() {
    setBulkConfirm(false)
    bulkUnsubAndDelete(visibleSubs)
  }

  // The per-selection buttons — Unsub / Delete all / Unsub & delete, but
  // acting on just the checked senders instead of everything in view. Only
  // 'delete' is ever triggered from Non-subscriptions, since there's nothing
  // to unsubscribe from there.
  function runSelectedAction() {
    const type = selectedActionConfirm
    setSelectedActionConfirm(null)
    const toProcess = filteredSenders.filter((s) => selectedSenders.has(s.email))
    if (type === 'unsub') bulkUnsubscribe(toProcess)
    else if (type === 'unsubDelete') bulkUnsubAndDelete(toProcess)
    else bulkDelete(toProcess)
  }

  // Confirmation text for the per-selection buttons.
  function selectedActionText(type) {
    const n = selectedSenders.size
    const s = n !== 1 ? 's' : ''
    if (type === 'unsub') return `Unsubscribe from ${n} selected sender${s}?`
    if (type === 'unsubDelete') return `Unsubscribe from ${n} selected sender${s} and delete all their emails? They'll be moved to Trash.`
    return `Delete all emails from ${n} selected sender${s}? They'll be moved to Trash.`
  }

  // --- UI ---

  return (
    <div ref={rootRef} className="h-full flex flex-col min-h-0">
      {/* Header, filters, and the results list share one scrollable region
          that fills whatever space isn't taken by the manual-unsubscribe
          panel below (if it's showing) — so scrolling down here moves the
          filters out of view and gives the list more room, same as before. */}
      <div className="relative flex-1 min-h-0">
        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto pr-1">
        {/* Scan box — the rescan button and the Inbox/All mail choice live
            inside one bordered, shaded box. Keeping this visually separate
            from Filters/Show/results below makes clear that only what's in
            this box triggers a new scan — nothing underneath it does. */}
        <div className="mb-3 p-2 border border-gray-300 rounded-lg bg-gray-50">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs font-semibold text-gray-600">Senders</p>
            <button
              onClick={() => runScan()}
              disabled={loading}
              className="text-xs px-2 py-1 bg-gray-800 text-white rounded hover:bg-gray-900 disabled:opacity-50"
            >
              {loading ? 'Scanning...' : (hasScannedRef.current || lastScanTime) ? 'Rescan' : 'Scan'}
            </button>
          </div>

          {/* Timestamp shown once we know when the last scan happened, even if
              that was in a previous session and there's nothing on screen yet.
              Includes which scope it covered, since Inbox and All mail scans
              can turn up very different results. */}
          {lastScanTime && !loading && (
            <p className="text-xs text-gray-400 mb-2">
              Last scanned {lastScanScope === 'inbox' ? 'Inbox' : 'All mail'} {formatTimeAgo(lastScanTime)}
            </p>
          )}

          {/* Scope — either/or, so a single connected segmented control. This is
              the only control on this tab that requires a rescan to take effect. */}
          <div>
            <p className="text-xs text-gray-500 mb-1">Where to look</p>
            <div className="inline-flex rounded-full border border-gray-300 overflow-hidden text-xs bg-white">
              <button
                onClick={() => setScope('inbox')}
                disabled={loading}
                className={`px-3 py-1 disabled:opacity-50 ${
                  scope === 'inbox' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                Inbox
              </button>
              <button
                onClick={() => setScope('all')}
                disabled={loading}
                className={`px-3 py-1 border-l border-gray-300 disabled:opacity-50 ${
                  scope === 'all' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                All mail
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              {scope === 'inbox'
                ? 'Only mail currently in your inbox.'
                : 'Every message you have, including Spam and Trash.'}
            </p>
          </div>
        </div>

        {/* Filters and Show only make sense once there's scanned data to apply
            them to — hidden before the first scan of this session so they
            don't look like they're doing something with nothing to act on. */}
        {(loading || hasScannedRef.current) && (
          <>
            {/* Filters — instant, applied to the last scan already in memory.
                Toggling these never triggers a new scan or API call. */}
            <div className="mb-1">
              <p className="text-xs text-gray-500 mb-1">Filters</p>
              <div className="flex flex-wrap gap-1.5">
                {FILTERS.map((filter) => {
                  const isActive = activeFilters.has(filter.id)
                  return (
                    <button
                      key={filter.id}
                      onClick={() => toggleFilter(filter.id)}
                      className={`px-2 py-1 text-xs rounded-full border ${
                        isActive
                          ? 'bg-blue-600 border-blue-600 text-white'
                          : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {filter.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <p className="text-xs text-gray-400 mb-3">Applied instantly to the last scan — no rescan needed.</p>

            {/* Show — which senders appear, based on whether they've sent at
                least one email with a List-Unsubscribe header. Subscriptions
                sits on the left, Non-subscriptions on the right. */}
            <div className="mb-3">
              <p className="text-xs text-gray-500 mb-1">Show</p>
              <div className="inline-flex rounded-full border border-gray-300 overflow-hidden text-xs">
                <button
                  onClick={() => setShowMode('sub')}
                  className={`px-3 py-1 ${showMode === 'sub' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  Subscriptions
                </button>
                <button
                  onClick={() => setShowMode('nonsub')}
                  className={`px-3 py-1 border-l border-gray-300 ${showMode === 'nonsub' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  Non-subscriptions
                </button>
              </div>

              {/* Totals for each side — shown regardless of which Show mode is
                  selected, so it's possible to compare subscriptions against
                  everything else without switching back and forth. */}
              <div className="text-xs text-gray-400 mt-1 space-y-0.5">
                <p>Subscriptions: {subSenders.length} sender{subSenders.length !== 1 ? 's' : ''} · {formatSize(subTotalBytes)}</p>
                <p>Non-subscriptions: {nonSubSenders.length} sender{nonSubSenders.length !== 1 ? 's' : ''} · {formatSize(nonSubTotalBytes)}</p>
              </div>
            </div>
          </>
        )}

        {status && <p className="text-xs text-gray-400 mb-2">{status}</p>}

        {/* Spinner shown right after clicking Scan, before any results have
            streamed in yet. Gmail has to collect every matching message ID
            before it can start returning details, which can take a moment
            with nothing else on screen changing — this makes clear the scan
            has actually started rather than looking stalled. */}
        {loading && rawMessages.length === 0 && (
          <div className="flex items-center gap-2 py-4 text-xs text-gray-400">
            <span className="inline-block w-3 h-3 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin shrink-0" />
            Finding senders...
          </div>
        )}

        {/* Scan progress bar */}
        {loading && bulkProgress.total === 0 && (
          <div className="mb-3">
            <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
              {progress.total === 0 ? (
                <div className="bg-blue-400 h-1.5 w-full animate-pulse rounded-full" />
              ) : (
                <div
                  className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round((progress.loaded / progress.total) * 100)}%` }}
                />
              )}
            </div>
          </div>
        )}

        {/* Bulk unsub+delete confirmation */}
        {bulkConfirm && (
          <div className="mb-2 bg-red-50 border border-red-200 rounded p-2 text-xs">
            <p className="text-gray-800 mb-2">
              Unsubscribe and delete all emails from {visibleSubs.length} sender{visibleSubs.length !== 1 ? 's' : ''}? Unsubscribe requests will be sent silently in the background.
            </p>
            <div className="flex gap-2">
              <button onClick={handleBulkUnsubAndDelete} className="px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700">
                Yes, delete all
              </button>
              <button onClick={() => setBulkConfirm(false)} className="px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Bulk delete progress bar */}
        {bulkProgress.total > 0 && (
          <div className="mb-2">
            <p className="text-xs text-gray-400 mb-1">
              Deleting emails from sender {bulkProgress.loaded + 1} of {bulkProgress.total}...
            </p>
            <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-red-500 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${Math.round((bulkProgress.loaded / bulkProgress.total) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Bulk action button — only when there are subscription senders currently visible */}
        {visibleSubs.length > 0 && !bulkConfirm && (
          <button
            onClick={() => setBulkConfirm(true)}
            disabled={loading || !!acting}
            className="w-full mb-3 px-2 py-1.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
          >
            Unsub &amp; Delete All Subscriptions ({visibleSubs.length} senders · {formatSize(visibleSubBytes)})
          </button>
        )}

        {/* Sort toggle */}
        {filteredSenders.length > 0 && (
          <div className="flex items-center gap-2 mb-2">
            <label className="text-xs text-gray-500 shrink-0">Sort by</label>
            <div className="flex gap-1">
              <button
                onClick={() => setSortBy('count')}
                className={`px-2 py-0.5 text-xs rounded border ${
                  sortBy === 'count' ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                }`}
              >
                Count
              </button>
              <button
                onClick={() => setSortBy('size')}
                className={`px-2 py-0.5 text-xs rounded border ${
                  sortBy === 'size' ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                }`}
              >
                Size
              </button>
            </div>
          </div>
        )}

        {/* Select all / act on selected — manual multi-select, available in
            both views. On Subscriptions it offers all three actions, same as
            a single row (Unsub, Delete all, Unsub & delete); on
            Non-subscriptions only Delete all makes sense, since those
            senders have nothing to unsubscribe from. */}
        {filteredSenders.length > 0 && (
          <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} />
              Select all
            </label>
            {selectedSenders.size > 0 && !selectedActionConfirm && (
              <div className="flex gap-1">
                {showMode === 'sub' && (
                  <button
                    onClick={() => setSelectedActionConfirm('unsub')}
                    disabled={loading || !!acting}
                    className="px-2 py-1 text-xs bg-gray-100 text-gray-700 border border-gray-300 rounded hover:bg-gray-200 disabled:opacity-50"
                  >
                    Unsub selected
                  </button>
                )}
                <button
                  onClick={() => setSelectedActionConfirm('delete')}
                  disabled={loading || !!acting}
                  className="px-2 py-1 text-xs bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 disabled:opacity-50"
                >
                  Delete selected ({selectedSenders.size})
                </button>
                {showMode === 'sub' && (
                  <button
                    onClick={() => setSelectedActionConfirm('unsubDelete')}
                    disabled={loading || !!acting}
                    className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                  >
                    Unsub &amp; delete selected
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {selectedActionConfirm && (
          <div className="mb-2 bg-red-50 border border-red-200 rounded p-2 text-xs">
            <p className="text-gray-800 mb-2">{selectedActionText(selectedActionConfirm)}</p>
            <div className="flex gap-2">
              <button onClick={runSelectedAction} className="px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700">
                Yes, confirm
              </button>
              <button onClick={() => setSelectedActionConfirm(null)} className="px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300">
                Cancel
              </button>
            </div>
          </div>
        )}

        {hasScannedRef.current && !loading && filteredSenders.length === 0 && (
          <p className="text-xs text-gray-400 mb-2">No senders match the current filters.</p>
        )}

        {/* Sender list — part of the same scroll as everything above it, so
            scrolling down here moves the filters out of view too. */}
        {filteredSenders.length > 0 && (
          <ul className="space-y-2 select-none">
            {filteredSenders.map((sender) => {
              const isActing = acting === sender.email
              const value = sortBy === 'count' ? sender.count : sender.totalBytes
              const barPct = Math.max(2, Math.round((value / maxValue) * 100))
              const isSelected = selectedSenders.has(sender.email)
              return (
                <li
                  key={sender.email}
                  data-sender-email={sender.email}
                  onClick={() => window.parent.postMessage(
                    { type: 'OPEN_SEARCH', query: `from:${sender.email}` }, '*'
                  )}
                  title={`Search Gmail for emails from ${sender.email}`}
                  className={`flex gap-2 text-xs border-b border-gray-100 pb-2 last:border-0 last:pb-0 cursor-pointer rounded px-1 -mx-1 ${
                    isSelected ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-gray-50'
                  }`}
                >
                  {/* Drag-select rail — a bead on a vertical track, not a plain
                      checkbox. The track runs the full height of this row and
                      meets the next row's track right below it, so the whole
                      column reads as one continuous rail you slide a
                      selection up and down, the same way a vertical slider
                      works — rather than a set of unrelated checkboxes.
                      It's the row's own click that opens a Gmail search, so
                      the rail needs its own mousedown/mouseenter (and to stop
                      those from also triggering that search). Cursor is a
                      plain "grab" hand — not the resize double-arrow, which
                      wrongly implied this could expand/resize something. */}
                  <div className="relative shrink-0 w-4 flex flex-col items-center justify-center">
                    <div className="absolute top-0 bottom-0 w-0.5 rounded-full bg-gray-200" />
                    <button
                      type="button"
                      onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); startSenderDrag(sender.email, e) }}
                      onMouseEnter={() => senderDragOver(sender.email)}
                      onClick={(e) => e.stopPropagation()}
                      aria-pressed={isSelected}
                      title="Drag up or down to select multiple senders"
                      className={`relative z-10 w-3.5 h-3.5 rounded-full border-2 cursor-grab active:cursor-grabbing shrink-0 transition-colors ${
                        isSelected ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300 hover:border-blue-400'
                      }`}
                    />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 mb-1">
                      <span className="flex-1 min-w-0 truncate text-gray-700 font-medium" title={sender.email}>
                        {sender.name || sender.email}
                      </span>
                      {sender.isSubscription && (
                        <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                          Subscription
                        </span>
                      )}
                      <span className="text-gray-400 shrink-0 ml-1 text-right">
                        <span className="block">{sender.count} emails</span>
                        <span className="block">{formatSize(sender.totalBytes || 0)}</span>
                      </span>
                    </div>

                    <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden mb-1.5">
                      <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${barPct}%` }} />
                    </div>

                    {isActing ? (
                      <p className="text-gray-400 italic">Working...</p>
                    ) : confirmAction && confirmAction.sender.email === sender.email ? (
                      /* Confirmation replaces the normal buttons for this row
                         only — a deliberate second click, not a popup that
                         could itself be clicked through by accident. */
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="bg-red-50 border border-red-200 rounded p-1.5"
                      >
                        <p className="text-gray-800 mb-1">{confirmActionText(confirmAction.type, sender)}</p>
                        <div className="flex gap-1">
                          <button
                            onClick={runConfirmedAction}
                            className="px-2 py-0.5 bg-red-600 text-white rounded hover:bg-red-700"
                          >
                            Yes, confirm
                          </button>
                          <button
                            onClick={() => setConfirmAction(null)}
                            className="px-2 py-0.5 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        {sender.isSubscription && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmAction({ sender, type: 'unsub' }) }}
                            disabled={!!acting || loading}
                            className="px-2 py-0.5 bg-gray-100 text-gray-700 border border-gray-300 rounded hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Unsub
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmAction({ sender, type: 'delete' }) }}
                          disabled={!!acting || loading}
                          className="px-2 py-0.5 bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Delete all
                        </button>
                        {sender.isSubscription && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmAction({ sender, type: 'unsubDelete' }) }}
                            disabled={!!acting || loading}
                            className="px-2 py-0.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Unsub &amp; delete
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        </div>

        {/* Back to top — scrolls this region (header, filters, and list)
            back to the top; it sits within this region so it never overlaps
            the manual-unsubscribe panel pinned below. */}
        {showBackToTop && (
          <button
            onClick={scrollToTop}
            title="Back to top"
            className="absolute bottom-2 right-2 w-8 h-8 flex items-center justify-center rounded-full bg-gray-800 text-white shadow-md hover:bg-black"
          >
            ↑
          </button>
        )}
      </div>

      {/* Manual unsubscribe queue — senders whose pages require a button
          click. Pinned at the bottom rather than part of the scroll above,
          so it's always visible without scrolling all the way down to find
          it. Sizes itself to fit its own content, capped at 1/3 of this
          tab's height (the drag handle can also pull it smaller, giving the
          sender list above more room, or back up toward that same 1/3 cap).
          Only shown on the Subscriptions view, since manual unsubscribing
          has nothing to do with Non-subscriptions. */}
      {needsManualUnsub.length > 0 && showMode === 'sub' && (
        <div
          ref={manualPanelRef}
          className="shrink-0 flex flex-col mt-3 border-t border-amber-200"
          style={{
            maxHeight: '33.333%',
            height: manualPanelHeight != null ? `${manualPanelHeight}px` : undefined,
          }}
        >
          {/* Drag handle — grab and drag up to grow this panel (shrinking the
              sender list above), or down to shrink it (growing the list).
              Double-click resets back to "fit my content, up to the cap". */}
          <div
            onMouseDown={startManualPanelDrag}
            onDoubleClick={() => setManualPanelHeight(null)}
            title="Drag to resize · double-click to reset"
            className="shrink-0 -mt-px flex items-center justify-center py-1 cursor-ns-resize touch-none select-none group"
          >
            <div className="w-10 h-1 rounded-full bg-amber-300 group-hover:bg-amber-500" />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            <p className="text-xs font-semibold text-amber-600 mb-0.5">
              ⚠ Needs manual unsubscribe ({needsManualUnsub.length})
            </p>
            <p className="text-xs text-gray-400 mb-2">
              These senders use a confirmation page that requires a button click. Open each one to finish unsubscribing.
            </p>
            <ul className="space-y-1">
              {needsManualUnsub.map((sub) => {
                const url = parseUnsubscribeUrl(sub.unsubHeader)
                return (
                  <li key={sub.email} className="flex items-center gap-2 text-xs">
                    <span className="flex-1 min-w-0 truncate text-gray-700" title={sub.email}>
                      {sub.name || sub.email}
                    </span>
                    <button
                      onClick={() => {
                        if (url) window.parent.postMessage({ type: 'OPEN_URL', url }, '*')
                        setNeedsManualUnsub((prev) => prev.filter((s) => s.email !== sub.email))
                      }}
                      className="shrink-0 px-2 py-0.5 text-xs bg-amber-50 text-amber-700 border border-amber-300 rounded hover:bg-amber-100"
                    >
                      Open
                    </button>
                    <button
                      onClick={() => setNeedsManualUnsub((prev) => prev.filter((s) => s.email !== sub.email))}
                      className="shrink-0 text-gray-300 hover:text-gray-500"
                      title="Dismiss"
                    >
                      ✕
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
