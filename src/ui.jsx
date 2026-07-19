// ui.jsx — small shared visual building blocks used by both tabs, built to
// match the design handoff exactly. Nothing in here talks to Gmail — these
// are purely presentational, with tiny bits of local state (like whether a
// dropdown is open).

import { useState, useEffect, useRef } from 'react'

// Chevron and checkmark icons used by the dropdowns (inline SVG per the
// design — no image assets anywhere).
export function Chevron({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4.5 6 8l3.5-3.5" />
    </svg>
  )
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 5.5 4 8l4.5-6" />
    </svg>
  )
}

// Dropdown — replaces native <select> everywhere, per the design.
//   variant "field": full-width field-styled trigger (the filter dropdowns)
//   variant "pill":  compact rounded pill (the Results sort control)
// Behavior: click toggles, outside mousedown closes, Esc closes, picking an
// option closes. Only one can effectively be open at a time — opening another
// one starts with a mousedown outside this one, which closes it.
export function Dropdown({ value, options, onChange, variant = 'field', disabled = false }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDocDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find((o) => o.value === value)
  const isPill = variant === 'pill'

  return (
    <div ref={rootRef} className="relative">
      {isPill ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-full font-semibold cursor-pointer"
          style={{
            padding: '4px 10px', border: '1px solid var(--line)', background: 'var(--card)',
            fontSize: '11px', color: 'var(--ink)', fontFamily: 'inherit',
          }}
        >
          {current?.label}
          <Chevron size={10} />
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setOpen((v) => !v)}
            className="gc-field cursor-pointer"
            style={{ paddingRight: 34 }}
          >
            {current?.label}
          </button>
          {/* chevron sits over the trigger's right edge; clicks pass through */}
          <span className="absolute pointer-events-none" style={{ right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink)' }}>
            <Chevron />
          </span>
        </>
      )}

      {open && (
        <div
          className="absolute z-40 grid gap-px p-1"
          style={{
            top: 'calc(100% + 4px)',
            ...(isPill ? { right: 0, minWidth: 150 } : { left: 0, right: 0 }),
            background: 'var(--card)', border: '1px solid var(--line)',
            borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-dd)',
            animation: 'gcDdIn .16s var(--spring)',
          }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className="gc-dd-opt"
              style={isPill ? { padding: '7px 10px', fontSize: '11.5px' } : undefined}
              onClick={() => { onChange(o.value); setOpen(false) }}
            >
              {/* fixed 12px lead slot — checkmark only on the selected option */}
              <span className="shrink-0" style={{ width: 12, height: 12, color: 'var(--accent)' }}>
                {o.value === value && <Check />}
              </span>
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// PrimaryButton — the gradient CTA (Search / Scan / Connect) with the
// design's animated WebGL glow overlay. <shader-glow> is the custom element
// registered by shader-glow.js (loaded once in main.jsx, copied verbatim
// from the design handoff). The glow only animates while hovered: paused
// flips to "false" on mouseenter and back to "true" on mouseleave, and the
// element eases its animation to a stop rather than freezing. The label
// sits in a position:relative span so it paints above the canvas.
export function PrimaryButton({ children, className = '', ...props }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      {...props}
      className={`gc-btn gc-btn-primary ${className}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <shader-glow
        paused={hovered ? 'false' : 'true'}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      />
      <span>{children}</span>
    </button>
  )
}

// Segmented — the two-option pill switch with a sliding "thumb" (the white
// card that glides between options). Used for the main tabs, Inbox/All mail,
// Subscriptions/Everything else, and the small Size/Count sort toggle.
//   size "seg":  full-width halves (tabs, scope, show)
//   size "pill": compact fixed-width options (Size / Count)
export function Segmented({ options, value, onChange, size = 'seg', disabled = false }) {
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  const isPill = size === 'pill'

  return (
    <div
      className="relative"
      style={{
        display: isPill ? 'flex' : 'grid',
        gridTemplateColumns: isPill ? undefined : `repeat(${options.length}, 1fr)`,
        gap: 2, background: 'var(--chip)', padding: 2,
        borderRadius: isPill ? 999 : 'var(--radius-sm)',
      }}
    >
      {/* the sliding thumb */}
      <div
        className="absolute"
        style={{
          top: 2, bottom: 2, left: 2,
          width: isPill ? 56 : `calc(${100 / options.length}% - 3px)`,
          borderRadius: isPill ? 999 : 'calc(var(--radius-sm) - 2px)',
          background: 'var(--card)', boxShadow: 'var(--shadow)',
          transition: 'transform .34s cubic-bezier(.22,1,.36,1)',
          transform: isPill
            ? `translateX(${index * 58}px)`
            : `translateX(calc(${index * 100}% + ${index * 2}px))`,
        }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className="relative z-[1] border-none bg-transparent cursor-pointer font-semibold text-center disabled:opacity-50"
          style={{
            fontFamily: 'inherit',
            ...(isPill
              ? { width: 56, padding: '3px 0', fontSize: '11px', borderRadius: 999 }
              : { padding: '7px 4px', fontSize: '12px', borderRadius: 'calc(var(--radius-sm) - 2px)' }),
            color: o.value === value ? 'var(--ink)' : 'var(--sub)',
            transition: 'color .26s ease, transform .2s var(--spring)',
          }}
          onMouseDown={(e) => e.preventDefault() /* keep focus ring off simple toggles */}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ConfirmSheet — the bottom confirmation sheet with a dimmed backdrop.
// Every destructive action (trash, archive, unsubscribe, and bulk variants)
// goes through one of these before anything fires: an explicit "confirm"
// step, which is a hard requirement of this project.
//   confirm = { title, body, cta, danger, onConfirm } — or null to hide.
export function ConfirmSheet({ confirm, onCancel }) {
  if (!confirm) return null
  return (
    <>
      {/* dimmed backdrop — clicking it cancels */}
      <div
        onClick={onCancel}
        className="fixed inset-0 z-30"
        style={{ background: 'rgba(18,16,12,.32)', animation: 'gcRise .12s ease' }}
      />
      <div
        className="fixed z-[31]"
        style={{
          left: 10, right: 10, bottom: 10,
          background: 'var(--card)', border: '1px solid var(--line)',
          borderRadius: 'var(--radius)', padding: '16px 14px 14px',
          boxShadow: '0 16px 40px rgba(20,15,5,.28)', animation: 'gcRise .18s ease',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.01em', marginBottom: 6 }}>
          {confirm.title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--sub)', lineHeight: 1.55, marginBottom: 14 }}>
          {confirm.body}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="gc-btn gc-btn-neutral flex-1" style={{ padding: 10, fontSize: '12.5px' }}>
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm.onConfirm}
            className="gc-btn"
            style={{
              flex: 1.4, padding: 10, borderRadius: 'var(--radius-sm)', border: 'none',
              fontSize: '12.5px', fontWeight: 700, color: '#fff',
              background: confirm.danger ? 'var(--danger-bar)' : 'var(--accent-grad)',
            }}
          >
            {confirm.cta}
          </button>
        </div>
      </div>
    </>
  )
}

// BusyCard — the "Searching your mail…" / "Scanning…" card with either an
// indeterminate sweeping bar (when we don't know the total yet) or a
// determinate fill (when we do).
export function BusyCard({ title, caption, progress = null, extra = null }) {
  const pct = progress && progress.total > 0
    ? Math.round((progress.loaded / progress.total) * 100)
    : null
  return (
    <div className="gc-card" style={{ padding: '16px 14px' }}>
      <div style={{ fontWeight: 600, fontSize: '12.5px', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 12 }}>{caption}</div>
      <div className="relative overflow-hidden" style={{ height: 4, borderRadius: 2, background: 'var(--chip)' }}>
        {pct === null ? (
          <div
            className="absolute top-0 left-0 h-full"
            style={{ width: '30%', borderRadius: 2, background: 'var(--accent-grad)', animation: 'gcSlide 1.1s ease-in-out infinite' }}
          />
        ) : (
          <div
            className="h-full"
            style={{ width: `${pct}%`, borderRadius: 2, background: 'var(--accent-grad)', transition: 'width .3s' }}
          />
        )}
      </div>
      {extra}
    </div>
  )
}

// Rail — the drag-to-select rail: a vertical track with a round bead. The
// bead + track are purely visual; the pointer handlers are passed in by the
// list that owns the drag logic. Kept as one component so message rows and
// sender rows stay pixel-identical.
export function Rail({ selected, onMouseDown, onMouseEnter }) {
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      className="relative flex items-center justify-center shrink-0 select-none"
      style={{ width: 20, cursor: 'ns-resize', touchAction: 'none' }}
      title="Drag up or down to select a range"
    >
      <div className="absolute" style={{ top: -3, bottom: -3, left: '50%', width: 2, marginLeft: -1, background: 'var(--line)' }} />
      <div
        className="relative rounded-full box-border"
        style={{
          width: 12, height: 12,
          border: `2px solid ${selected ? 'var(--accent)' : 'var(--faint)'}`,
          background: selected ? 'var(--accent-grad)' : 'var(--bg)',
          transition: 'background .12s, border-color .12s',
        }}
      />
    </div>
  )
}

// BulkBar — the action bar that rises from the bottom of the panel while
// something is selected. Children are the action buttons.
// It sits IN the layout (not floating over it): the tab's scroll area ends
// at the bar's top edge, so it never covers the back-to-top arrow, and
// drag-select auto-scroll keeps working right down to the last row.
// `hint` (optional) renders a small muted line under the buttons — used
// while a search/scan is still streaming and the actions are disabled.
export function BulkBar({ label, onClear, hint, children }) {
  return (
    <div
      className="shrink-0"
      style={{
        margin: '8px 12px 12px',
        background: 'var(--card)', border: '1px solid var(--line)',
        borderRadius: 'var(--radius)', padding: '10px 12px',
        boxShadow: '0 6px 20px rgba(20,20,20,.12)', animation: 'gcRise .16s ease',
      }}
    >
      <div className="flex items-center gap-2" style={{ fontSize: 12, marginBottom: 8 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <button
          type="button"
          onClick={onClear}
          className="ml-auto border-none bg-transparent cursor-pointer p-0"
          style={{ color: 'var(--faint)', fontSize: '11.5px', fontFamily: 'inherit' }}
        >
          Clear
        </button>
      </div>
      <div className="flex gap-2">{children}</div>
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 6, textAlign: 'center' }}>{hint}</div>
      )}
    </div>
  )
}

// ProgressStrip — the slim sticky strip pinned to the top of the results
// area while a search/scan is still streaming rows in. Shows what's
// happening, an optional detail line, and a Stop button.
// `progress` ({ loaded, total }) is optional: when given (and total is
// known), the bar fills proportionally so it's clear how far along the run
// is — without spelling out exact counts. Without it, the bar is the
// indeterminate sweep.
export function ProgressStrip({ title, detail, progress, onStop }) {
  const pct = progress && progress.total > 0
    ? Math.round((progress.loaded / progress.total) * 100)
    : null
  return (
    <div className="sticky z-[15]" style={{ top: 0, marginBottom: 12 }}>
      <div className="gc-card" style={{ padding: '9px 12px' }}>
        <div className="flex items-center gap-2">
          <span style={{ fontWeight: 600, fontSize: 12 }}>{title}</span>
          {detail && (
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" style={{ fontSize: 11, color: 'var(--faint)' }}>
              {detail}
            </span>
          )}
          <button onClick={onStop} className="gc-btn-pill ml-auto shrink-0" style={{ padding: '3px 12px' }}>
            Stop
          </button>
        </div>
        <div className="relative overflow-hidden" style={{ height: 3, borderRadius: 2, background: 'var(--chip)', marginTop: 7 }}>
          {pct === null ? (
            <div className="gc-bar-sweep" />
          ) : (
            /* Determinate fill + sweeping sheen (see .gc-bar-* in index.css).
               The strip only renders while a run is active, so the sheen
               stops the moment the search/scan completes or is stopped. */
            <div className="gc-bar-fill" style={{ width: `${pct}%` }}>
              <div className="gc-bar-sheen" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
