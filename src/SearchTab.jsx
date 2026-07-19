// SearchTab.jsx — the "Search" tab: filter emails, preview results, select some,
// then Trash/Archive them (or "Move all matching to Trash" without selecting).
//
// The tab moves through three phases, per the design:
//   'form'    — quick presets + filter fields + the Search button
//   'busy'    — the "Searching your mail…" card with a progress bar
//   'results' — filter summary chip, match summary card (with the Trash-all
//               button and its live progress), top senders, and the message
//               list with the drag-to-select rail
// "Edit" on the results screen returns to 'form' with the fields intact.
//
// All the Gmail logic (batching, rate-limit pauses, undo reporting) is the
// same as before the redesign — only the presentation changed.

import { useState, useRef, useEffect } from 'react'
import { getToken, GmailAuthError } from './auth.js'
import {
  listAllMessageIds, getAllIds, getMessageMetadata, trashMessage, archiveMessage,
} from './gmail.js'
import { formatSize, parseSenderName, dragScrollSpeed } from './utils.js'
import { PRESETS } from './presets.js'
import FilterPanel, { buildQuery, DEFAULT_FILTERS } from './FilterPanel.jsx'
import { Dropdown, ConfirmSheet, Rail, BulkBar, PrimaryButton, ProgressStrip } from './ui.jsx'

