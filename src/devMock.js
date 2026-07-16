// devMock.js — a fake Gmail + fake chrome.* APIs, used ONLY while previewing
// the UI in a normal browser tab with `npx vite` (the dev server). It lets
// you click through every screen — search, scan, trash, undo, unsubscribe —
// against made-up data, with your real mailbox never involved.
//
// It is loaded from main.jsx behind `import.meta.env.DEV`, which is false in
// `npm run build`, so none of this ships in the real extension.

// ---------------------------------------------------------------------------
// Fake mailbox data
// ---------------------------------------------------------------------------

const SENDERS = [
  { name: "Macy's",              email: 'promo@macys.com',                sub: true,  manual: false, count: 34 },
  { name: 'H&M',                 email: 'news@hm.com',                    sub: true,  manual: false, count: 28 },
  { name: 'LinkedIn Job Alerts', email: 'jobalerts-noreply@linkedin.com', sub: true,  manual: false, count: 26 },
  { name: 'StockX',              email: 'news@stockx.com',                sub: true,  manual: true,  count: 22 },
  { name: 'Medium Daily Digest', email: 'noreply@medium.com',             sub: true,  manual: false, count: 18 },
  { name: 'Bring a Trailer',     email: 'mail@bringatrailer.com',         sub: true,  manual: true,  count: 15 },
  { name: 'LinkedIn',            email: 'updates-noreply@linkedin.com',   sub: true,  manual: false, count: 24 },
  { name: 'Facebook',            email: 'notification@facebookmail.com',  sub: true,  manual: false, count: 19 },
  { name: 'Bryan Phillips',      email: 'bryan@example.com',              sub: false, manual: false, count: 30 },
  { name: 'Suzie Phillips',      email: 'suzie@example.com',              sub: false, manual: false, count: 8 },
  { name: 'TeamSnap',            email: 'no-reply@teamsnap.com',          sub: false, manual: false, count: 14 },
  { name: 'School Newsletter',   email: 'office@school.example.org',      sub: false, manual: false, count: 9 },
]

const SUBJECTS = [
  'Your weekly recap is ready', 'New arrivals you might like', '3 new notifications',
  'Order shipped — track your package', 'Now hiring near you', 'Trending this week',
  'Reminder: game this Saturday', 'Sale ends tonight', 'Your statement is available',
  'Photos from last weekend', 'Invitation: team meeting', 'Re: quick question',
]

const DAY_MS = 24 * 60 * 60 * 1000

// Deterministic pseudo-random so the preview looks the same every reload.
let seed = 42
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

// Build one flat list of fake messages. `trashed`/`archived` flags flip as
// the UI acts on them, so search results, trash-all loops, and Undo all
// behave like the real thing.
const messages = []
let n = 0
for (const s of SENDERS) {
  for (let i = 0; i < s.count; i++) {
    n++
    messages.push({
      id: 'msg' + n,
      sender: s,
      subject: SUBJECTS[Math.floor(rand() * SUBJECTS.length)],
      sizeEstimate: Math.round(60_000 + rand() * 12_000_000),          // 60 KB – 12 MB
      internalDate: Date.now() - Math.round(rand() * 900 * DAY_MS),   // up to ~2.5 years old
      unread: rand() < 0.55,
      trashed: false,
      archived: false,
    })
  }
}

function toApiMessage(m) {
  const headers = [
    { name: 'From', value: `"${m.sender.name}" <${m.sender.email}>` },
    { name: 'Subject', value: m.subject },
    { name: 'Date', value: new Date(m.internalDate).toUTCString() },
  ]
  if (m.sender.sub) {
    headers.push({
      name: 'List-Unsubscribe',
      value: m.sender.manual
        ? `<https://example.com/unsub-form?u=${encodeURIComponent(m.sender.email)}>`
        : `<https://example.com/unsub-auto?u=${encodeURIComponent(m.sender.email)}>`,
    })
  }
  return {
    id: m.id,
    sizeEstimate: m.sizeEstimate,
    internalDate: String(m.internalDate),
    labelIds: m.unread ? ['UNREAD'] : [],
    payload: { headers },
  }
}

