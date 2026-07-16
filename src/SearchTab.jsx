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

import { useState, useRef } from 'react'
import { getToken, GmailAuthError } from './auth.js'
import {
  listAllMessageIds, getAllIds, getMessageMetadata, trashMessage, archiveMessage,
} from './gmail.js'
import { formatSize, parseSenderName, dragScrollSpeed } from './utils.js'
import { PRESETS } from './presets.js'
import FilterPanel, { buildQuery, DEFAULT_FILTERS, summarizeFilters } from './FilterPanel.jsx'
import { Dropdown, ConfirmSheet, BusyCard, Rail, BulkBar } from './ui.jsx'

const SORT_OPTIONS = [
  { value: 'largest',  label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
  { value: 'newest',   label: 'Newest first' },
  { value: 'oldest',   label: 'Oldest first' },
  { value: 'sender',   label: 'By sender' },
]

// `onAuthError` is called whenever a Gmail action fails because the token has
// expired or been revoked — App.jsx uses it to show a "Reconnect Gmail"
// banner above both tabs. `onAction` reports a completed Trash/Archive so
// App.jsx can pop up a shared "Undo" toast at the bottom of the panel —
// the Undo control itself lives there, not in this tab.
export default function SearchTab({ onAuthError, onAction }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  function handleFilterChange(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  // Which of the three screens is showing (see the top-of-file comment).
  const [phase, setPhase] = useState('form')

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

  // True while a trash/archive operation is in progress.
  const [acting, setActing] = useState(false)

  // Search progress state for the busy card.
  //   'fetching-ids'     → indeterminate sweep (we don't know the total yet)
  //   'loading-metadata' → filled bar based on loaded / total
  const [searchPhase, setSearchPhase] = useState(null)
  const [progress, setProgress] = useState({ loaded: 0, total: 0 })
  const [eta, setEta] = useState(null) // seconds remaining, null = unknown

  // Trash-all run state: null, or { done, total } while the loop is running —
  // drives the red progress bar + Stop button in the summary card.
  const [taRun, setTaRun] = useState(null)
  // `cancelledRef` is a flag the loop checks so Stop halts it mid-run.
  // A ref (not state) because it updates instantly without re-rendering.
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

  // Human summary of what was (or is being) searched — the chip over the
  // results and the caption on the busy card.
  const filterSummary = activePreset ? `Preset: ${activePreset}` : summarizeFilters(filters)

  // --- Find emails ---

  // Called when a Quick Presets button is clicked. If we've already run this
  // exact preset earlier in the session, reuse the saved results instantly.
  function runPreset(preset) {
    const cached = presetCacheRef.current[preset.label]
    if (cached) {
      setActivePreset(preset.label)
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
  // runPreset the first time a given preset is run.
  async function handleFind(query, presetLabel = null) {
    setActivePreset(presetLabel)
    setLoading(true)
    setPhase('busy')
    setEmails([])
    setTotalSize(null)
    setSizeIsEstimate(false)
    setMatchTotal(null)
    setSelected(new Set())
    setConfirm(null)
    setEta(null)
    setStatus('')
    lastQueryRef.current = query

    const BATCH_SIZE = 10
    const BATCH_DELAY_MS = 300
    const SAMPLE_SIZE = 350

    try {
      const token = await getToken(false)

      // Phase 1: fetch first 500 IDs — duration unknown, indeterminate bar.
      setSearchPhase('fetching-ids')
      const { ids } = await listAllMessageIds(token, query)

      if (ids.length === 0) {
        setMatchTotal(0)
        setTotalSize(0)
        if (presetLabel) {
          presetCacheRef.current[presetLabel] = {
            emails: [], totalSize: 0, sizeIsEstimate: false, matchTotal: 0,
          }
        }
        setPhase('results')
        return
      }

      const capped = ids.length === 500

      // If capped, the bar covers 500 initial + 350 sample = 850 total steps.
      const metadataTotal = capped ? ids.length + SAMPLE_SIZE : ids.length

      setSearchPhase('loading-metadata')
      setProgress({ loaded: 0, total: metadataTotal })

      // Phase 2: load metadata for the first 500.
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
        const allIds = await getAllIds(token, query)
        const total = allIds.length

        // Phase 4: stratified sample — bar continues from 500 → 850.
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

      setPhase('results')
    } catch (err) {
      handleGmailError(err)
      setPhase('form')
    } finally {
      setLoading(false)
      setSearchPhase(null)
      setEta(null)
    }
  }

  // "Edit" on the results screen — back to the form with the fields intact.
  function editFilters() {
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

  // Batches requests (10 at a time) to avoid rate limits, and updates
  // the list progressively as emails are successfully actioned.
  async function runBulkAction(type) {
    setConfirm(null)
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

      const succeededSet = new Set(succeeded)
      const removedMsgs = emailsSnapshot.filter((m) => succeededSet.has(m.id))
      const removedBytes = removedMsgs.reduce((sum, m) => sum + (m.sizeEstimate || 0), 0)

      // Keep the summary card's numbers in step with what just left the list.
      setMatchTotal((prev) => (prev === null ? prev : Math.max(0, prev - succeeded.length)))
      setTotalSize((prev) => (prev === null ? prev : Math.max(0, prev - removedBytes)))

      if (failed.length === 0) {
        setStatus('')
      } else {
        const verb = type === 'trash' ? 'moved to Trash' : 'archived'
        setStatus(`${succeeded.length} ${verb}, ${failed.length} failed — they're still selected, try again.`)
      }

      // Restore function passed up to App.jsx's Undo toast — run only after
      // it's confirmed the Gmail-side untrash/restore actually succeeded.
      // Puts the removed rows back at the top of the list (and back into the
      // summary numbers) rather than re-searching, so Undo feels instant.
      onAction?.(type, succeeded, () => {
        setEmails((prev) => {
          const existingIds = new Set(prev.map((m) => m.id))
          const toAdd = removedMsgs.filter((m) => !existingIds.has(m.id))
          return [...toAdd, ...prev]
        })
        // Counts are adjusted out here, NOT inside the setEmails updater
        // above — React calls updater functions twice in dev to catch
        // impure ones, so a nested setState there double-counts.
        setMatchTotal((t) => (t === null ? t : t + removedMsgs.length))
        setTotalSize((s) => (s === null ? s : s + removedBytes))
      })
    } catch (err) {
      handleGmailError(err)
    } finally {
      setActing(false)
    }
  }

  // --- Trash all matching ---

  // "Move all N to Trash…" in the summary card — N is the exact total from
  // the search that just ran (including matches beyond the 500 shown).
  function requestTrashAll() {
    const n = matchTotal || 0
    setConfirm({
      title: `Move all ${n.toLocaleString()} matching emails to Trash?`,
      body: 'Includes matches beyond the 500 shown here. This keeps running until nothing matches — you can stop it mid-way, and undo it right after. Trashed mail stays in Trash for 30 days.',
      cta: 'Move all to Trash',
      danger: true,
      onConfirm: runTrashAll,
    })
  }

  // The confirmed loop: keeps searching and trashing until nothing matches
  // (or Stop is clicked), with live progress in the summary card.
  async function runTrashAll() {
    setConfirm(null)
    const query = lastQueryRef.current
    const total = matchTotal || 0
    setActing(true)
    setEmails([])
    setSelected(new Set())
    cancelledRef.current = false
    setTaRun({ done: 0, total })

    let totalTrashed = 0
    const trashedIds = [] // tracked so the whole run can be undone afterward

    try {
      const token = await getToken(false)

      while (!cancelledRef.current) {
        const { ids } = await listAllMessageIds(token, query)
        if (ids.length === 0) break // nothing left matching the filters — done

        // Trash in batches of 10 with short pauses to avoid rate limits.
        for (let i = 0; i < ids.length; i += 10) {
          if (cancelledRef.current) break

          const batch = ids.slice(i, i + 10)
          const results = await Promise.allSettled(batch.map((id) => trashMessage(token, id)))
          batch.forEach((id, j) => { if (results[j].status === 'fulfilled') trashedIds.push(id) })
          totalTrashed += batch.length
          setTaRun({ done: Math.min(totalTrashed, total || totalTrashed), total: Math.max(total, totalTrashed) })

          if (i + 10 < ids.length) {
            await new Promise((r) => setTimeout(r, 300))
          }
        }
      }

      setMatchTotal(cancelledRef.current ? Math.max(0, total - totalTrashed) : 0)
      setTotalSize((prev) => (cancelledRef.current && prev !== null && total > 0
        ? Math.round(prev * (1 - totalTrashed / total))
        : 0))
      setStatus(cancelledRef.current ? `Stopped — ${totalTrashed.toLocaleString()} emails moved to Trash.` : '')
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
      setTaRun(null)
    }
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

  return (
    <div className="h-full relative">
      {/* the one scroll container — bottom padding leaves room for the
          floating bulk bar so it never hides the last rows */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto select-none"
        style={{ padding: '12px 14px 96px' }}
      >
        {/* ============ FORM PHASE ============ */}
        {phase === 'form' && (
          <div style={{ animation: 'gcInL .22s ease' }}>
            <p style={{ margin: '2px 2px 12px', fontSize: 12, color: 'var(--sub)' }}>
              Filter by size, age, or sender, then trash or archive the matches in bulk.
              Nothing is removed without confirmation.
            </p>

            {/* Quick presets — one-click searches with their own fixed queries */}
            <div className="gc-card" style={{ padding: 12, marginBottom: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 2 }}>Quick presets</div>
              <div style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 10 }}>
                One-click searches ignore the filters below.
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    onClick={() => runPreset(preset)}
                    disabled={loading || acting}
                    title={preset.description}
                    className="gc-preset"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

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
                loading={loading || acting}
                formId="search-filters-form"
              />

              {/* Search — submits the filter form above via the `form`
                  attribute, so pressing Enter in a field works too */}
              <button
                type="submit"
                form="search-filters-form"
                disabled={loading || acting}
                className="gc-btn gc-btn-primary w-full"
                style={{ marginTop: 2 }}
              >
                <span>Search</span>
              </button>
              <div style={{ fontSize: 11, color: 'var(--faint)', textAlign: 'center' }}>
                Searching changes nothing — you choose what to remove.
              </div>

              {status && <p style={{ fontSize: 11, color: 'var(--sub)' }}>{status}</p>}
            </div>
          </div>
        )}

        {/* ============ BUSY PHASE ============ */}
        {phase === 'busy' && (
          <div style={{ animation: 'gcInL .22s ease' }}>
            <BusyCard
              title="Searching your mail…"
              caption={filterSummary}
              progress={searchPhase === 'loading-metadata' ? progress : null}
              extra={eta !== null && eta > 0 && (
                <div style={{ fontSize: 11, color: 'var(--faint)', textAlign: 'right', marginTop: 6 }}>
                  ~{eta}s left
                </div>
              )}
            />
          </div>
        )}

        {/* ============ RESULTS PHASE ============ */}
        {phase === 'results' && (
          <div style={{ animation: 'gcInL .22s ease' }}>
            {/* what was searched + a way back to the form */}
            <div className="flex items-center gap-1.5 flex-wrap" style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: 'var(--sub)', background: 'var(--chip)', borderRadius: 999, padding: '4px 10px' }}>
                {filterSummary}
              </span>
              <button onClick={editFilters} className="gc-link" style={{ padding: '4px 2px' }}>Edit</button>
            </div>

            {/* Match summary card */}
            <div className="gc-card" style={{ padding: 12, marginBottom: 12 }}>
              <div className="flex items-baseline gap-1.5">
                <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.01em' }}>
                  {(matchTotal ?? emails.length).toLocaleString()}
                </span>
                <span style={{ fontSize: 12, color: 'var(--sub)' }}>matching emails</span>
                {matchMb !== null && (
                  <span className="ml-auto" style={{ fontWeight: 600, color: 'var(--accent)', fontSize: '12.5px' }}>
                    ~{matchMb}
                  </span>
                )}
              </div>
              {sizeIsEstimate && (
                <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                  Showing the first 500 · sizes are estimates
                </div>
              )}

              {/* Trash-all — or its live progress while the loop runs */}
              {(matchTotal ?? 0) > 0 && !taRun && (
                <button
                  onClick={requestTrashAll}
                  disabled={acting}
                  className="gc-btn gc-btn-danger w-full"
                  style={{ marginTop: 10, padding: 9, fontSize: 12 }}
                >
                  Move all {(matchTotal ?? 0).toLocaleString()} to Trash…
                </button>
              )}
              {taRun && (
                <div style={{ marginTop: 10 }}>
                  <div className="flex items-center gap-2" style={{ fontSize: 11, color: 'var(--sub)', marginBottom: 6 }}>
                    <span>Trashing… {taRun.done.toLocaleString()} / {taRun.total.toLocaleString()}</span>
                    <button onClick={() => { cancelledRef.current = true }} className="gc-btn-pill ml-auto" style={{ padding: '3px 12px' }}>
                      Stop
                    </button>
                  </div>
                  <div className="overflow-hidden" style={{ height: 4, borderRadius: 2, background: 'var(--chip)' }}>
                    <div
                      className="h-full"
                      style={{
                        borderRadius: 2, background: 'var(--danger-bar)',
                        width: `${taRun.total > 0 ? Math.round((taRun.done / taRun.total) * 100) : 0}%`,
                        transition: 'width .12s linear',
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

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
                      className="flex items-stretch gap-2"
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
              !taRun && (
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

      {/* Floating bulk-action bar — rises from the bottom while emails are selected */}
      {phase === 'results' && selected.size > 0 && !confirm && !taRun && (
        <BulkBar
          label={`${selected.size} selected · ~${formatSize(selectedBytes)}`}
          onClear={selectNone}
        >
          <button
            onClick={() => requestAction('trash')}
            disabled={acting}
            className="gc-btn gc-btn-danger"
            style={{ flex: 1.2, padding: 9, fontSize: '12.5px' }}
          >
            {acting ? 'Working…' : 'Move to Trash…'}
          </button>
          <button
            onClick={() => requestAction('archive')}
            disabled={acting}
            className="gc-btn gc-btn-neutral flex-1"
            style={{ padding: 9, fontSize: '12.5px' }}
          >
            {acting ? 'Working…' : 'Archive…'}
          </button>
        </BulkBar>
      )}

      {/* Confirmation sheet — every destructive action passes through here */}
      <ConfirmSheet confirm={confirm} onCancel={() => setConfirm(null)} />
    </div>
  )
}
