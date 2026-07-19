// SendersTab.jsx — the merged "Top Senders" tab. One scan reads every message
// in the chosen scope (Inbox or All mail) and tags each one as a
// "subscription" if it carries a List-Unsubscribe header; filters, the
// Subscriptions/Everything-else toggle, and sorting all re-slice that same
// scanned data instantly with no new API calls. Only changing the scope
// requires scanning again.
//
// The tab moves through three phases, per the design:
//   'form'    — "Where to look" (Inbox / All mail) + the Scan button
//   'busy'    — the "Scanning…" card with a progress bar
//   'results' — sender count header + Rescan, filter chips, the
//               Subscriptions/Everything-else switch, and the sender cards
//               with the drag-to-select rail
//
// The full scan is saved to chrome.storage.local after every scan and
// restored on mount, so opening the panel in a new session lands straight on
// real results. This needs the "unlimitedStorage" permission in
// manifest.json — a large "All mail" scan can be several megabytes of JSON.

import { useState, useRef, useMemo, useEffect } from 'react'
import { getToken, GmailAuthError } from './auth.js'
import { scanSenders, trashAllFromSender, attemptUnsubscribe, parseUnsubscribeUrl } from './gmail.js'
import { formatSize, formatTimeAgo, dragScrollSpeed } from './utils.js'
import { Segmented, ConfirmSheet, Rail, BulkBar, PrimaryButton, ProgressStrip } from './ui.jsx'

const DAY_MS = 24 * 60 * 60 * 1000
const ONE_MB = 1 * 1024 * 1024
const FIVE_MB = 5 * 1024 * 1024

// Each filter is applied client-side against the already-scanned messages —
// none of these trigger a rescan.
const FILTERS = [
  { id: 'olderThan1y', label: 'Older than 1 year' },
  { id: 'olderThan6m', label: 'Older than 6 months' },
  { id: 'unread', label: 'Unread only' },
  { id: 'readOnly', label: 'Read only' },
  { id: 'largerThan1mb', label: 'Larger than 1 MB' },
  { id: 'largerThan5mb', label: 'Larger than 5 MB' },
]

// Pairs that can't both be on: an email can't be unread AND read, so
// turning one on turns the other off.
const EXCLUSIVE_FILTERS = { unread: 'readOnly', readOnly: 'unread' }