// Very small subset of Gmail query syntax — enough for this app's queries
// (larger:, older_than:, is:unread/read, from:, in:inbox/anywhere).
function matchesQuery(m, q) {
  if (m.trashed) return false
  for (const part of q.split(/\s+/).filter(Boolean)) {
    if (part.startsWith('larger:')) {
      const mb = parseFloat(part.slice(7))
      if (!(m.sizeEstimate > mb * 1024 * 1024)) return false
    } else if (part.startsWith('older_than:')) {
      const v = part.slice(11)
      const days = v.endsWith('y') ? parseInt(v) * 365 : parseInt(v) * 30
      if (!(m.internalDate < Date.now() - days * DAY_MS)) return false
    } else if (part === 'is:unread') {
      if (!m.unread) return false
    } else if (part === 'is:read') {
      if (m.unread) return false
    } else if (part.startsWith('from:')) {
      const who = part.slice(5).toLowerCase().replace(/[()]/g, '')
      const hay = (m.sender.email + ' ' + m.sender.name).toLowerCase()
      if (!who.split(' or ').some((w) => hay.includes(w.trim()))) return false
    } else if (part === 'in:inbox') {
      if (m.archived) return false
    }
    // anything else (subject:, filename:, in:anywhere, OR groups) — allow all
  }
  return true
}

// ---------------------------------------------------------------------------
// Fake fetch for the Gmail API (everything else passes through untouched)
// ---------------------------------------------------------------------------

const realFetch = window.fetch.bind(window)
const API = 'https://www.googleapis.com/gmail/v1/users/me'

function json(data) {
  return Promise.resolve(new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
}

window.fetch = function (url, options) {
  const u = String(url)
  if (!u.startsWith('https://www.googleapis.com/')) return realFetch(url, options)

  if (u.startsWith(`${API}/profile`)) {
    return json({ emailAddress: 'preview@example.com' })
  }

  // messages.list — pagination in pages of 500 (our dataset fits in one page)
  const listMatch = u.match(/\/messages\?(.+)$/)
  if (listMatch && !u.includes('/messages/')) {
    const params = new URLSearchParams(listMatch[1])
    const q = params.get('q') || ''
    const all = messages.filter((m) => matchesQuery(m, q))
    return json({
      messages: all.map((m) => ({ id: m.id })),
      resultSizeEstimate: all.length,
    })
  }

  // messages.trash / untrash / modify / get
  const idMatch = u.match(/\/messages\/([^/?]+)(?:\/(trash|untrash|modify))?/)
  if (idMatch) {
    const m = messages.find((x) => x.id === idMatch[1])
    if (!m) return json({})
    const action = idMatch[2]
    if (action === 'trash')   { m.trashed = true;  return json({ id: m.id }) }
    if (action === 'untrash') { m.trashed = false; return json({ id: m.id }) }
    if (action === 'modify') {
      const body = options?.body ? JSON.parse(options.body) : {}
      if (body.removeLabelIds?.includes('INBOX')) m.archived = true
      if (body.addLabelIds?.includes('INBOX'))    m.archived = false
      return json({ id: m.id })
    }
    return json(toApiMessage(m))
  }

  return realFetch(url, options)
}

// ---------------------------------------------------------------------------
// Fake chrome.* — just enough for auth, storage, and the unsubscribe fetch
// ---------------------------------------------------------------------------

const storageData = {}

window.chrome = {
  identity: {
    getAuthToken({ interactive }, cb) { cb('dev-preview-token') },
  },
  runtime: {
    lastError: undefined,
    sendMessage(msg, cb) {
      // FETCH_UNSUB — pretend "unsub-form" pages need a manual click
      if (msg?.type === 'FETCH_UNSUB') {
        const manual = String(msg.url).includes('unsub-form')
        setTimeout(() => cb({ ok: true, body: manual ? '<form>confirm</form>' : 'You are unsubscribed.' }), 150)
      } else {
        cb?.({})
      }
    },
  },
  storage: {
    local: {
      get(keys, cb) {
        const wanted = typeof keys === 'string' ? [keys] : keys
        const out = {}
        for (const k of wanted) if (k in storageData) out[k] = storageData[k]
        cb(out)
      },
      set(obj, cb) { Object.assign(storageData, obj); cb?.() },
    },
  },
}

console.info('[devMock] Fake Gmail + chrome APIs active — preview data only, no real mailbox involved.')
