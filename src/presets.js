// presets.js — the list of Quick Presets: pre-written Gmail queries for common
// cleanup jobs. Used directly inside SearchTab.jsx as a row of one-click buttons
// above the normal filters — clicking one just runs that query through the same
// search you'd get from typing filters in by hand.

// Each preset: a short label, a one-line plain-English description (shown as a
// tooltip), and the actual Gmail query string (the technical part).
export const PRESETS = [
  {
    label: 'Social notifications',
    description: 'Alerts from Facebook, Twitter/X, LinkedIn, and Instagram',
    query: 'from:(facebook.com OR twitter.com OR linkedin.com OR instagram.com)',
  },
  {
    label: 'Shipping & receipts',
    description: 'Order confirmations, shipping updates, and receipts',
    query: 'subject:(shipped OR delivered OR "order confirmed" OR receipt)',
  },
  {
    label: 'Old calendar invites',
    description: 'Meeting invites older than 6 months',
    query: 'filename:invite.ics older_than:6m',
  },
  {
    label: 'Unsubscribe confirmations',
    description: '"You\'ve been unsubscribed" style emails',
    query: 'subject:(unsubscribe OR "you\'ve been unsubscribed")',
  },
]
