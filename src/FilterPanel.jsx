// FilterPanel.jsx — lets the user choose search criteria before fetching emails.
// It only renders the filter fields themselves — the Search button lives in
// SearchTab.jsx. The two are still linked as one real HTML form via the
// `form` attribute on that button, so pressing Enter in the "From" field
// still submits a search even though the button lives elsewhere.
//
// The dropdowns are the custom animated ones from ui.jsx (the design replaces
// every native <select>): chevron, blue checkmark on the selected option,
// hover tint that follows the mouse, Esc/outside-click to close.
//
// Gmail search operators we use:
//   larger:5M       — emails over 5 MB
//   older_than:1y   — emails older than 1 year
//   is:unread       — unread emails only
//   from:x@y.com    — emails from a specific sender

import { Dropdown } from './ui.jsx'

// Builds a Gmail search query from the filter values.
// Each active filter adds one "operator:value" clause.
// Example output: "larger:5M older_than:1y is:unread"
export function buildQuery(filters) {
  const parts = []
  if (filters.minSize)      parts.push(`larger:${filters.minSize}`)
  if (filters.olderThan)    parts.push(`older_than:${filters.olderThan}`)
  if (filters.readStatus === 'unread') parts.push('is:unread')
  if (filters.readStatus === 'read')   parts.push('is:read')
  if (filters.sender.trim()) parts.push(`from:${filters.sender.trim()}`)
  return parts.join(' ')
}

export const DEFAULT_FILTERS = {
  minSize:    '5M',   // default: emails over 5 MB
  olderThan:  '',     // default: any age
  readStatus: '',     // default: all (read + unread)
  sender:     '',     // default: any sender
}

// One place for every option's value AND its human label, so the dropdowns
// and the "filter summary" chip shown over search results can't drift apart.
export const SIZE_OPTIONS = [
  { value: '',    label: 'Any size' },
  { value: '1M',  label: 'Larger than 1 MB' },
  { value: '5M',  label: 'Larger than 5 MB' },
  { value: '10M', label: 'Larger than 10 MB' },
  { value: '25M', label: 'Larger than 25 MB' },
]
export const AGE_OPTIONS = [
  { value: '',   label: 'Any age' },
  { value: '1m', label: 'Older than 1 month' },
  { value: '6m', label: 'Older than 6 months' },
  { value: '1y', label: 'Older than 1 year' },
  { value: '2y', label: 'Older than 2 years' },
  { value: '3y', label: 'Older than 3 years' },
  { value: '4y', label: 'Older than 4 years' },
  { value: '5y', label: 'Older than 5 years' },
]
export const READ_OPTIONS = [
  { value: '',       label: 'All emails' },
  { value: 'unread', label: 'Unread only' },
  { value: 'read',   label: 'Read only' },
]

// Human summary of the active filters, e.g. "Larger than 5 MB · Unread only".
// Shown in the chip above search results and on the busy card.
export function summarizeFilters(filters) {
  const parts = []
  if (filters.minSize)   parts.push(SIZE_OPTIONS.find((o) => o.value === filters.minSize)?.label)
  if (filters.olderThan) parts.push(AGE_OPTIONS.find((o) => o.value === filters.olderThan)?.label)
  if (filters.readStatus) parts.push(READ_OPTIONS.find((o) => o.value === filters.readStatus)?.label)
  if (filters.sender.trim()) parts.push('From ' + filters.sender.trim())
  return parts.filter(Boolean).join(' · ') || 'All mail'
}

// Shared label style: small, bold, muted — sits above each field.
const labelStyle = { display: 'grid', gap: 4, fontSize: 11, fontWeight: 600, color: 'var(--sub)' }

// `filters` / `onChange` are lifted up into SearchTab, so this component
// is fully controlled — it just displays the fields and reports changes.
// `formId` links these fields to the Search button living elsewhere on the
// page (see the `form` attribute trick in SearchTab.jsx).
export default function FilterPanel({ filters, onChange, onSubmit, loading, formId }) {
  function handleSubmit(e) {
    e.preventDefault() // prevent the form from reloading the page
    onSubmit()
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="grid gap-2.5">

      {/* Size filter */}
      <div style={labelStyle}>
        Minimum size
        <Dropdown
          value={filters.minSize}
          options={SIZE_OPTIONS}
          onChange={(v) => onChange('minSize', v)}
          disabled={loading}
        />
      </div>

      {/* Age filter */}
      <div style={labelStyle}>
        Age
        <Dropdown
          value={filters.olderThan}
          options={AGE_OPTIONS}
          onChange={(v) => onChange('olderThan', v)}
          disabled={loading}
        />
      </div>

      {/* Read / unread filter */}
      <div style={labelStyle}>
        Read status
        <Dropdown
          value={filters.readStatus}
          options={READ_OPTIONS}
          onChange={(v) => onChange('readStatus', v)}
          disabled={loading}
        />
      </div>

      {/* Sender filter (optional free text) */}
      <label style={labelStyle}>
        <span>From <span style={{ fontWeight: 400, color: 'var(--faint)' }}>(optional)</span></span>
        <input
          type="text"
          value={filters.sender}
          onChange={(e) => onChange('sender', e.target.value)}
          disabled={loading}
          placeholder="newsletter@example.com"
          className="gc-field"
        />
      </label>
    </form>
  )
}
