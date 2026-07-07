// FilterPanel.jsx — lets the user choose search criteria before fetching emails.
// It only renders the filter fields themselves now — the Search / Trash All
// Matching buttons moved up into SearchTab.jsx, which needs them pinned to
// the top of the page separately from these dropdowns (which scroll away
// normally). The two are still linked as one real HTML form via the `form`
// attribute on those buttons (see SearchTab.jsx), so pressing Enter in the
// "From" field still submits a search even though the button now lives
// elsewhere in the page.
//
// Gmail search operators we use:
//   larger:5M       — emails over 5 MB
//   older_than:1y   — emails older than 1 year
//   is:unread       — unread emails only
//   from:x@y.com    — emails from a specific sender

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

// `filters` / `onChange` are lifted up into SearchTab now, so this component
// is fully controlled — it just displays the fields and reports changes.
// `formId` links these fields to the Search button living elsewhere on the
// page (see the `form` attribute trick in SearchTab.jsx).
export default function FilterPanel({ filters, onChange, onSubmit, loading, formId }) {
  function handleSubmit(e) {
    e.preventDefault() // prevent the form from reloading the page
    onSubmit()
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-2">

      {/* Size filter */}
      <div>
        <label className="block text-xs text-gray-500 mb-0.5">Minimum size</label>
        <select
          value={filters.minSize}
          onChange={(e) => onChange('minSize', e.target.value)}
          disabled={loading}
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
        >
          <option value="">Any size</option>
          <option value="1M">Larger than 1 MB</option>
          <option value="5M">Larger than 5 MB</option>
          <option value="10M">Larger than 10 MB</option>
          <option value="25M">Larger than 25 MB</option>
        </select>
      </div>

      {/* Age filter */}
      <div>
        <label className="block text-xs text-gray-500 mb-0.5">Age</label>
        <select
          value={filters.olderThan}
          onChange={(e) => onChange('olderThan', e.target.value)}
          disabled={loading}
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
        >
          <option value="">Any age</option>
          <option value="1m">Older than 1 month</option>
          <option value="6m">Older than 6 months</option>
          <option value="1y">Older than 1 year</option>
          <option value="2y">Older than 2 years</option>
          <option value="3y">Older than 3 years</option>
          <option value="4y">Older than 4 years</option>
          <option value="5y">Older than 5 years</option>
        </select>
      </div>

      {/* Read / unread filter */}
      <div>
        <label className="block text-xs text-gray-500 mb-0.5">Read status</label>
        <select
          value={filters.readStatus}
          onChange={(e) => onChange('readStatus', e.target.value)}
          disabled={loading}
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
        >
          <option value="">All emails</option>
          <option value="unread">Unread only</option>
          <option value="read">Read only</option>
        </select>
      </div>

      {/* Sender filter (optional free text) */}
      <div>
        <label className="block text-xs text-gray-500 mb-0.5">
          From (optional)
        </label>
        <input
          type="text"
          value={filters.sender}
          onChange={(e) => onChange('sender', e.target.value)}
          disabled={loading}
          placeholder="e.g. newsletter@example.com"
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
        />
      </div>
    </form>
  )
}