const SORT_OPTIONS = [
  { value: 'largest',  label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
  { value: 'newest',   label: 'Newest first' },
  { value: 'oldest',   label: 'Oldest first' },
  { value: 'sender',   label: 'By sender' },
]

// `onAuthError` is called whenever a Gmail action fails because the token has
// expired or been revoked — App.jsx uses it to show a "Reconnect Gmail"
// banner above both tabs. `onAction` publishes Trash/Archive immediately so
// App.jsx can show a shared Undo toast while background batches are running —
// the Undo control itself lives there, not in this tab.
export default function SearchTab({ onAuthError, onAction, enqueueBackgroundAction }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  function handleFilterChange(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  // Which of the three screens is showing (see the top-of-file comment).
  const [phase, setPhase] = useState('form')

  // Vertical entrance for phase changes within this tab: results rise up,
  // the form drops back down. Applied as a short-lived inline animation only
  // at the moment the phase actually changes — if it were set permanently,
  // it would also replay whenever the tab is shown again after switching
  // tabs (display:none → block restarts CSS animations), which is exactly
  // the "feels like a tab switch" confusion this avoids.
  const [phaseAnim, setPhaseAnim] = useState(null)
  const prevPhaseRef = useRef(phase)
  useEffect(() => {
    if (prevPhaseRef.current === phase) return
    prevPhaseRef.current = phase
    setPhaseAnim(phase === 'results' ? 'gcInUp .22s ease' : 'gcInDown .22s ease')
    const t = setTimeout(() => setPhaseAnim(null), 260) // clear after it finishes
    return () => clearTimeout(t)
  }, [phase])

  const [emails, setEmails] = useState([])
  const [totalSize, setTotalSize] = useState(null)     // bytes — null until a search completes
  const [sizeIsEstimate, setSizeIsEstimate] = useState(false) // true when extrapolated from a sample
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [sortBy, setSortBy] = useState('largest') // default: biggest emails first

  // Total number of matching emails — may be more than the 500 shown.
  // Null until a search completes. This is what "Move all N to Trash…" uses.
  const [matchTotal, setMatchTotal] = useState(null)
  // The query string of the last completed search, kept so Trash-all can
  // re-run it even after the filter fields change.
  const lastQueryRef = useRef('')

  // Label of the preset currently highlighted, or null when the results came
  // from the filters instead.
  const [activePreset, setActivePreset] = useState(null)

  // The pending confirmation sheet: null, or { title, body, cta, danger,
  // onConfirm }. Every destructive action goes through this before firing.
  const [confirm, setConfirm] = useState(null)

  // Live-search state: null when idle, or { stage: 'searching' | 'estimating' }
  // while a search is streaming. The results list renders underneath the
  // sticky progress strip and rows appear batch by batch as they load.
  const [searchRun, setSearchRun] = useState(null)
  // True when the search ended early (Stop, or an error mid-stream) — the
  // summary card then labels the results as partial, and "Move all to
  // Trash" is hidden since "all matching" could be more than what's shown.
  const [stoppedEarly, setStoppedEarly] = useState(false)
  // Checked between batches so Stop can halt the search loops mid-run.
  const searchCancelledRef = useRef(false)
  const [eta, setEta] = useState(null) // seconds remaining, null = unknown

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

  // Caches the results of each Quick Preset the first time it's run, keyed by
  // label. A plain ref (not state) because updating it should never itself
  // cause a re-render. Re-clicking a preset that's already in here just
  // redisplays the saved results instead of hitting the Gmail API again.
  const presetCacheRef = useRef({})

  // The one scroll container for the whole tab (everything scrolls together,
  // like a webpage). Drag-to-select auto-scrolls this box near its edges.
  const scrollRef = useRef(null)
  const [showBackToTop, setShowBackToTop] = useState(false)

  function handleScroll() {
    setShowBackToTop((scrollRef.current?.scrollTop || 0) > 200)
  }
  function scrollToTop() {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // --- Selection helpers ---

  // Tracks an in-progress drag-select: null when no drag is happening, or the
  // boolean state (checked/unchecked) being "painted" onto every row the
  // mouse passes over while the button is held down.
  const dragStateRef = useRef(null)
  const dragPosRef = useRef({ x: 0, y: 0 })
  const dragScrollRafRef = useRef(null)

  // Applies (or removes) one email from the selection. `preview` controls
  // whether opening it in the Gmail page underneath happens too — that only
  // makes sense for a single deliberate click, not for every row a drag
  // sweeps over, so drag-painting passes preview: false.
  function applySelection(id, shouldBeSelected, { preview = false } = {}) {
    setSelected((prev) => {
      if (prev.has(id) === shouldBeSelected) return prev // no-op, avoid pointless re-renders mid-drag
      const next = new Set(prev)
      if (shouldBeSelected) {
        next.add(id)
        if (preview) window.parent.postMessage({ type: 'OPEN_EMAIL', id }, '*')
      } else {
        next.delete(id)
      }
      return next
    })
  }

  // Runs every frame while a drag is active. Auto-scrolls the tab's scroll
  // box when the cursor is near its top or bottom edge (speeding up the
  // closer it gets — see dragScrollSpeed in utils.js), then re-checks
  // whatever row is now under the cursor so the selection keeps extending
  // as new rows scroll in underneath a stationary mouse.
  function selectDragScrollTick() {
    const container = scrollRef.current
    if (container) {
      const speed = dragScrollSpeed(container.getBoundingClientRect(), dragPosRef.current.y)
      if (speed !== 0) {
        container.scrollTop += speed
        const { x, y } = dragPosRef.current
        const rowEl = document.elementFromPoint(x, y)?.closest('[data-msg-id]')
        if (rowEl) selectDragOver(rowEl.getAttribute('data-msg-id'))
      }
    }
    dragScrollRafRef.current = requestAnimationFrame(selectDragScrollTick)
  }

  // Starts a drag-select from a row's rail bead: that row flips to the
  // opposite of its current state, and every other row the mouse then passes
  // over (while still held down) flips to that same target state — same as
  // dragging over checkboxes in Finder or Gmail.
  function startSelectDrag(id, event) {
    const target = !selected.has(id)
    dragStateRef.current = target
    dragPosRef.current = { x: event.clientX, y: event.clientY }
    applySelection(id, target, { preview: true })

    function onMove(e) {
      dragPosRef.current = { x: e.clientX, y: e.clientY }
    }
    function onUp() {
      dragStateRef.current = null
      if (dragScrollRafRef.current !== null) {
        cancelAnimationFrame(dragScrollRafRef.current)
        dragScrollRafRef.current = null
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    if (dragScrollRafRef.current === null) {
      dragScrollRafRef.current = requestAnimationFrame(selectDragScrollTick)
    }
  }

  // Called as the mouse enters each row while a drag is in progress.
  function selectDragOver(id) {
    if (dragStateRef.current === null) return
    applySelection(id, dragStateRef.current)
  }

  function selectAll() {
    setSelected(new Set(emails.map((m) => m.id)))
  }
  function selectNone() {
    setSelected(new Set())
  }

  const selectedEmails = emails.filter((m) => selected.has(m.id))
  const selectedBytes = selectedEmails.reduce((sum, m) => sum + (m.sizeEstimate || 0), 0)

  // --- Find emails ---

  // Called when a Quick Presets button is clicked. If we've already run this
  // exact preset earlier in the session, reuse the saved results instantly.
  function runPreset(preset) {
    const cached = presetCacheRef.current[preset.label]
    if (cached) {
      setActivePreset(preset.label)
      setStoppedEarly(false) // cached presets are always complete results
      setEmails(cached.emails)
      setTotalSize(cached.totalSize)
      setSizeIsEstimate(cached.sizeIsEstimate)
      setMatchTotal(cached.matchTotal)
      setStatus('')
      setSelected(new Set())
      setConfirm(null)
      lastQueryRef.current = preset.query
      setPhase('results')
      return
    }
    handleFind(preset.query, preset.label)
  }

  // Called with the constructed query string from the filter form, or by
  // runPreset the first time a given preset is run. Goes straight to the
  // results view and streams rows in batch by batch — the busy state is the
  // sticky progress strip above the growing list, not a separate screen.
  async function handleFind(query, presetLabel = null) {
    setActivePreset(presetLabel)
    setLoading(true)
    setPhase('results')
    setSearchRun({ stage: 'searching' })
    setStoppedEarly(false)
    setEmails([])
    setTotalSize(null)
    setSizeIsEstimate(false)
    setMatchTotal(null)
    setSelected(new Set())
    setConfirm(null)
    setEta(null)
    setStatus('')
    searchCancelledRef.current = false
    lastQueryRef.current = query

    const BATCH_SIZE = 10
    const BATCH_DELAY_MS = 300
    const SAMPLE_SIZE = 350

    // Declared outside the try so the catch block can keep whatever streamed
    // in before an error — partial results stay on screen and usable.
    const allMsgs = []

    // Shared "wrap up as a partial result" path for Stop and mid-run errors:
    // whatever's loaded becomes the (exact-sized) result set.
    const finishPartial = () => {
      setStoppedEarly(true)
      setMatchTotal(allMsgs.length)
      setTotalSize(allMsgs.reduce((sum, m) => sum + (m.sizeEstimate || 0), 0))
      setSizeIsEstimate(false)
    }

    try {
      const token = await getToken(false)

      // Phase 1: fetch the first 500 matching IDs.
      const { ids } = await listAllMessageIds(token, query)

      if (ids.length === 0) {
        setMatchTotal(0)
        setTotalSize(0)
        if (presetLabel) {
          presetCacheRef.current[presetLabel] = {
            emails: [], totalSize: 0, sizeIsEstimate: false, matchTotal: 0,
          }
        }
        return
      }

      const capped = ids.length === 500
      const metadataTotal = capped ? ids.length + SAMPLE_SIZE : ids.length

      // Phase 2: load metadata, streaming rows into the list per batch (one
      // state update per page of responses, not per message). The render
      // sorts on the fly, so new rows land in sort order automatically.
      const startTime = Date.now()

      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        if (searchCancelledRef.current) { finishPartial(); return }
        const batch = ids.slice(i, i + BATCH_SIZE)
        const batchMsgs = await Promise.all(batch.map((id) => getMessageMetadata(token, id)))
        allMsgs.push(...batchMsgs)
        setEmails([...allMsgs])

        // ETA covers both loading phases (500 initial + 350 sample if capped).
        const elapsedSec = (Date.now() - startTime) / 1000
        if (elapsedSec > 0.3) {
          const rate = allMsgs.length / elapsedSec
          setEta(Math.ceil((metadataTotal - allMsgs.length) / rate))
        }

        if (i + BATCH_SIZE < ids.length) {
          await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
        }
      }

      const scannedBytes = allMsgs.reduce((sum, m) => sum + (m.sizeEstimate || 0), 0)

      if (capped) {
        // Phases 3+4: count every match, then sample for a size estimate.
        // All 500 rows are already on screen; the strip just changes label.
        setSearchRun({ stage: 'estimating' })
        setEta(null)
        const allIds = await getAllIds(token, query)
        if (searchCancelledRef.current) { finishPartial(); return }
        const total = allIds.length

        const step = Math.max(1, Math.floor(total / SAMPLE_SIZE))
        const sampleIds = []
        for (let i = 0; i < total && sampleIds.length < SAMPLE_SIZE; i += step) {
          sampleIds.push(allIds[i])
        }

        const sampleMsgs = []
        for (let i = 0; i < sampleIds.length; i += BATCH_SIZE) {
          if (searchCancelledRef.current) { finishPartial(); return }
          const batch = sampleIds.slice(i, i + BATCH_SIZE)
          const results = await Promise.all(batch.map((id) => getMessageMetadata(token, id)))
          sampleMsgs.push(...results)
          if (i + BATCH_SIZE < sampleIds.length) {
            await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
          }
        }

        const avgBytes = sampleMsgs.reduce((sum, m) => sum + (m.sizeEstimate || 0), 0) / sampleMsgs.length
        const estimatedTotal = Math.round(avgBytes * total)
        setTotalSize(estimatedTotal)
        setSizeIsEstimate(true)
        setMatchTotal(total)
        if (presetLabel) {
          presetCacheRef.current[presetLabel] = {
            emails: allMsgs, totalSize: estimatedTotal, sizeIsEstimate: true, matchTotal: total,
          }
        }
      } else {
        setTotalSize(scannedBytes)
        setSizeIsEstimate(false)
        setMatchTotal(ids.length)
        if (presetLabel) {
          presetCacheRef.current[presetLabel] = {
            emails: allMsgs, totalSize: scannedBytes, sizeIsEstimate: false, matchTotal: ids.length,
          }
        }
      }
    } catch (err) {
      handleGmailError(err)
      if (allMsgs.length > 0) finishPartial() // keep what already streamed in
      else setPhase('form')
    } finally {
      setLoading(false)
      setSearchRun(null)
      setEta(null)
    }
  }

  // "Edit" on the results screen — back to the form with the fields intact.
  // Also stops a still-running search so its loop doesn't keep mutating
  // state behind the form.
  function editFilters() {
    searchCancelledRef.current = true
    setPhase('form')
    setActivePreset(null)
    setSelected(new Set())
    setConfirm(null)
  }

  // --- Bulk actions on the selection ---

  // Trash or Archive everything currently selected — opens the confirmation
  // sheet first; runBulkAction below only fires from its confirm button.
  function requestAction(type) {
    const n = selected.size
    if (type === 'trash') {
      setConfirm({
        title: `Move ${n} email${n !== 1 ? 's' : ''} to Trash?`,
        body: 'They stay in Trash for 30 days before Gmail deletes them permanently. You can undo this right after.',
        cta: `Move ${n} to Trash`,
        danger: true,
        onConfirm: () => runBulkAction('trash'),
      })
    } else {
      setConfirm({
        title: `Archive ${n} email${n !== 1 ? 's' : ''}?`,
        body: 'They leave your inbox but stay searchable in All Mail. Archiving does not free storage.',
        cta: `Archive ${n}`,
        danger: false,
        onConfirm: () => runBulkAction('archive'),
      })
    }
  }

  // Removes selected rows immediately, then hands the slower Gmail calls to
  // App's serial background queue. The queue does not block this tab, so the
  // person can keep searching, selecting, scrolling, or switch tabs.
  function runBulkAction(type) {
    setConfirm(null)
    setStatus('')
    const ids = [...selected]
    if (ids.length === 0) return

    const idSet = new Set(ids)
    const removedMsgs = emails.filter((m) => idSet.has(m.id))
    const removedBytes = removedMsgs.reduce((sum, m) => sum + (m.sizeEstimate || 0), 0)
    const actionQuery = lastQueryRef.current

    // Optimistic UI: the rows and their summary totals change before the
    // first network request. Cached presets are invalidated so old rows
    // cannot pop back in when switching between presets.
    setEmails((prev) => prev.filter((m) => !idSet.has(m.id)))
    setSelected(new Set())
    setMatchTotal((prev) => (prev === null ? prev : Math.max(0, prev - removedMsgs.length)))
    setTotalSize((prev) => (prev === null ? prev : Math.max(0, prev - removedBytes)))
    presetCacheRef.current = {}

    // A row may be restored once because Gmail rejected it, then encountered
    // again if the person presses Undo. Track restored IDs so counts and sizes
    // never get added twice.
    const restoredIds = new Set()
    const restoreRows = (records) => {
      // Do not mix rows from an old query into a newer search the person
      // started while this background job was running.
      if (records.length === 0 || lastQueryRef.current !== actionQuery) return
      const freshRecords = records.filter((m) => !restoredIds.has(m.id))
      if (freshRecords.length === 0) return
      freshRecords.forEach((m) => restoredIds.add(m.id))
      const bytes = freshRecords.reduce((sum, m) => sum + (m.sizeEstimate || 0), 0)
      setEmails((prev) => {
        const existingIds = new Set(prev.map((m) => m.id))
        return [...freshRecords.filter((m) => !existingIds.has(m.id)), ...prev]
      })
      setMatchTotal((prev) => (prev === null ? prev : prev + freshRecords.length))
      setTotalSize((prev) => (prev === null ? prev : prev + bytes))
    }

    // Undo is offered immediately, before the first Gmail batch finishes.
    // If clicked, it cancels untouched batches and waits only for the current
    // in-flight batch so App can reverse the IDs that actually reached Gmail.
    const succeeded = []
    let undoRequested = false
    let resolveJob
    const jobDone = new Promise((resolve) => { resolveJob = resolve })

    const cancelJob = enqueueBackgroundAction({
      onCancel: () => {
        if (!undoRequested) restoreRows(removedMsgs)
        resolveJob([...succeeded])
      },
      run: async ({ isCancelled }) => {
        const succeededSet = new Set()
        let authFailed = false

        try {
          const token = await getToken(false)
          const apiFn = type === 'trash' ? trashMessage : archiveMessage

          for (let i = 0; i < ids.length; i += 10) {
            if (isCancelled()) break
            const batch = ids.slice(i, i + 10)
            const results = await Promise.allSettled(batch.map((id) => apiFn(token, id)))

            results.forEach((result, index) => {
              if (result.status === 'fulfilled') {
                const id = batch[index]
                succeeded.push(id)
                succeededSet.add(id)
              } else if (result.reason instanceof GmailAuthError) {
                authFailed = true
              }
            })

            if (authFailed || isCancelled()) break
            if (i + 10 < ids.length) await new Promise((resolve) => setTimeout(resolve, 300))
          }
        } catch (err) {
          if (err instanceof GmailAuthError) authFailed = true
          else if (!isCancelled()) setStatus(`Error processing emails: ${err.message}`)
        } finally {
          const failedMsgs = removedMsgs.filter((m) => !succeededSet.has(m.id))
          restoreRows(failedMsgs)

          if (authFailed) {
            onAuthError?.()
            setStatus('Your Gmail connection expired — the emails not processed were restored.')
          } else if (!isCancelled() && failedMsgs.length > 0) {
            setStatus(`${failedMsgs.length} email${failedMsgs.length !== 1 ? 's were' : ' was'} not processed and restored.`)
          }

          resolveJob([...succeeded])
        }
      },
    })

    onAction?.(
      type,
      ids,
      () => restoreRows(removedMsgs),
      {
        count: ids.length,
        prepareUndo: async () => {
          undoRequested = true
          cancelJob()
          return jobDone
        },
      }
    )
  }

  // --- Trash all matching ---

  // "Move all N to Trash…" in the summary card — N is the exact total from
  // the search that just ran (including matches beyond the 500 shown).
  function requestTrashAll() {
    const n = matchTotal || 0
    setConfirm({
      title: `Move all ${n.toLocaleString()} matching emails to Trash?`,
      body: 'Includes matches beyond the 500 shown here. It runs quietly while you keep browsing, with Undo available immediately. Trashed mail stays in Trash for 30 days.',
      cta: 'Move all to Trash',
      danger: true,
      onConfirm: runTrashAll,
    })
  }

  // Optimistically clears the result set, then keeps finding and trashing
  // matches in App's serial queue. It remains cancellable when the panel is
  // hidden, but intentionally has no progress UI so browsing stays quiet.
  function runTrashAll() {
    setConfirm(null)
    const query = lastQueryRef.current
    const total = matchTotal || 0
    const originalEmails = emails
    const originalTotalSize = totalSize
    setEmails([])
    setSelected(new Set())
    setMatchTotal(0)
    setTotalSize(0)
    setStatus('')
    presetCacheRef.current = {}

    const restoreAll = () => {
      if (lastQueryRef.current !== query) return
      setEmails(originalEmails)
      setMatchTotal(total)
      setTotalSize(originalTotalSize)
    }

    const restoreUnprocessed = (succeededIds = []) => {
      if (lastQueryRef.current !== query) return
      const succeededSet = new Set(succeededIds)
      const remainingRows = originalEmails.filter((m) => !succeededSet.has(m.id))
      const remaining = Math.max(0, total - succeededIds.length)
      setEmails(remainingRows)
      setMatchTotal(remaining)
      setTotalSize(originalTotalSize === null || total === 0
        ? originalTotalSize
        : Math.round(originalTotalSize * (remaining / total)))
    }

    const trashedIds = []
    const trashedSet = new Set()
    let undoRequested = false
    let resolveJob
    const jobDone = new Promise((resolve) => { resolveJob = resolve })

    const cancelJob = enqueueBackgroundAction({
      onCancel: () => {
        if (!undoRequested) restoreUnprocessed()
        resolveJob([...trashedIds])
      },
      run: async ({ isCancelled }) => {
        let authFailed = false
        let errorMessage = ''
        let completedNormally = false

        try {
          try {
            const token = await getToken(false)

            while (!isCancelled()) {
              const { ids } = await listAllMessageIds(token, query)
              if (ids.length === 0) {
                completedNormally = true
                break
              }

              let succeededThisPass = 0
              for (let i = 0; i < ids.length; i += 10) {
                if (isCancelled()) break
                const batch = ids.slice(i, i + 10)
                const results = await Promise.allSettled(batch.map((id) => trashMessage(token, id)))

                results.forEach((result, index) => {
                  if (result.status === 'fulfilled') {
                    const id = batch[index]
                    if (!trashedSet.has(id)) {
                      trashedSet.add(id)
                      trashedIds.push(id)
                      succeededThisPass++
                    }
                  } else if (result.reason instanceof GmailAuthError) {
                    authFailed = true
                  }
                })

                if (authFailed || isCancelled()) break
                if (i + 10 < ids.length) await new Promise((resolve) => setTimeout(resolve, 300))
              }

              // Avoid endlessly re-querying IDs Gmail repeatedly refused.
              if (authFailed || succeededThisPass === 0) break
            }
          } catch (err) {
            if (err instanceof GmailAuthError) authFailed = true
            else errorMessage = err.message
          }

          // Gmail's resultSizeEstimate can be a little high or low. Reaching an
          // empty result page is the reliable completion signal; comparing the
          // processed count with the estimate can incorrectly restore stale rows.
          const incomplete = !completedNormally
          if (incomplete && !undoRequested) restoreUnprocessed(trashedIds)

          if (authFailed) {
            onAuthError?.()
            setStatus('Your Gmail connection expired — unprocessed matches were restored.')
          } else if (errorMessage) {
            setStatus(`Some emails were not processed and were restored: ${errorMessage}`)
          } else if (!isCancelled() && !completedNormally) {
            setStatus('Some emails could not be moved to Trash and were restored.')
          }
        } finally {
          resolveJob([...trashedIds])
        }
      },
    })

    onAction?.(
      'trash',
      [],
      restoreAll,
      {
        count: total,
        prepareUndo: async () => {
          undoRequested = true
          cancelJob()
          return jobDone
        },
      }
    )
  }

  // --- Sender grouping ---

  // Groups emails by their From header and totals up count + size per sender.
  function getSenderSummaries() {
    const map = new Map()
    emails.forEach((msg) => {
      const from = msg.payload?.headers?.find((h) => h.name === 'From')?.value || '(unknown)'
      const entry = map.get(from) || { from, count: 0, totalBytes: 0, ids: [] }
      entry.count++
      entry.totalBytes += msg.sizeEstimate || 0
      entry.ids.push(msg.id)
      map.set(from, entry)
    })
    return [...map.values()].sort((a, b) => b.totalBytes - a.totalBytes)
  }

  function selectAllFromSender(ids) {
    setSelected((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.add(id))
      return next
    })
  }
  function deselectAllFromSender(ids) {
    setSelected((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.delete(id))
      return next
    })
  }

  // --- Sorting ---

  function getSortedEmails() {
    const getHeader = (msg, name) =>
      msg.payload?.headers?.find((h) => h.name === name)?.value || ''

    return [...emails].sort((a, b) => {
      switch (sortBy) {
        case 'newest':
          return new Date(getHeader(b, 'Date')) - new Date(getHeader(a, 'Date'))
        case 'oldest':
          return new Date(getHeader(a, 'Date')) - new Date(getHeader(b, 'Date'))
        case 'largest':
          return (b.sizeEstimate || 0) - (a.sizeEstimate || 0)
        case 'smallest':
          return (a.sizeEstimate || 0) - (b.sizeEstimate || 0)
        case 'sender':
          return getHeader(a, 'From').localeCompare(getHeader(b, 'From'))
        default:
          return 0
      }
    })
  }

  // --- UI ---

  const matchMb = totalSize !== null ? formatSize(totalSize) : null

  // Quick presets card — rendered in BOTH the form and the results view, so
  // the block never disappears and it's always clear which preset (if any)
  // is active. In results it gains a corner link that returns to the form:
  // "Remove" when a preset drove the results, "Edit filters" when a manual
  // filter search did. The preset buttons stay clickable in results too, so
  // switching between presets is one click.
  const presetsCard = (inResults) => (
    <div className="gc-card" style={{ padding: 12, marginBottom: inResults ? 12 : 14 }}>
      <div className="flex items-center" style={{ marginBottom: inResults ? 10 : 2 }}>
        <span style={{ fontWeight: 600, fontSize: 12 }}>Quick presets</span>
        {inResults && (
          <button onClick={editFilters} className="gc-link ml-auto" style={{ fontSize: 11 }}>
            {activePreset ? 'Remove' : 'Edit search'}
          </button>
        )}
      </div>
      {!inResults && (
        <div style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 10 }}>
          One-click searches ignore the filters below.
        </div>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() => runPreset(preset)}
            disabled={loading}
            title={preset.description}
            className="gc-preset"
            data-active={activePreset === preset.label}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    // Column layout: the scroll area takes whatever height the bulk bar
    // below doesn't — so when the bar appears, scrolling (and drag-select
    // auto-scroll, which keys off the scroll box's bottom edge) ends at the
    // bar's top instead of continuing on underneath it.
    <div className="h-full flex flex-col">
      <div className="relative flex-1 min-h-0">
        {/* the one scroll container for all phases */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto select-none"
          style={{ padding: '12px 14px 24px' }}
        >
        {/* ============ FORM PHASE ============ */}
        {phase === 'form' && (
          <div style={{ animation: phaseAnim || undefined }}>
            <p style={{ margin: '2px 2px 12px', fontSize: 12, color: 'var(--sub)' }}>
              Filter by size, age, or sender, then trash or archive the matches in bulk.
              Nothing is removed without confirmation.
            </p>

            {/* Quick presets — one-click searches with their own fixed queries */}
            {presetsCard(false)}

            {/* Divider makes clear the filters below are a separate way to search */}
            <div className="flex items-center gap-2.5" style={{ margin: '0 0 12px', color: 'var(--faint)', fontSize: 11 }}>
              <div className="flex-1" style={{ height: 1, background: 'var(--line)' }} />
              or filter manually
              <div className="flex-1" style={{ height: 1, background: 'var(--line)' }} />
            </div>

            <div className="grid gap-2.5">
              <FilterPanel
                filters={filters}
                onChange={handleFilterChange}
                onSubmit={() => handleFind(buildQuery(filters))}
                loading={loading}
                formId="search-filters-form"
              />

              {/* Search — submits the filter form above via the `form`
                  attribute, so pressing Enter in a field works too */}
              <PrimaryButton
                type="submit"
                form="search-filters-form"
                disabled={loading}
                className="w-full"
                style={{ marginTop: 2 }}
              >
                Search
              </PrimaryButton>

              {status && <p style={{ fontSize: 11, color: 'var(--sub)' }}>{status}</p>}
            </div>
          </div>
        )}

        {/* ============ RESULTS PHASE (streams in live while searching) ============ */}
        {phase === 'results' && (
          <div style={{ animation: phaseAnim || undefined }}>
            {/* Quick presets stay visible over the results — the active one
                highlighted, its corner link returning to the form. */}
            {presetsCard(true)}

            {/* While the search streams: slim sticky progress strip. Once it
                completes (or is stopped): the match summary card. */}
            {searchRun ? (
              <ProgressStrip
                title={searchRun.stage === 'estimating' ? 'Counting all matches…' : 'Searching your mail…'}
                detail={`${emails.length.toLocaleString()} found so far${eta !== null && eta > 0 ? ` · ~${eta}s left` : ''}`}
                onStop={() => { searchCancelledRef.current = true }}
              />
            ) : (
            <div className="gc-card" style={{ padding: 12, marginBottom: 12 }}>
              <div className="flex items-baseline gap-1.5">
                <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.01em' }}>
                  {(matchTotal ?? emails.length).toLocaleString()}
                </span>
                <span style={{ fontSize: 12, color: 'var(--sub)' }}>
                  {stoppedEarly ? 'matches so far' : 'matching emails'}
                </span>
                {matchMb !== null && (
                  <span className="ml-auto" style={{ fontWeight: 600, color: 'var(--accent)', fontSize: '12.5px' }}>
                    ~{matchMb}
                  </span>
                )}
              </div>
              {stoppedEarly && (
                <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                  Stopped early — showing what was found before you stopped. Search again for the full list.
                </div>
              )}
              {!stoppedEarly && sizeIsEstimate && (
                <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                  Showing the first 500 · sizes are estimates
                </div>
              )}

              {/* Trash-all — hidden after an early stop, since "all matching"
                  could cover more than what's on screen */}
              {!stoppedEarly && (matchTotal ?? 0) > 0 && (
                <button
                  onClick={requestTrashAll}
                  className="gc-btn gc-btn-danger w-full"
                  style={{ marginTop: 10, padding: 9, fontSize: 12 }}
                >
                  Move all {(matchTotal ?? 0).toLocaleString()} to Trash…
                </button>
              )}
            </div>
            )}

            {status && <p style={{ fontSize: 11, color: 'var(--sub)', margin: '0 2px 10px' }}>{status}</p>}

            {emails.length > 0 ? (
              <>
                {/* Top senders in results */}
                <div className="gc-section-label" style={{ margin: '0 2px 6px' }}>Top senders in results</div>
                <div className="gc-card overflow-hidden" style={{ marginBottom: 14, borderRadius: 'var(--radius)' }}>
                  {getSenderSummaries().slice(0, 3).map(({ from, count, totalBytes, ids }) => {
                    const allSelected = ids.every((id) => selected.has(id))
                    return (
                      <div key={from} className="flex items-center gap-2" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap" style={{ fontSize: '12.5px', fontWeight: 500 }} title={from}>
                          {parseSenderName(from)}
                        </span>
                        <span className="ml-auto shrink-0" style={{ fontSize: 11, color: 'var(--faint)' }}>
                          {count} · {formatSize(totalBytes)}
                        </span>
                        <button
                          onClick={() => (allSelected ? deselectAllFromSender(ids) : selectAllFromSender(ids))}
                          className="gc-btn-pill shrink-0"
                          style={{ background: 'var(--bg)' }}
                        >
                          {allSelected ? 'Deselect' : 'Select'}
                        </button>
                      </div>
                    )
                  })}
                </div>

                {/* RESULTS header + sort pill */}
                <div className="flex items-center gap-2" style={{ margin: '0 2px 8px' }}>
                  <span className="gc-section-label">Results</span>
                  <div className="ml-auto">
                    <Dropdown variant="pill" value={sortBy} options={SORT_OPTIONS} onChange={setSortBy} />
                  </div>
                </div>
                <div className="flex items-center gap-2.5" style={{ margin: '0 2px 8px', fontSize: '11.5px' }}>
                  <button onClick={selectAll} className="gc-link">Select all</button>
                  <button onClick={selectNone} className="gc-link">Deselect all</button>
                  <span style={{ color: 'var(--faint)' }}>· drag the rail for a range</span>
                </div>

                {/* Message rows — rail + card. The rail bead starts a drag-
                    select; clicking the card body toggles just that row. */}
                {getSortedEmails().map((msg) => {
                  const headers = msg.payload?.headers || []
                  const get = (name) => headers.find((h) => h.name === name)?.value || '(unknown)'
                  const isChecked = selected.has(msg.id)

                  return (
                    <div
                      key={msg.id}
                      data-msg-id={msg.id}
                      className="flex items-stretch gap-2 gc-row-in"
                      style={{ margin: '0 0 6px' }}
                      onMouseEnter={() => selectDragOver(msg.id)}
                    >
                      <Rail
                        selected={isChecked}
                        onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); startSelectDrag(msg.id, e) }}
                      />
                      <div
                        onClick={() => applySelection(msg.id, !isChecked, { preview: true })}
                        className="flex-1 min-w-0 cursor-pointer transition-all hover:-translate-y-[2px] hover:shadow-[0_6px_16px_rgba(40,35,25,.12)]"
                        style={{
                          padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                          border: `1px solid ${isChecked ? 'var(--accent)' : 'var(--line)'}`,
                          background: isChecked ? 'var(--sel)' : 'var(--card)',
                        }}
                      >
                        <div className="flex gap-2 items-baseline">
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap" style={{ fontWeight: 600, fontSize: '12.5px' }}>
                            {parseSenderName(get('From'))}
                          </span>
                          <span className="ml-auto shrink-0" style={{ fontSize: 11, color: 'var(--faint)' }}>
                            {formatSize(msg.sizeEstimate || 0)}
                          </span>
                          {/* Open this email in Gmail — posts to content.js */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              window.parent.postMessage({ type: 'OPEN_EMAIL', id: msg.id }, '*')
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            title="Open in Gmail"
                            className="shrink-0 grid place-items-center border-none bg-transparent cursor-pointer p-0"
                            style={{ color: 'var(--faint)' }}
                            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent)')}
                            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--faint)')}
                          >
                            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                              <path d="M4 2h6v6" /><path d="M10 2 3 9" />
                            </svg>
                          </button>
                        </div>
                        <div className="overflow-hidden text-ellipsis whitespace-nowrap" style={{ fontSize: 12, color: 'var(--sub)', marginTop: 1 }}>
                          {get('Subject')}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </>
            ) : (
              !searchRun && (
                <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--faint)', fontSize: 12 }}>
                  Nothing left matching these filters.<br /><br />Your mailbox is that much lighter.
                </div>
              )
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
              bottom: 16, right: 16, width: 32, height: 32, borderRadius: 999,
              border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)',
              boxShadow: 'var(--shadow-dd)',
            }}
          >
            ↑
          </button>
        )}
      </div>

      {/* Bulk-action bar — rises below the scroll area while emails are selected */}
      {phase === 'results' && selected.size > 0 && !confirm && (
        <BulkBar
          label={`${selected.size} selected · ~${formatSize(selectedBytes)}`}
          onClear={selectNone}
          hint={searchRun ? 'Finishing search… actions unlock when it completes.' : undefined}
        >
          <button
            onClick={() => requestAction('trash')}
            disabled={!!searchRun}
            className="gc-btn gc-btn-danger"
            style={{ flex: 1.2, padding: 9, fontSize: '12.5px' }}
          >
            Move to Trash…
          </button>
          <button
            onClick={() => requestAction('archive')}
            disabled={!!searchRun}
            className="gc-btn gc-btn-neutral flex-1"
            style={{ padding: 9, fontSize: '12.5px' }}
          >
            Archive…
          </button>
        </BulkBar>
      )}

      {/* Confirmation sheet — every destructive action passes through here */}
      <ConfirmSheet confirm={confirm} onCancel={() => setConfirm(null)} />
    </div>
  )
}
