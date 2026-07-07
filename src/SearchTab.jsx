// SearchTab.jsx — the "Search" tab: filter emails, preview results, select some,
// then Trash/Archive them (or Trash All Matching without previewing).
// This is the same logic that used to live directly in App.jsx, just moved into
// its own file so App.jsx only has to worry about which tab is showing.

import { useState, useRef, useEffect } from 'react'
import { getToken, GmailAuthError } from './auth.js'
import {
  listAllMessageIds, getAllIds, getMessageMetadata, trashMessage, archiveMessage,
} from './gmail.js'
import { formatSize, parseSenderName, dragScrollSpeed } from './utils.js'
import { PRESETS } from './presets.js'
import FilterPanel, { buildQuery, DEFAULT_FILTERS } from './FilterPanel.jsx'

// `onAuthError` is called whenever a Gmail action fails because the token has
// expired or been revoked — App.jsx uses it to show a "Reconnect Gmail"
// banner above both tabs. `onAction` reports a completed Trash/Archive so
// App.jsx can pop up a shared "Undo" toast at the bottom of the panel —
// the Undo control itself lives there, not in this tab.
export default function SearchTab({ onAuthError, onAction }) {
  // Filter field values now live here instead of inside FilterPanel, since
  // the Search/Trash All Matching buttons that act on them are rendered
  // separately (pinned near the top) rather than alongside the fields.
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  function handleFilterChange(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  const [emails, setEmails] = useState([])
  const [totalSize, setTotalSize] = useState(null)     // bytes — null until a search completes
  const [sizeIsEstimate, setSizeIsEstimate] = useState(false) // true when extrapolated from a sample
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [sortBy, setSortBy] = useState('largest') // default: biggest emails first

  // Label of the preset currently highlighted (e.g. "Shipping & receipts"), or
  // null when the results on screen came from the filters instead. Only used
  // to decide which preset button to highlight — doesn't affect the search itself.
  const [activePreset, setActivePreset] = useState(null)

  // `confirmAction` is null when no confirmation is pending, or an object
  // describing what the user is about to do, e.g. { type: 'trash' }.
  // When set, the UI swaps the action buttons for a confirmation prompt.
  const [confirmAction, setConfirmAction] = useState(null)

  // True while a trash/archive operation is in progress.
  const [acting, setActing] = useState(false)

  // Search progress bar state.
  // `searchPhase` drives which bar style is shown:
  //   'fetching-ids'     → animated pulse (we don't know the total yet)
  //   'loading-metadata' → filled bar based on loaded / total
  //   null               → bar hidden
  const [searchPhase, setSearchPhase] = useState(null)
  const [progress, setProgress] = useState({ loaded: 0, total: 0 })
  const [eta, setEta] = useState(null) // seconds remaining, null = unknown

  // Trash All state
  // `trashAllQuery` holds the query string while we wait for confirmation.
  const [trashAllQuery, setTrashAllQuery] = useState(null)
  const [trashAllEstimate, setTrashAllEstimate] = useState(null) // shown in confirmation dialog
  // `cancelledRef` is a flag the loop checks so Cancel stops it mid-run.
  // We use useRef (not useState) because it updates instantly without re-rendering.
  const cancelledRef = useRef(false)

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
  // label — e.g. presetCacheRef.current['Shipping & receipts'] = { emails, ... }.
  // A plain ref (not state) because updating it should never itself cause a
  // re-render; it's just storage that survives for as long as the panel stays
  // open. Re-clicking a preset that's already in here just redisplays the
  // saved results instead of hitting the Gmail API again.
  const presetCacheRef = useRef({})

  // rootRef spans the whole tab (header + results), used only to measure the
  // "1/3 of the panel" cap for the By sender box below — it isn't itself a
  // scroll container.
  const rootRef = useRef(null)

  // The line-by-line message list is its OWN dedicated, independently
  // scrolling box — separate from the header above it (Quick Presets,
  // filters, Search/Trash buttons, By sender). Keeping them separate is what
  // makes drag-auto-scroll behave the way it visually looks: dragging near
  // the top/bottom of the actual results box triggers it, rather than
  // needing to reach all the way up to the top of the whole panel (which is
  // what happened when everything shared one big scroll container).
  const listScrollRef = useRef(null)
  const [showBackToTop, setShowBackToTop] = useState(false)

  function handleScroll() {
    setShowBackToTop((listScrollRef.current?.scrollTop || 0) > 200)
  }

  function scrollToTop() {
    listScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Two height caps, both measured off the whole tab's own pixel height
  // (percentages can't express these — their parent doesn't have a fixed
  // height of its own to resolve a percentage against):
  //   - bySenderMaxHeight caps the By sender list, growing to fit its
  //     content up to 1/3 of the tab's height, then scrolling internally.
  //   - listMaxHeight caps the line-by-line email list the same way — it's
  //     a normal block in the page's flow (not pinned to fill the rest of
  //     the screen), so scrolling the page up/down scrolls it on and off
  //     screen just like the By sender box or any other content.
  const [bySenderMaxHeight, setBySenderMaxHeight] = useState(null)
  const [listMaxHeight, setListMaxHeight] = useState(null)

  useEffect(() => {
    function measure() {
      if (!rootRef.current) return
      const total = rootRef.current.clientHeight
      setBySenderMaxHeight(total / 3)
      setListMaxHeight(total * 0.9)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // --- Selection helpers ---

  // Tracks an in-progress drag-select: null when no drag is happening, or the
  // boolean state (checked/unchecked) being "painted" onto every row the
  // mouse passes over while the button is held down. A ref, not state, since
  // updating it should never itself cause a re-render — only the actual
  // selection changes (via setSelected below) should.
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

  // Runs every frame while a drag is active. Auto-scrolls the results list's
  // own scroll box when the cursor is near ITS top or bottom edge (not the
  // whole tab's), so a drag that starts on screen can still reach emails
  // further up or down the list without letting go, scrolling manually, and
  // starting over. After scrolling, re-checks whatever email is now under
  // the cursor — scrolling doesn't itself fire mouseenter, since the pointer
  // hasn't actually moved — so the selection keeps extending smoothly as new
  // rows scroll in underneath a stationary mouse.
  function selectDragScrollTick() {
    const container = listScrollRef.current
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

  // Starts a drag-select: the row the mouse went down on flips to the
  // opposite of its current state, and every other row the mouse then
  // passes over (while still held down) flips to that same target state —
  // so dragging over a mix of checked/unchecked rows always ends with all of
  // them matching whichever way the first one went, same as Finder/Gmail's
  // own drag-select over checkboxes.
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
  const selectedMB = (
    selectedEmails.reduce((sum, m) => sum + (m.sizeEstimate || 0), 0) /
    (1024 * 1024)
  ).toFixed(1)

  // --- Find emails ---

  // Called when a Quick Presets button is clicked. If we've already run this
  // exact preset earlier in the session, reuse the saved results instantly
  // instead of re-searching — otherwise, run it for the first time via handleFind.
  function runPreset(preset) {
    const cached = presetCacheRef.current[preset.label]
    if (cached) {
      setActivePreset(preset.label)
      setEmails(cached.emails)
      setTotalSize(cached.totalSize)
      setSizeIsEstimate(cached.sizeIsEstimate)
      setStatus(cached.status)
      setSelected(new Set())
      setConfirmAction(null)
      return
    }
    handleFind(preset.query, preset.label)
  }

  // Called by FilterPanel with the constructed query string, or by runPreset
  // (above) the first time a given preset is run. `presetLabel` is left
  // undefined for normal filter searches, which is what clears the preset
  // highlight below.
  async function handleFind(query, presetLabel = null) {
    setActivePreset(presetLabel)
    setLoading(true)
    setEmails([])
    setTotalSize(null)
    setSizeIsEstimate(false)
    setSelected(new Set())
    setConfirmAction(null)
    setEta(null)

    const BATCH_SIZE = 10
    const BATCH_DELAY_MS = 300
    const SAMPLE_SIZE = 350

    try {
      const token = await getToken(false)

      // Phase 1: fetch first 500 IDs — duration unknown, show pulse bar.
      setSearchPhase('fetching-ids')
      setStatus('Searching...')
      const { ids } = await listAllMessageIds(token, query)

      if (ids.length === 0) {
        const noneStatus = 'No emails found matching those filters.'
        setStatus(noneStatus)
        if (presetLabel) {
          presetCacheRef.current[presetLabel] = {
            emails: [], totalSize: null, sizeIsEstimate: false, status: noneStatus,
          }
        }
        return
      }

      const capped = ids.length === 500

      // If capped, the bar covers 500 initial + 350 sample = 850 total steps.
      // If not capped, it covers exactly however many emails were found.
      const metadataTotal = capped ? ids.length + SAMPLE_SIZE : ids.length

      setSearchPhase('loading-metadata')
      setProgress({ loaded: 0, total: metadataTotal })
      setStatus(capped
        ? '500+ emails found. Loading details...'
        : `${ids.length.toLocaleString()} emails found. Loading details...`
      )

      // Phase 2: load metadata for the first 500 — bar fills 0 → 500 (of 850 if capped).
      const allMsgs = []
      const startTime = Date.now()

      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE)
        const batchMsgs = await Promise.all(batch.map((id) => getMessageMetadata(token, id)))
        allMsgs.push(...batchMsgs)
        setProgress({ loaded: allMsgs.length, total: metadataTotal })

        // ETA uses metadataTotal so it stays accurate across both loading phases.
        const elapsedSec = (Date.now() - startTime) / 1000
        if (elapsedSec > 0.3) {
          const rate = allMsgs.length / elapsedSec
          const remaining = metadataTotal - allMsgs.length
          setEta(Math.ceil(remaining / rate))
        }

        if (i + BATCH_SIZE < ids.length) {
          await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
        }
      }

      setEmails(allMsgs)
      const scannedBytes = allMsgs.reduce((sum, m) => sum + (m.sizeEstimate || 0), 0)

      if (capped) {
        // Phase 3: count all IDs — bar holds at 500/850 while this runs.
        setEta(null)
        setStatus('Counting total matches...')
        const allIds = await getAllIds(token, query)
        const total = allIds.length

        // Phase 4: stratified sample — bar continues from 500 → 850.
        setStatus(`Showing first 500 of ${total.toLocaleString()} — sampling for size estimate...`)
        const step = Math.max(1, Math.floor(total / SAMPLE_SIZE))
        const sampleIds = []
        for (let i = 0; i < total && sampleIds.length < SAMPLE_SIZE; i += step) {
          sampleIds.push(allIds[i])
        }

        const sampleMsgs = []
        for (let i = 0; i < sampleIds.length; i += BATCH_SIZE) {
          const batch = sampleIds.slice(i, i + BATCH_SIZE)
          const results = await Promise.all(batch.map((id) => getMessageMetadata(token, id)))
          sampleMsgs.push(...results)
          setProgress({ loaded: ids.length + sampleMsgs.length, total: metadataTotal })
          if (i + BATCH_SIZE < sampleIds.length) {
            await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
          }
        }

        const avgBytes = sampleMsgs.reduce((sum, m) => sum + (m.sizeEstimate || 0), 0) / sampleMsgs.length
        const estimatedTotal = Math.round(avgBytes * total)
        const cappedStatus = `Showing first 500 of ${total.toLocaleString()} total. Use Trash All to delete all.`
        setTotalSize(estimatedTotal)
        setSizeIsEstimate(true)
        setStatus(cappedStatus)
        if (presetLabel) {
          presetCacheRef.current[presetLabel] = {
            emails: allMsgs, totalSize: estimatedTotal, sizeIsEstimate: true, status: cappedStatus,
          }
        }
      } else {
        const foundStatus = `${ids.length.toLocaleString()} emails found.`
        setTotalSize(scannedBytes)
        setSizeIsEstimate(false)
        setStatus(foundStatus)
        if (presetLabel) {
          presetCacheRef.current[presetLabel] = {
            emails: allMsgs, totalSize: scannedBytes, sizeIsEstimate: false, status: foundStatus,
          }
        }
      }

    } catch (err) {
      handleGmailError(err)
    } finally {
      setLoading(false)
      setSearchPhase(null)
      setEta(null)
    }
  }

  // --- Bulk actions ---

  // Called when the user clicks Trash or Archive.
  // Instead of acting immediately, we show a confirmation prompt.
  function requestAction(type) {
    setConfirmAction({ type })
  }

  // Called when the user clicks Confirm in the confirmation prompt.
  // Batches requests (10 at a time) to avoid rate limits, and updates
  // the list progressively as emails are successfully actioned.
  async function handleConfirm() {
    const type = confirmAction.type
    setConfirmAction(null)
    setActing(true)
    setStatus('')
    // Snapshot of the full email objects before any of them get filtered out
    // of `emails` below — Undo needs the whole objects (not just IDs) to put
    // rows back on screen exactly as they were.
    const emailsSnapshot = emails

    try {
      const token = await getToken(false)
      const ids = [...selected]
      const apiFn = type === 'trash' ? trashMessage : archiveMessage

      const BATCH_SIZE = 10
      const BATCH_DELAY_MS = 300
      const succeeded = []
      const failed = []

      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE)
        const results = await Promise.allSettled(
          batch.map((id) => apiFn(token, id))
        )

        batch.forEach((id, j) => {
          if (results[j].status === 'fulfilled') {
            succeeded.push(id)
          } else {
            failed.push(id)
          }
        })

        // Remove succeeded emails from the list as we go
        const succeededSet = new Set(succeeded)
        setEmails((prev) => prev.filter((m) => !succeededSet.has(m.id)))

        // Keep only failed emails selected so the user can retry them
        setSelected(new Set(failed))

        if (i + BATCH_SIZE < ids.length) {
          setStatus(`Processing ${Math.min(i + BATCH_SIZE, ids.length)} / ${ids.length}...`)
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS))
        }
      }

      const verb = type === 'trash' ? 'moved to Trash' : 'archived'
      if (failed.length === 0) {
        setStatus(`Done — ${succeeded.length} email${succeeded.length !== 1 ? 's' : ''} ${verb}.`)
      } else {
        setStatus(`${succeeded.length} ${verb}, ${failed.length} failed — they're still selected, try again.`)
      }

      // Restore function passed up to App.jsx's Undo toast — run only after
      // it's confirmed the Gmail-side untrash/restore actually succeeded.
      // Puts the removed rows back at the top of the list rather than
      // re-searching, so Undo feels instant.
      const succeededSet = new Set(succeeded)
      const removedMsgs = emailsSnapshot.filter((m) => succeededSet.has(m.id))
      onAction?.(type, succeeded, () => {
        setEmails((prev) => {
          const existingIds = new Set(prev.map((m) => m.id))
          const toAdd = removedMsgs.filter((m) => !existingIds.has(m.id))
          return [...toAdd, ...prev]
        })
      })
    } catch (err) {
      handleGmailError(err)
    } finally {
      setActing(false)
    }
  }

  // --- Trash All Matching ---

  // Step 1: user clicks "Trash All Matching" — count exact matches, then show confirmation.
  // Uses getAllIds (exact count) instead of estimateMessageCount (unreliable ~501 cap).
  // Sets loading=true so the button is disabled and the user gets clear feedback.
  async function handleTrashAllRequest(query) {
    setActivePreset(null)
    setLoading(true)
    setStatus('Counting matching emails...')
    try {
      const token = await getToken(false)
      const allIds = await getAllIds(token, query, (count) => {
        // Update status after each page of IDs so the user can see progress.
        setStatus(`Counting... ${count.toLocaleString()} emails found so far`)
      })
      setTrashAllEstimate(allIds.length)
      setTrashAllQuery(query)
      setStatus('')
    } catch (err) {
      handleGmailError(err, 'Error counting emails: ')
    } finally {
      setLoading(false)
    }
  }

  // Step 2: user cancels — dismiss the confirmation.
  function handleTrashAllCancel() {
    setTrashAllQuery(null)
  }

  // Step 3: user confirms — run the loop until no emails remain.
  async function handleTrashAllConfirm() {
    const query = trashAllQuery
    setTrashAllQuery(null)
    setActing(true)
    setEmails([])
    setSelected(new Set())
    setTotalSize(null)
    cancelledRef.current = false

    let totalTrashed = 0
    const trashedIds = [] // tracked so the whole run can be undone afterward

    try {
      const token = await getToken(false)

      // We already counted exact matches in handleTrashAllRequest — reuse that number.
      const total = trashAllEstimate || 0

      // Keep searching and trashing until nothing matches (or user cancels).
      while (!cancelledRef.current) {
        setStatus(`Searching for more... (${totalTrashed} / ${total.toLocaleString()} trashed so far)`)

        const { ids } = await listAllMessageIds(token, query)

        if (ids.length === 0) {
          break // nothing left matching the filters — we're done
        }

        // Trash in batches of 10 with short pauses to avoid rate limits.
        for (let i = 0; i < ids.length; i += 10) {
          if (cancelledRef.current) break

          const batch = ids.slice(i, i + 10)
          const results = await Promise.allSettled(batch.map((id) => trashMessage(token, id)))
          batch.forEach((id, j) => { if (results[j].status === 'fulfilled') trashedIds.push(id) })
          totalTrashed += batch.length
          setStatus(`Trashing... ${totalTrashed.toLocaleString()} / ${total.toLocaleString()} moved to Trash`)

          if (i + 10 < ids.length) {
            await new Promise((r) => setTimeout(r, 300))
          }
        }
      }

      setStatus(
        cancelledRef.current
          ? `Stopped — ${totalTrashed} emails moved to Trash.`
          : `Done — ${totalTrashed} emails moved to Trash.`
      )
      onAction?.('trash', trashedIds)
    } catch (err) {
      onAction?.('trash', trashedIds) // whatever succeeded before the error is still undoable
      if (err instanceof GmailAuthError) {
        onAuthError?.()
        setStatus(`Your Gmail connection expired after trashing ${totalTrashed} — click "Reconnect Gmail" above to continue.`)
      } else {
        setStatus(`Error after trashing ${totalTrashed}: ${err.message}`)
      }
    } finally {
      setActing(false)
    }
  }

  // --- Sender grouping ---

  // Groups emails by their From header and totals up count + size per sender.
  // Also collects each sender's message IDs for selection/deselection.
  // Returns an array sorted by total size descending (biggest senders first).
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

  // Adds all emails from a given sender to the current selection.
  function selectAllFromSender(ids) {
    setSelected((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.add(id))
      return next
    })
  }

  // Removes all emails from a given sender from the current selection.
  function deselectAllFromSender(ids) {
    setSelected((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.delete(id))
      return next
    })
  }

  // --- Sorting ---

  // Returns a sorted copy of emails without mutating the original array.
  // Date headers from Gmail look like "Mon, 15 Jun 2026 10:30:00 +0000".
  // new Date() can parse these directly.
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

  return (
    // The whole tab is ONE normal scrolling page (not split into fixed
    // regions) — Quick Presets, filters, the By sender box, and the
    // line-by-line list are all just content in this one scroll container,
    // the same way a webpage scrolls. That means the email list "comes and
    // goes" on screen exactly like the By sender box already does: scroll
    // down to reveal it, scroll up and it scrolls back out of view — it's
    // never pinned open. Only the Search/Trash buttons + By sender block are
    // sticky (pinned to the top of this scroll box while everything else
    // scrolls past underneath them).
    <div ref={rootRef} className="h-full overflow-y-auto">
      {/* Quick Presets — one-click common cleanup searches. Boxed with its own
          background so it reads as a separate, independent thing from the filters
          below: a preset always searches by its own fixed query, and ignores
          whatever is selected in the filter dropdowns underneath. Each button
          runs its query through the same handleFind used for manual searches,
          so results/select/trash/archive all work the same way either way. */}
      <div className="mb-3 bg-slate-50 border border-slate-200 rounded p-2">
        <p className="text-xs font-semibold text-gray-600 mb-0.5">Quick presets</p>
        <p className="text-xs text-gray-400 mb-2">
          Independent searches — these ignore the filters below.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => {
            const isActive = activePreset === preset.label
            return (
              <button
                key={preset.label}
                onClick={() => runPreset(preset)}
                disabled={loading || acting}
                title={preset.description}
                className={`px-2 py-1 text-xs rounded-full border ${
                  isActive
                    ? 'bg-blue-600 border-blue-600 text-white font-medium'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100 disabled:opacity-50'
                }`}
              >
                {preset.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Divider makes clear the filters below are a separate way to search */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 border-t border-gray-200" />
        <span className="text-xs text-gray-300">or search with filters</span>
        <div className="flex-1 border-t border-gray-200" />
      </div>

      <FilterPanel
        filters={filters}
        onChange={handleFilterChange}
        onSubmit={() => handleFind(buildQuery(filters))}
        loading={loading || acting}
        formId="search-filters-form"
      />

      {/* Search/Trash All Matching buttons + By sender breakdown. Sticky to
          the top of the whole tab's scroll box — as Quick Presets/filters
          scroll away above, this block stays pinned in place instead of
          scrolling with them. z-10 keeps it painting above the email list
          rows once those scroll up underneath it. The Search button submits
          the filter fields above via the `form` attribute (they're no longer
          physically nested together), so pressing Enter in a field still
          works the same as clicking it. */}
      <div className="sticky top-0 z-10 bg-white pt-1 pb-2">
        <div className="flex gap-2">
          <button
            type="submit"
            form="search-filters-form"
            disabled={loading || acting}
            className="flex-1 px-3 py-2 bg-gray-800 text-white rounded hover:bg-gray-900 text-sm disabled:opacity-50"
          >
            {loading ? 'Searching...' : 'Search'}
          </button>
          <button
            type="button"
            disabled={loading || acting}
            onClick={() => handleTrashAllRequest(buildQuery(filters))}
            className="flex-1 px-3 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm disabled:opacity-50"
          >
            Trash All Matching
          </button>
        </div>

        {status && <p className="mt-2 text-sm text-gray-600">{status}</p>}

        {/* Search progress bar — only visible while a search is running */}
        {searchPhase && (
          <div className="mt-2">
            {searchPhase === 'loading-metadata' && eta !== null && eta > 0 && (
              <div className="flex justify-end text-xs text-gray-400 mb-1">
                <span>~{eta}s left</span>
              </div>
            )}
            <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
              {searchPhase === 'fetching-ids' ? (
                // Indeterminate: pulse the whole bar while we don't know the total
                <div className="bg-blue-400 h-1.5 w-full animate-pulse rounded-full" />
              ) : (
                // Determinate: fill grows as metadata loads
                <div
                  className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round((progress.loaded / progress.total) * 100)}%` }}
                />
              )}
            </div>
          </div>
        )}

        {/* Trash All confirmation — shown after clicking "Trash All Matching" */}
        {trashAllQuery && (
          <div className="mt-3 bg-red-50 border border-red-200 rounded p-3 text-xs">
            <p className="text-gray-800 mb-2 font-medium">
              Move ALL emails matching these filters to Trash?
            </p>
            {trashAllEstimate !== null && (
              <p className="text-gray-600 mb-1">
                ~{trashAllEstimate.toLocaleString()} emails found
              </p>
            )}
            <p className="text-gray-500 mb-3">
              This will keep running until no matching emails remain. You can cancel mid-way.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleTrashAllConfirm}
                className="px-3 py-1.5 bg-red-600 text-white rounded hover:bg-red-700"
              >
                Yes, Trash All
              </button>
              <button
                onClick={handleTrashAllCancel}
                className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Cancel button while the Trash All loop is running */}
        {acting && (
          <button
            onClick={() => { cancelledRef.current = true }}
            className="mt-2 px-3 py-1.5 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-xs"
          >
            Stop
          </button>
        )}

        {totalSize !== null && (
          <p className="mt-2 text-sm font-semibold text-blue-600">
            Could free ~{formatSize(totalSize)}
            {sizeIsEstimate && (
              <span className="text-xs font-normal text-gray-400 ml-1">(across all matching emails)</span>
            )}
          </p>
        )}

        {/* By sender — grows to fit its content, capped at 1/3 of the panel's
            own height; past that it scrolls internally instead of pushing
            the pinned block any taller. */}
        {emails.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-semibold text-gray-500 mb-1">By sender</p>
            <ul
              className="space-y-1 overflow-y-auto"
              style={{ maxHeight: bySenderMaxHeight ? `${bySenderMaxHeight}px` : undefined }}
            >
              {getSenderSummaries().map(({ from, count, totalBytes, ids }) => {
                // A sender is "fully selected" when every one of their emails is checked.
                const allSelected = ids.every((id) => selected.has(id))
                return (
                  <li key={from} className="flex items-center gap-2 text-xs">
                    <span className="flex-1 truncate text-gray-700" title={from}>
                      {parseSenderName(from)}
                    </span>
                    <span className="text-gray-400 shrink-0">
                      {count} · {formatSize(totalBytes)}
                    </span>
                    {allSelected ? (
                      <button
                        onClick={() => deselectAllFromSender(ids)}
                        className="px-2 py-0.5 rounded text-white bg-gray-800 hover:bg-black shrink-0"
                      >
                        Deselect
                      </button>
                    ) : (
                      <button
                        onClick={() => selectAllFromSender(ids)}
                        className="text-blue-600 hover:underline shrink-0"
                      >
                        Select
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>

      {/* Results — normal content in the page's flow, same as the By sender
          box above it: it appears once there's data, sized to fit (capped,
          scrolling internally past that), and scrolls on and off screen
          along with everything else as the page scrolls. Nothing here is
          pinned open. */}
      {emails.length > 0 && (
        <div className="mt-2">
          {/* Select All / Deselect All — acts on the individual message
              checkboxes below, so it lives with that list rather than the
              By sender box above. */}
          <div className="flex gap-2 mb-1">
            <button onClick={selectAll} className="text-xs text-blue-600 hover:underline">
              Select all
            </button>
            <span className="text-xs text-gray-300">|</span>
            <button onClick={selectNone} className="text-xs text-blue-600 hover:underline">
              Deselect all
            </button>
          </div>

          {/* Selection summary */}
          {selected.size > 0 && (
            <p className="shrink-0 text-xs text-gray-500 mb-2">
              {selected.size} selected — ~{selectedMB} MB
            </p>
          )}

          {/* Action buttons — only shown when something is selected */}
          {selected.size > 0 && (
            <div className="shrink-0 mb-3">
              {confirmAction ? (
                // Confirmation prompt — replaces the buttons until resolved
                <div className="bg-yellow-50 border border-yellow-200 rounded p-2 text-xs">
                  <p className="mb-2 text-gray-800">
                    {confirmAction.type === 'trash'
                      ? `Move ${selected.size} email${selected.size !== 1 ? 's' : ''} (~${selectedMB} MB) to Trash?`
                      : `Archive ${selected.size} email${selected.size !== 1 ? 's' : ''} (~${selectedMB} MB)?`}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleConfirm}
                      className="px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmAction(null)}
                      className="px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                // Normal action buttons
                <div className="flex gap-2">
                  <button
                    onClick={() => requestAction('trash')}
                    disabled={acting}
                    className="px-3 py-1.5 bg-red-600 text-white rounded hover:bg-red-700 text-xs disabled:opacity-50"
                  >
                    {acting ? 'Working...' : 'Move to Trash'}
                  </button>
                  <button
                    onClick={() => requestAction('archive')}
                    disabled={acting}
                    className="px-3 py-1.5 bg-gray-600 text-white rounded hover:bg-gray-700 text-xs disabled:opacity-50"
                  >
                    {acting ? 'Working...' : 'Archive'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Sort control */}
          <div className="shrink-0 flex items-center gap-2 mb-2">
            <label className="text-xs text-gray-500 shrink-0">Sort by</label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="text-xs border border-gray-300 rounded px-1.5 py-1"
            >
              <option value="largest">Largest first</option>
              <option value="smallest">Smallest first</option>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="sender">Sender (A–Z)</option>
            </select>
          </div>

          {/* Email list — grows to fit its content up to listMaxHeight (same
              pattern as the By sender box above), then scrolls internally in
              its own dedicated box (listScrollRef), separate from the rest
              of the page. Click-and-drag anywhere on a row to select a range
              at once (same idea as dragging over checkboxes in Gmail or
              Finder): the row the drag starts on flips state, and every row
              the mouse passes over while still held down flips to match. A
              plain click (no drag) still just toggles that one row.
              Dragging near the top or bottom edge of THIS box auto-scrolls
              it, speeding up the closer you get to the edge — same as the
              Senders tab's list. Wrapped in its own `relative` div so the
              back-to-top button floats over just this box. */}
          <div className="relative">
          <div
            ref={listScrollRef}
            onScroll={handleScroll}
            className="overflow-y-auto pr-1"
            style={{ maxHeight: listMaxHeight ? `${listMaxHeight}px` : undefined }}
          >
          <ul className="text-xs space-y-2 select-none">
            {getSortedEmails().map((msg) => {
              const headers = msg.payload?.headers || []
              const get = (name) =>
                headers.find((h) => h.name === name)?.value || '(unknown)'
              const sizeFormatted = formatSize(msg.sizeEstimate || 0)
              const isChecked = selected.has(msg.id)

              return (
                <li
                  key={msg.id}
                  data-msg-id={msg.id}
                  className={`flex items-start gap-2 p-1 rounded cursor-pointer ${
                    isChecked ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                  onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); startSelectDrag(msg.id, e) }}
                  onMouseEnter={() => selectDragOver(msg.id)}
                >
                  {/* Drag-select rail — a bead on a vertical track rather than
                      a plain checkbox, so the column itself reads as one
                      continuous rail you can slide a selection up and down,
                      the same way a vertical slider works. Purely visual here
                      (no handlers of its own) — the whole row already carries
                      the drag behavior above, this just shows its state. */}
                  <div className="relative shrink-0 w-4 self-stretch flex flex-col items-center justify-center">
                    <div className="absolute top-0 bottom-0 w-0.5 rounded-full bg-gray-200" />
                    {/* No z-index here — the bead only needs to sit above the
                        rail line right behind it, which normal paint order
                        already handles. */}
                    <div
                      className={`relative w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-colors ${
                        isChecked ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300'
                      }`}
                    />
                  </div>
                  <span className="text-gray-700 leading-tight flex-1">
                    <span className="font-medium">{get('From')}</span>
                    <br />
                    {get('Subject')} — {sizeFormatted}
                  </span>
                  {/* Open this email in Gmail — posts to content.js which updates the URL hash */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      window.parent.postMessage({ type: 'OPEN_EMAIL', id: msg.id }, '*')
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="shrink-0 text-gray-300 hover:text-blue-500 ml-1 text-base leading-none"
                    title="Open in Gmail"
                  >
                    ↗
                  </button>
                </li>
              )
            })}
          </ul>
          </div>

          {/* Back to top — scrolls just the email list box above back to the
              top. Sits within the `relative` wrapper around just the list
              box, so it stays anchored to that box's own corner rather than
              the whole results section or tab. */}
          {showBackToTop && (
            <button
              onClick={scrollToTop}
              title="Back to top"
              className="absolute bottom-4 right-4 w-8 h-8 flex items-center justify-center rounded-full bg-gray-800 text-white shadow-md hover:bg-black z-20"
            >
              ↑
            </button>
          )}
          </div>
        </div>
      )}
    </div>
  )
}
