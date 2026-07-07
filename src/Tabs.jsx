// Tabs.jsx — the row of buttons at the top that switches between
// Search / Senders. It doesn't hold any data itself — it just tells
// App.jsx which tab was clicked.

const TABS = [
  { id: 'search', label: 'Search' },
  { id: 'senders', label: 'Senders' },
]

export default function Tabs({ active, onChange }) {
  return (
    <div className="flex border-b border-gray-200 mb-3">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex-1 text-xs font-medium py-2 border-b-2 transition-colors ${
            active === tab.id
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