// `onAuthError` is called whenever a Gmail action fails because the token has
// expired or been revoked — App.jsx uses it to show a "Reconnect Gmail"
// banner above both tabs. `onAction` publishes Delete/Unsub & delete
// immediately so App.jsx can show its shared Undo toast while Gmail batches
// run — the Undo control itself lives there, not in this tab.
export default function SendersTab({ onAuthError, onAction, enqueueBackgroundAction }) {
  // Every message from the last scan, unfiltered — the single source of truth.
  const [rawMessages, setRawMessages] = useState([])

  // Which of the three screens is showing (see the top-of-file comment).
  const [zPhase, setZPhase] = useState('form')

  // Vertical entrance for phase changes within this tab (results rise up,
  // the form drops back down) — applied only at the moment the phase
  // changes, so re-showing the tab after a tab switch doesn't replay it.
  // Same pattern as SearchTab; see the comment there for the full why.
  const [phaseAnim, setPhaseAnim] = useState(null)
  const prevPhaseRef = useRef(zPhase)
  useEffect(() => {
    if (prevPhaseRef.current === zPhase) return
    prevPhaseRef.current = zPhase
    setPhaseAnim(zPhase === 'results' ? 'gcInUp .22s ease' : 'gcInDown .22s ease')
    const t = setTimeout(() => setPhaseAnim(null), 260)
    return () => clearTimeout(t)
  }, [zPhase])

  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [progress, setProgress] = useState({ loaded: 0, total: 0 })

  // True only while a scan is streaming results in. `loading` also covers
  // the remaining blocking unsubscribe-only flow.
  const [scanning, setScanning] = useState(false)
  // Checked between batches (via scanSenders' isCancelled option) so the
  // Stop button can halt a scan mid-run, keeping the partial results.
  const scanCancelledRef = useRef(false)

  // When the most recent completed scan happened, which scope it covered,
  // and whether it was stopped early (partial).
  const [lastScanTime, setLastScanTime] = useState(null)
  const [lastScanScope, setLastScanScope] = useState(null)
  const [lastScanPartial, setLastScanPartial] = useState(false)

  // Scope — 'inbox' or 'all'. The only control that requires a rescan to apply.
  const [scope, setScope] = useState('inbox')

  // Client-side filters and the subscription visibility toggle.
  const [activeFilters, setActiveFilters] = useState(new Set())
  const [showMode, setShowMode] = useState('sub') // 'sub' | 'nonsub'
  const [sortBy, setSortBy] = useState('size')

  function toggleFilter(id) {
    setActiveFilters((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        // e.g. selecting "Read only" while "Unread only" is on switches them
        const opposite = EXCLUSIVE_FILTERS[id]
        if (opposite) next.delete(opposite)
      }
      return next
    })
  }

  // Senders the user has already unsubscribed from or deleted — persisted so
  // they don't reappear on future scans either.
  const [dismissedSubs, setDismissedSubs] = useState(new Set())

  const [bulkProgress, setBulkProgress] = useState({ loaded: 0, total: 0 })
  const [needsManualUnsub, setNeedsManualUnsub] = useState([])

  // Manual multi-select — checked senders (in either view) that the floating
  // bulk bar acts on.
  const [selectedSenders, setSelectedSenders] = useState(new Set())

  // The pending confirmation sheet: null, or { title, body, cta, danger,
  // onConfirm }. Every destructive action — single-row or bulk — goes
  // through this before anything fires.
  const [confirm, setConfirm] = useState(null)

  // Shared by every catch block below.
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
  // so the sender reappears in the list. `emailsToUndismiss` additionally
  // un-dismisses senders that were unsubscribed as part of the same action.
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

  // Starts a sender-side Trash job while publishing its Undo toast now, not
  // after every sender and Gmail page finishes. Undo restores the cached scan
  // immediately, cancels untouched work, and lets App reverse only IDs from
  // the batch that was already in flight.
  function enqueueTrashWithImmediateUndo({ count, restoreLocal, run }) {
    let undoRequested = false
    let resolveJob
    const jobDone = new Promise((resolve) => { resolveJob = resolve })

    const cancelJob = enqueueBackgroundAction({
      onCancel: () => {
        if (!undoRequested) restoreLocal?.()
        resolveJob([])
      },
      run: async (context) => {
        let succeededIds = []
        try {
          succeededIds = await run({
            ...context,
            isUndoRequested: () => undoRequested,
          }) || []
        } finally {
          resolveJob(succeededIds)
        }
      },
    })

    onAction?.(
      'trash',
      [],
      restoreLocal,
      {
        count,
        prepareUndo: async () => {
          undoRequested = true
          cancelJob()
          return jobDone
        },
      }
    )
  }

  // Selection and any pending confirmation are scoped to whichever view is
  // active — clear both when switching so a leftover from one view doesn't
  // silently apply in the other.
  useEffect(() => {
    setSelectedSenders(new Set())
    setConfirm(null)
  }, [showMode])

  // Guards against the persist-effect below overwriting saved manual-unsub
  // data with an empty array before that data has finished loading from
  // storage on mount.
  const manualUnsubLoadedRef = useRef(false)

  const hasScannedRef = useRef(false)
  // The single scrollable container for the whole tab — header, filters, and
  // the results list all scroll together as one unit.
  const scrollRef = useRef(null)
  const [showBackToTop, setShowBackToTop] = useState(false)

  function handleScroll() {
    setShowBackToTop((scrollRef.current?.scrollTop || 0) > 200)
  }
  function scrollToTop() {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // --- Manual-unsubscribe panel: drag-to-resize ---
  // rootRef measures the tab's own height so the "1/3 of the panel" cap on
  // dragging stays correct if the window is resized. manualPanelHeight is
  // null by default, meaning "size to fit content, up to the default cap" —
  // once someone drags the handle, it becomes a fixed pixel height.
  const rootRef = useRef(null)
  const manualPanelRef = useRef(null)
  const [manualPanelHeight, setManualPanelHeight] = useState(null)

  function startManualPanelDrag(e) {
    e.preventDefault()
    const startY = e.clientY
    const rootHeight = rootRef.current?.clientHeight || 0
    const maxHeight = rootHeight / 3
    const minHeight = 48
    const startHeight = manualPanelRef.current?.getBoundingClientRect().height || maxHeight

    function onMove(ev) {
      // Handle sits at the top of the panel, so moving the mouse up grows it.
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
  // immediately. With nothing saved, the tab starts on the scan form.
  useEffect(() => {
    chrome.storage.local.get(
      ['sendersLastScanTime', 'sendersLastScanScope', 'sendersLastScanData', 'sendersLastScanPartial', 'sendersNeedsManualUnsub'],
      (r) => {
        if (r.sendersLastScanTime) {
          setLastScanTime(r.sendersLastScanTime)
          setLastScanPartial(!!r.sendersLastScanPartial)
          const savedScope = r.sendersLastScanScope || 'all' // old data before this field existed was always an all-mail scan
          setLastScanScope(savedScope)
          setScope(savedScope)
          if (r.sendersLastScanData) {
            setRawMessages(r.sendersLastScanData)
            hasScannedRef.current = true
            setZPhase('results')
          }
          if (r.sendersNeedsManualUnsub) setNeedsManualUnsub(r.sendersNeedsManualUnsub)
        }
        manualUnsubLoadedRef.current = true
      }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the manual-unsubscribe queue in storage so it survives closing the
  // panel or reloading the extension, the same way scan data does.
  useEffect(() => {
    if (!manualUnsubLoadedRef.current) return
    chrome.storage.local.set({ sendersNeedsManualUnsub: needsManualUnsub }, () => {
      if (chrome.runtime.lastError) {
        console.warn('Could not save manual-unsubscribe queue:', chrome.runtime.lastError.message)
      }
    })
  }, [needsManualUnsub])

  // --- Scan ---

  // Saves the full scan to storage.local so it survives closing the panel.
  // `partial` marks a scan that was stopped early, so a later session's
  // "last scanned" caption doesn't claim more coverage than it has.
  function persistScan(messages, time, scanScope, partial = false) {
    chrome.storage.local.set(
      { sendersLastScanData: messages, sendersLastScanTime: time, sendersLastScanScope: scanScope, sendersLastScanPartial: partial },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('Could not save scan results:', chrome.runtime.lastError.message)
        }
      }
    )
  }

  async function runScan() {
    setLoading(true)
    setScanning(true)
    setZPhase('results') // results view streams in live below the progress strip
    setStatus('')
    setRawMessages([])
    setSelectedSenders(new Set())
    setConfirm(null)
    setProgress({ loaded: 0, total: 0 })
    scanCancelledRef.current = false

    // Tracks how many messages have streamed in, readable inside catch —
    // component state can't be read back synchronously there.
    let streamedCount = 0

    try {
      const token = await getToken(false)
      const results = await scanSenders(
        token,
        { scope, isCancelled: () => scanCancelledRef.current },
        (loaded, total) => setProgress({ loaded, total }),
        (partial) => { streamedCount = partial.length; setRawMessages(partial) }
      )
      setRawMessages(results)
      hasScannedRef.current = true
      const partial = scanCancelledRef.current // Stop keeps a valid partial scan
      setLastScanPartial(partial)
      const now = Date.now()
      setLastScanTime(now)
      setLastScanScope(scope)
      persistScan(results, now, scope, partial)
    } catch (err) {
      handleGmailError(err)
      if (streamedCount > 0) {
        // Keep whatever streamed in before the error, marked as partial.
        hasScannedRef.current = true
        setLastScanPartial(true)
        setLastScanScope(scope)
        setLastScanTime(Date.now())
      } else if (!hasScannedRef.current) {
        setZPhase('form')
      }
    } finally {
      setLoading(false)
      setScanning(false)
      setProgress({ loaded: 0, total: 0 })
    }
  }

  // --- Aggregation — recomputed whenever the scan data or any filter changes,
  // but never touches the network. This is what makes filters feel instant. ---

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
      if (activeFilters.has('readOnly') && msg.isUnread) continue
      if (activeFilters.has('largerThan1mb') && !(msg.sizeEstimate >= ONE_MB)) continue
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

  const subSenders = useMemo(() => aggregatedSenders.filter((s) => s.isSubscription), [aggregatedSenders])
  const nonSubSenders = useMemo(() => aggregatedSenders.filter((s) => !s.isSubscription), [aggregatedSenders])
  const subTotalBytes = subSenders.reduce((sum, s) => sum + s.totalBytes, 0)
  const nonSubTotalBytes = nonSubSenders.reduce((sum, s) => sum + s.totalBytes, 0)

  const filteredSenders = showMode === 'sub' ? subSenders : nonSubSenders

  const maxValue = filteredSenders.length > 0
    ? Math.max(...filteredSenders.map((s) => (sortBy === 'count' ? s.count : s.totalBytes)))
    : 1

  // The "Unsub & delete all subscriptions" button only ever acts on
  // subscriptions currently visible under the active filters.
  const visibleSubs = filteredSenders.filter((s) => s.isSubscription)
  const visibleSubBytes = visibleSubs.reduce((sum, s) => sum + s.totalBytes, 0)

  const allVisibleSelected = filteredSenders.length > 0 && filteredSenders.every((s) => selectedSenders.has(s.email))

  const selectedList = filteredSenders.filter((s) => selectedSenders.has(s.email))
  const selectedBytes = selectedList.reduce((sum, s) => sum + s.totalBytes, 0)
  const selectedSubs = selectedList.filter((s) => s.isSubscription)

  const scopeLabel = scope === 'inbox' ? 'Inbox' : 'All mail'

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
  // that's just been deleted doesn't reappear if the panel is reopened later.
  function pruneMessages(emailsToRemove) {
    setRawMessages((prev) => {
      const next = prev.filter((m) => !emailsToRemove.has(m.email))
      chrome.storage.local.set({ sendersLastScanData: next })
      return next
    })
    setSelectedSenders((prev) => {
      if (![...emailsToRemove].some((e) => prev.has(e))) return prev
      const next = new Set(prev)
      for (const email of emailsToRemove) next.delete(email)
      return next
    })
  }

  // Removes exact message IDs from whichever scan happens to be on screen
  // when a background job finishes. This matters if the person rescans while
  // deletion is still running: rows loaded by that newer scan are cleaned up
  // as each background job settles too.
  function pruneMessageIds(idsToRemove) {
    if (idsToRemove.size === 0) return
    setRawMessages((prev) => {
      const next = prev.filter((m) => !idsToRemove.has(m.id))
      chrome.storage.local.set({ sendersLastScanData: next })
      return next
    })
  }

  function toggleSelectAll() {
    setSelectedSenders(allVisibleSelected ? new Set() : new Set(filteredSenders.map((s) => s.email)))
  }

  // --- Drag-select on the rail ---
  // senderDragRef is a ref, not state, since only the actual selection
  // changes below should cause a re-render.
  const senderDragRef = useRef(null)
  const senderDragPosRef = useRef({ x: 0, y: 0 })
  const senderDragScrollRafRef = useRef(null)

  // `preview: true` additionally opens a Gmail search for the sender's mail
  // in the page behind the panel — used only for a deliberate click on the
  // card body, never for rail drags or bulk selects, so sweeping a range
  // doesn't fire off a string of Gmail searches. (Kept outside the state
  // updater below — React runs updaters twice in dev to catch impure ones.)
  function applySenderSelection(email, shouldBeSelected, { preview = false } = {}) {
    if (preview && shouldBeSelected && !selectedSenders.has(email)) {
      window.parent.postMessage({ type: 'OPEN_SEARCH', query: `from:${email}` }, '*')
    }
    setSelectedSenders((prev) => {
      if (prev.has(email) === shouldBeSelected) return prev
      const next = new Set(prev)
      shouldBeSelected ? next.add(email) : next.delete(email)
      return next
    })
  }

  // Runs every frame while a drag is active. Auto-scrolls the tab's scroll
  // region when the cursor is near its top or bottom edge, then re-checks
  // whatever sender is now under the cursor so the selection keeps extending
  // as new rows scroll in underneath a stationary mouse.
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

  // --- Confirmations (all destructive actions route through the sheet) ---

  function confirmDeleteSender(sender) {
    const who = sender.name || sender.email
    setConfirm({
      title: `Move ${sender.count.toLocaleString()} emails to Trash?`,
      body: `All mail from ${who} moves to Trash for 30 days. You can undo this right after.`,
      cta: 'Move to Trash',
      danger: true,
      onConfirm: () => { setConfirm(null); handleDeleteSender(sender) },
    })
  }

  function confirmUnsubSender(sender) {
    const who = sender.name || sender.email
    setConfirm({
      title: `Unsubscribe from ${who}?`,
      body: 'Sends an unsubscribe request on your behalf. Existing emails are kept. Unsubscribes usually cannot be undone.',
      cta: 'Unsubscribe',
      danger: false,
      onConfirm: () => { setConfirm(null); handleUnsubscribe(sender) },
    })
  }

  function confirmDeleteSelected() {
    const cnt = selectedList.reduce((a, s) => a + s.count, 0)
    setConfirm({
      title: `Move ${cnt.toLocaleString()} emails to Trash?`,
      body: `All mail from ${selectedList.length} selected sender${selectedList.length !== 1 ? 's' : ''} moves to Trash for 30 days. You can undo this right after.`,
      cta: 'Move to Trash',
      danger: true,
      onConfirm: () => { setConfirm(null); bulkDelete(selectedList) },
    })
  }

  function confirmUnsubSelected() {
    setConfirm({
      title: `Unsubscribe from ${selectedSubs.length} sender${selectedSubs.length !== 1 ? 's' : ''}?`,
      body: 'Sends an unsubscribe request to each selected sender. Existing emails are kept. Unsubscribes usually cannot be undone.',
      cta: 'Unsubscribe',
      danger: false,
      onConfirm: () => { setConfirm(null); bulkUnsubscribe(selectedSubs) },
    })
  }

  function confirmUnsubDeleteSelected() {
    const cnt = selectedSubs.reduce((a, s) => a + s.count, 0)
    setConfirm({
      title: `Unsub & delete ${selectedSubs.length} sender${selectedSubs.length !== 1 ? 's' : ''}?`,
      body: `Sends an unsubscribe request to each selected sender and moves their ${cnt.toLocaleString()} emails to Trash. The deletion can be undone; the unsubscribes cannot.`,
      cta: 'Unsub & delete',
      danger: true,
      onConfirm: () => { setConfirm(null); bulkUnsubAndDelete(selectedSubs) },
    })
  }

  function confirmUnsubDeleteAll() {
    const cnt = visibleSubs.reduce((a, s) => a + s.count, 0)
    setConfirm({
      title: 'Unsub & delete all subscriptions?',
      body: `${visibleSubs.length} senders · ${cnt.toLocaleString()} emails · ~${formatSize(visibleSubBytes)}. Sends an unsubscribe request to every subscription shown and moves their mail to Trash. The deletion can be undone; the unsubscribes cannot.`,
      cta: 'Unsub & delete all',
      danger: true,
      onConfirm: () => { setConfirm(null); bulkUnsubAndDelete(visibleSubs) },
    })
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
  // visible under the filters) — the point is actually freeing up storage.
  function handleDeleteSender(sender) {
    const emailSet = new Set([sender.email])
    const removedRecords = rawMessages.filter((m) => m.email === sender.email)

    // Optimistic removal: the sender card disappears as soon as confirmation
    // closes; Gmail work continues quietly in App's queue.
    pruneMessages(emailSet)
    setStatus('')

    enqueueTrashWithImmediateUndo({
      count: sender.count,
      restoreLocal: makeRestoreFn(removedRecords),
      run: async ({ isCancelled, isUndoRequested }) => {
        let succeededIds = []
        try {
          const token = await getToken(false)
          const result = await trashAllFromSender(token, sender.email, undefined, isCancelled)
          succeededIds = result.ids
          const succeededSet = new Set(result.ids)
          const failedRecords = removedRecords.filter((m) => !succeededSet.has(m.id))

          if (!isUndoRequested()) {
            pruneMessageIds(succeededSet)
            if (failedRecords.length > 0) makeRestoreFn(failedRecords)()
          }

          if (result.authFailed) {
            onAuthError?.()
            setStatus('Your Gmail connection expired — unprocessed sender mail was restored.')
          } else if (!isCancelled() && result.count < result.total) {
            setStatus('Some emails from this sender were not processed and were restored.')
          }
        } catch (err) {
          if (!isUndoRequested()) makeRestoreFn(removedRecords)()
          if (!isCancelled()) handleGmailError(err, 'Error deleting emails: ')
        }
        return succeededIds
      },
    })
  }

  // --- Shared bulk operations ---

  async function bulkUnsubscribe(senders) {
    const emailSet = new Set(senders.map((s) => s.email))
    setDismissedSubs((prev) => {
      const next = new Set([...prev, ...emailSet])
      chrome.storage.local.set({ dismissedSubs: [...next] })
      return next
    })
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

  function bulkDelete(senders) {
    const emailSet = new Set(senders.map((s) => s.email))
    const removedRecords = rawMessages.filter((m) => emailSet.has(m.email))

    pruneMessages(emailSet)
    setStatus('')

    enqueueTrashWithImmediateUndo({
      count: senders.reduce((sum, sender) => sum + sender.count, 0),
      restoreLocal: makeRestoreFn(removedRecords),
      run: async ({ isCancelled, isUndoRequested }) => {
        const allTrashedIds = []
        const succeededSet = new Set()
        let authError = null
        let otherError = null

        try {
          const token = await getToken(false)
          for (const sender of senders) {
            if (isCancelled()) break
            try {
              const result = await trashAllFromSender(token, sender.email, undefined, isCancelled)
              for (const id of result.ids) {
                succeededSet.add(id)
                allTrashedIds.push(id)
              }
              if (result.authFailed) {
                authError = new GmailAuthError('Gmail connection expired')
                break
              }
            } catch (err) {
              if (err instanceof GmailAuthError) {
                authError = err
                break
              }
              otherError = err
            }
          }
        } catch (err) {
          if (err instanceof GmailAuthError) authError = err
          else otherError = err
        }

        const failedRecords = removedRecords.filter((m) => !succeededSet.has(m.id))
        if (!isUndoRequested()) {
          pruneMessageIds(succeededSet)
          if (failedRecords.length > 0) makeRestoreFn(failedRecords)()
        }

        if (authError) {
          onAuthError?.()
          setStatus('Your Gmail connection expired — unprocessed sender mail was restored.')
        } else if (!isCancelled() && (otherError || failedRecords.length > 0)) {
          setStatus('Some sender mail was not processed and was restored.')
        }
        return allTrashedIds
      },
    })
  }

  function bulkUnsubAndDelete(senders) {
    const emailSet = new Set(senders.map((s) => s.email))
    const removedRecords = rawMessages.filter((m) => emailSet.has(m.email))
    setDismissedSubs((prev) => {
      const next = new Set([...prev, ...emailSet])
      chrome.storage.local.set({ dismissedSubs: [...next] })
      return next
    })
    pruneMessages(emailSet)
    setStatus('')

    enqueueTrashWithImmediateUndo({
      count: senders.reduce((sum, sender) => sum + sender.count, 0),
      restoreLocal: makeRestoreFn(removedRecords, [...emailSet]),
      run: async ({ isCancelled, isUndoRequested }) => {
        const manualQueue = []
        const allTrashedIds = []
        const succeededSet = new Set()
        const fullyProcessedEmails = new Set()
        let authError = null
        let otherError = null

        try {
          const token = await getToken(false)
          for (const sender of senders) {
            if (isCancelled()) break
            const [unsubResult, trashResult] = await Promise.allSettled([
              attemptUnsubscribe(token, sender.unsubHeader),
              trashAllFromSender(token, sender.email, undefined, isCancelled),
            ])

            if (unsubResult.status === 'fulfilled' && unsubResult.value === 'manual') {
              manualQueue.push(sender)
            } else if (unsubResult.status === 'rejected') {
              if (unsubResult.reason instanceof GmailAuthError) authError = unsubResult.reason
              else otherError = unsubResult.reason
            }
            if (trashResult.status === 'fulfilled') {
              for (const id of trashResult.value.ids) {
                succeededSet.add(id)
                allTrashedIds.push(id)
              }
              if (!trashResult.value.cancelled && trashResult.value.count === trashResult.value.total) {
                fullyProcessedEmails.add(sender.email)
              }
              if (trashResult.value.authFailed) {
                authError = new GmailAuthError('Gmail connection expired')
                break
              }
            } else if (trashResult.reason instanceof GmailAuthError) {
              authError = trashResult.reason
              break
            } else {
              otherError = trashResult.reason
            }
          }
        } catch (err) {
          if (err instanceof GmailAuthError) authError = err
          else otherError = err
        }

        const failedRecords = removedRecords.filter((m) => !succeededSet.has(m.id))
        const incompleteEmails = [...emailSet].filter((email) => !fullyProcessedEmails.has(email))

        if (!isUndoRequested()) {
          pruneMessageIds(succeededSet)
          if (failedRecords.length > 0 || incompleteEmails.length > 0) {
            makeRestoreFn(failedRecords, incompleteEmails)()
          }
        }
        if (manualQueue.length > 0) {
          setNeedsManualUnsub((prev) => [...prev, ...manualQueue])
        }

        if (authError) {
          onAuthError?.()
          setStatus('Your Gmail connection expired — unprocessed sender mail was restored.')
        } else if (!isCancelled() && (otherError || incompleteEmails.length > 0)) {
          setStatus('Some sender mail was not processed and was restored.')
        } else if (manualQueue.length > 0) {
          setStatus(`${manualQueue.length} unsubscribe${manualQueue.length !== 1 ? 's' : ''} need manual action below.`)
        }
        return allTrashedIds
      },
    })
  }

  // --- UI ---

  return (
    <div ref={rootRef} className="h-full flex flex-col min-h-0 relative">
      {/* Everything except the manual-unsubscribe panel scrolls as one unit.
          Bottom padding leaves room for the floating bulk bar. */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto select-none"
          style={{ padding: '12px 14px 24px' }}
        >
          {/* ============ FORM PHASE ============ */}
          {zPhase === 'form' && (
            <div style={{ animation: phaseAnim || undefined }}>
              <p style={{ margin: '2px 2px 12px', fontSize: 12, color: 'var(--sub)' }}>
                Scan your mailbox grouping mail by sender to spot subscriptions and repeat senders.
              </p>
              <div className="gc-card" style={{ padding: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--sub)', marginBottom: 6 }}>Where to look</div>
                <div style={{ marginBottom: 6 }}>
                  <Segmented
                    value={scope}
                    onChange={setScope}
                    disabled={loading}
                    options={[
                      { value: 'inbox', label: 'Inbox' },
                      { value: 'all', label: 'All mail' },
                    ]}
                  />
                </div>
                <div style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 12 }}>
                  {scope === 'inbox'
                    ? 'Only mail currently in your inbox.'
                    : 'Everything including archived, trash, and spam.'}
                </div>
                <PrimaryButton onClick={runScan} disabled={loading} className="w-full">
                  Scan {scopeLabel}
                </PrimaryButton>
              </div>
              {status && <p style={{ fontSize: 11, color: 'var(--sub)', margin: '10px 2px 0' }}>{status}</p>}
            </div>
          )}

          {/* ============ RESULTS PHASE (streams in live while scanning) ============ */}
          {zPhase === 'results' && (
            <div style={{ animation: phaseAnim || undefined }}>
              {/* While the scan streams: slim sticky progress strip. Sender
                  rows accumulate below it, counts/sizes updating in place. */}
              {scanning && (
                <ProgressStrip
                  title={`Scanning ${scopeLabel.toLowerCase()}…`}
                  detail={progress.total === 0 ? 'collecting the message list…' : null}
                  progress={progress}
                  onStop={() => { scanCancelledRef.current = true }}
                />
              )}

              {/* Scan summary card — total senders under the current filters,
                  what was scanned and when, plus the Rescan button */}
              {/* items-center on the card centers Rescan vertically across
                  the two-line text block (count + scanned-line) beside it. */}
              <div className="gc-card flex items-center gap-2" style={{ padding: '10px 12px', marginBottom: 10 }}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em' }}>
                      {aggregatedSenders.length} senders
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--sub)' }}>· {formatSize(subTotalBytes + nonSubTotalBytes)}</span>
                  </div>
                  {!scanning && (
                    <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                      {lastScanPartial ? 'Stopped early — scanned' : 'Scanned'} {rawMessages.length.toLocaleString()} emails in {lastScanScope === 'inbox' ? 'Inbox' : 'All mail'}
                      {lastScanTime ? ` · ${formatTimeAgo(lastScanTime)}` : ''}
                    </div>
                  )}
                </div>
                {!scanning && (
                  <PrimaryButton pill onClick={runScan} disabled={loading} className="shrink-0">
                    Rescan
                  </PrimaryButton>
                )}
              </div>

              {/* Filter chips — applied instantly, no rescan */}
              <div className="flex flex-wrap gap-1.5" style={{ margin: '0 0 4px' }}>
                {FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    onClick={() => toggleFilter(filter.id)}
                    className="gc-chip"
                    data-active={activeFilters.has(filter.id)}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--faint)', margin: '0 2px 10px' }}>
                Applied instantly to the last scan.
              </div>

              {/* Subscriptions / Everything else */}
              <div style={{ marginBottom: 6 }}>
                <Segmented
                  value={showMode}
                  onChange={setShowMode}
                  options={[
                    { value: 'sub', label: 'Subscriptions' },
                    { value: 'nonsub', label: 'Everything else' },
                  ]}
                />
              </div>
              {/* Per-group totals — each sits centered under its half of the
                  toggle above. The active side darkens/bolds while the other
                  fades, on the same easing + duration as the toggle thumb
                  (.34s cubic-bezier(.22,1,.36,1)) so they move as one. */}
              <div className="grid grid-cols-2" style={{ margin: '4px 0 10px' }}>
                {[
                  { active: showMode === 'sub', count: subSenders.length, bytes: subTotalBytes },
                  { active: showMode === 'nonsub', count: nonSubSenders.length, bytes: nonSubTotalBytes },
                ].map((g, i) => (
                  <div
                    key={i}
                    className="text-center"
                    style={{
                      fontSize: 11, lineHeight: 1.6,
                      color: g.active ? 'var(--ink)' : 'var(--faint)',
                      fontWeight: g.active ? 600 : 400,
                      transition: 'color .34s cubic-bezier(.22,1,.36,1)',
                    }}
                  >
                    {g.count} sender{g.count !== 1 ? 's' : ''} · {formatSize(g.bytes)}
                  </div>
                ))}
              </div>

              {status && <p style={{ fontSize: 11, color: 'var(--sub)', margin: '0 2px 10px' }}>{status}</p>}

              {/* Bulk unsub+delete progress bar */}
              {bulkProgress.total > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <p style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 4 }}>
                    Working on sender {Math.min(bulkProgress.loaded + 1, bulkProgress.total)} of {bulkProgress.total}…
                  </p>
                  <div className="overflow-hidden" style={{ height: 4, borderRadius: 2, background: 'var(--chip)' }}>
                    <div
                      className="h-full"
                      style={{
                        borderRadius: 2, background: 'var(--danger-bar)',
                        width: `${Math.round((bulkProgress.loaded / bulkProgress.total) * 100)}%`,
                        transition: 'width .3s',
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Unsub & delete all subscriptions — only on the Subscriptions view */}
              {showMode === 'sub' && visibleSubs.length > 0 && bulkProgress.total === 0 && (
                <button
                  onClick={confirmUnsubDeleteAll}
                  disabled={loading}
                  title={scanning ? 'Available when the scan finishes' : undefined}
                  className="gc-btn gc-btn-danger w-full"
                  style={{ padding: 10, fontSize: '12.5px', marginBottom: 12 }}
                >
                  Unsub &amp; delete all subscriptions ({visibleSubs.length} · {formatSize(visibleSubBytes)})…
                </button>
              )}

              {/* Select all + sort */}
              {filteredSenders.length > 0 && (
                <div className="flex items-center gap-2" style={{ margin: '0 2px 8px' }}>
                  <button
                    onClick={toggleSelectAll}
                    className="flex items-center gap-1.5 border-none bg-transparent cursor-pointer"
                    style={{ color: 'var(--sub)', fontFamily: 'inherit', fontSize: '11.5px', fontWeight: 600, padding: 2 }}
                  >
                    <span
                      className="grid place-items-center box-border"
                      style={{
                        width: 13, height: 13, borderRadius: 4,
                        border: `1.5px solid ${allVisibleSelected ? 'var(--accent)' : 'var(--faint)'}`,
                        background: allVisibleSelected ? 'var(--accent-grad)' : 'var(--card)',
                        color: 'var(--accent-ink)',
                      }}
                    >
                      {allVisibleSelected && (
                        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M1.5 5.5 4 8l4.5-6" />
                        </svg>
                      )}
                    </span>
                    Select all shown
                  </button>
                  <div className="ml-auto">
                    <Segmented
                      size="pill"
                      value={sortBy}
                      onChange={setSortBy}
                      options={[
                        { value: 'size', label: 'Size' },
                        { value: 'count', label: 'Count' },
                      ]}
                    />
                  </div>
                </div>
              )}

              {/* Sender cards — rail + card. The rail bead starts a drag-
                  select; clicking the card body toggles that row AND opens
                  a Gmail search for the sender's mail in the page behind
                  the panel (same idea as clicking a message row in the
                  Search tab, which opens that email). */}
              {filteredSenders.map((sender) => {
                const value = sortBy === 'count' ? sender.count : sender.totalBytes
                const barPct = Math.max(3, Math.round((value / maxValue) * 100))
                const isSelected = selectedSenders.has(sender.email)
                return (
                  <div
                    key={sender.email}
                    data-sender-email={sender.email}
                    className="flex items-stretch gap-2 gc-row-in"
                    style={{ margin: '0 0 8px' }}
                    onMouseEnter={() => senderDragOver(sender.email)}
                  >
                    <Rail
                      selected={isSelected}
                      onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); startSenderDrag(sender.email, e) }}
                    />
                    <div
                      onClick={() => applySenderSelection(sender.email, !isSelected, { preview: true })}
                      title={`Select — also shows mail from ${sender.email} in Gmail`}
                      className="flex-1 min-w-0 cursor-pointer transition-all hover:-translate-y-[2px] hover:shadow-[0_6px_16px_rgba(40,35,25,.12)]"
                      style={{
                        padding: '10px 12px', borderRadius: 'var(--radius)',
                        border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--line)'}`,
                        background: isSelected ? 'var(--sel)' : 'var(--card)',
                        boxShadow: 'var(--shadow)',
                      }}
                    >
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="overflow-hidden text-ellipsis whitespace-nowrap" style={{ fontWeight: 600, fontSize: '12.5px' }} title={sender.email}>
                            {sender.name || sender.email}
                          </div>
                          {sender.isSubscription && (
                            <div className="flex gap-1" style={{ marginTop: 3 }}>
                              <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--sub)', background: 'var(--chip)', borderRadius: 999, padding: '2px 8px' }}>
                                Subscription
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="text-right shrink-0" style={{ fontSize: 11, color: 'var(--sub)', lineHeight: 1.5 }}>
                          <div>{sender.count.toLocaleString()} email{sender.count !== 1 ? 's' : ''}</div>
                          <div style={{ color: 'var(--faint)' }}>{formatSize(sender.totalBytes || 0)}</div>
                        </div>
                      </div>

                      {/* relative size bar */}
                      <div className="overflow-hidden" style={{ height: 4, borderRadius: 2, background: 'var(--chip)', margin: '9px 0 10px' }}>
                        <div className="h-full" style={{ borderRadius: 2, background: 'var(--accent-grad)', width: `${barPct}%` }} />
                      </div>

                      <div className="flex gap-1.5" style={{ marginTop: 4 }}>
                        {sender.isSubscription && (
                          <button
                            onClick={(e) => { e.stopPropagation(); confirmUnsubSender(sender) }}
                            disabled={loading}
                            className="gc-btn gc-btn-neutral"
                            style={{ padding: '6px 10px', fontSize: '11.5px' }}
                          >
                            Unsubscribe…
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); confirmDeleteSender(sender) }}
                          disabled={loading}
                          className="gc-btn gc-btn-danger"
                          style={{ padding: '6px 10px', fontSize: '11.5px' }}
                        >
                          Delete all…
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}

              {filteredSenders.length === 0 && !loading && (
                <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--faint)', fontSize: 12 }}>
                  No senders in this group.
                </div>
              )}
            </div>
          )}

        </div>

        {/* Back to top — floats over the scroll box once it's scrolled a bit */}
        {showBackToTop && (
          <button
            onClick={scrollToTop}
            title="Back to top"
            className="absolute grid place-items-center cursor-pointer z-10"
            style={{
              bottom: 8, right: 8, width: 32, height: 32, borderRadius: 999,
              border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)',
              boxShadow: 'var(--shadow-dd)',
            }}
          >
            ↑
          </button>
        )}
      </div>

      {/* Manual unsubscribe queue — senders whose pages require a button
          click. Pinned at the bottom rather than part of the scroll above,
          so it's always visible. The handle can drag it taller (up to 1/3 of
          the tab) or shorter; double-click resets. Only shown on the
          Subscriptions view. */}
      {needsManualUnsub.length > 0 && showMode === 'sub' && zPhase === 'results' && (
        <div
          ref={manualPanelRef}
          className="shrink-0 flex flex-col"
          style={{
            borderTop: '2px solid #d9a02b',
            background: 'var(--card)',
            maxHeight: '33.333%',
            height: manualPanelHeight != null ? `${manualPanelHeight}px` : undefined,
          }}
        >
          {/* Drag handle — grab and drag up/down to resize; double-click resets. */}
          <div
            onMouseDown={startManualPanelDrag}
            onDoubleClick={() => setManualPanelHeight(null)}
            title="Drag to resize · double-click to reset"
            className="shrink-0 flex items-center justify-center py-1 cursor-ns-resize touch-none select-none group"
          >
            <div className="w-10 h-1 rounded-full" style={{ background: '#e3c98a' }} />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: '0 14px 12px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#a4770f' }}>
              Needs manual unsubscribe ({needsManualUnsub.length})
            </div>
            <div style={{ fontSize: 11, color: 'var(--sub)', margin: '2px 0 6px' }}>
              These senders use a confirmation page. Open each one to finish unsubscribing.
            </div>
            {needsManualUnsub.map((sub) => {
              const url = parseUnsubscribeUrl(sub.unsubHeader)
              return (
                <div key={sub.email} className="flex items-center gap-2" style={{ padding: '4px 0' }}>
                  <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" style={{ fontSize: 12 }} title={sub.email}>
                    {sub.name || sub.email}
                  </span>
                  <button
                    onClick={() => {
                      if (url) window.parent.postMessage({ type: 'OPEN_URL', url }, '*')
                      setNeedsManualUnsub((prev) => prev.filter((s) => s.email !== sub.email))
                    }}
                    className="shrink-0 cursor-pointer"
                    style={{
                      border: '1px solid #e3c98a', background: '#faf3df', color: '#8a6516',
                      borderRadius: 999, padding: '3px 12px', fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
                    }}
                  >
                    Open
                  </button>
                  <button
                    onClick={() => setNeedsManualUnsub((prev) => prev.filter((s) => s.email !== sub.email))}
                    title="Dismiss"
                    className="shrink-0 grid place-items-center border-none bg-transparent cursor-pointer p-0.5"
                    style={{ color: 'var(--faint)' }}
                  >
                    <svg width="11" height="11" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      <path d="M3 3l8 8M11 3l-8 8" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Bulk-action bar — rises below the scroll area while senders are selected */}
      {zPhase === 'results' && selectedList.length > 0 && !confirm && bulkProgress.total === 0 && (
        <BulkBar
          label={`${selectedList.length} sender${selectedList.length !== 1 ? 's' : ''} · ${formatSize(selectedBytes)}`}
          onClear={() => setSelectedSenders(new Set())}
          hint={scanning ? 'Finishing scan… actions unlock when it completes.' : undefined}
        >
          {selectedSubs.length > 0 && (
            <button
              onClick={confirmUnsubSelected}
              disabled={loading}
              className="gc-btn gc-btn-neutral flex-1"
              style={{ padding: '9px 6px', fontSize: 12 }}
            >
              Unsub…
            </button>
          )}
          <button
            onClick={confirmDeleteSelected}
            disabled={loading}
            className="gc-btn gc-btn-danger flex-1"
            style={{ padding: '9px 6px', fontSize: 12 }}
          >
            Delete…
          </button>
          {selectedSubs.length > 0 && (
            <button
              onClick={confirmUnsubDeleteSelected}
              disabled={loading}
              className="gc-btn gc-btn-danger-solid"
              style={{ flex: 1.4, padding: '9px 6px', fontSize: 12 }}
            >
              Unsub &amp; delete…
            </button>
          )}
        </BulkBar>
      )}

      {/* Confirmation sheet — every destructive action passes through here */}
      <ConfirmSheet confirm={confirm} onCancel={() => setConfirm(null)} />
    </div>
  )
}
