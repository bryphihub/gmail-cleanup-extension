// Gmail API helper functions — same logic as before, now as proper ES modules
// so React can import them with `import { listMessages } from './gmail.js'`.

import { GmailAuthError } from './auth.js'

const GMAIL_BASE = 'https://www.googleapis.com/gmail/v1/users/me'

// Shared error handler: Gmail API returns HTTP errors as normal responses,
// so we check the status ourselves and throw a readable error message.
// Google's error body usually includes a specific reason (e.g. "insufficient
// permission", "quota exceeded") — we surface that instead of just the status
// code so it's actually possible to tell what went wrong.
// A 401 specifically means our token is no longer good (expired or revoked) —
// thrown as a GmailAuthError so callers can tell "you need to reconnect" apart
// from every other kind of failure and show a Reconnect prompt instead of a
// raw error message.
async function handleResponse(response) {
  if (!response.ok) {
    let detail = ''
    try {
      const body = await response.json()
      detail = body?.error?.message || ''
    } catch {
      // Body wasn't JSON (or was empty) — fall back to just the status code.
    }
    const message = `Gmail API error: ${response.status}${detail ? ' — ' + detail : ''}`
    if (response.status === 401) throw new GmailAuthError(message)
    throw new Error(message)
  }
  return response.json()
}

// Waits for `ms` milliseconds — used to pause between retries.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Google's Gmail API doesn't always use 429 for "you're going too fast" — some
// quotas (like "Queries per minute per user") come back as a 403 instead. We
// have to peek at the error body's `reason` to tell "too fast, try again" apart
// from "not allowed, don't bother retrying" (e.g. a real permissions problem).
const RATE_LIMIT_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']

async function is403RateLimit(response) {
  try {
    // .clone() lets us read the body here without using it up —
    // handleResponse (or the next retry) still needs to read it too.
    const body = await response.clone().json()
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.status
    return RATE_LIMIT_REASONS.includes(reason)
  } catch {
    return false
  }
}

// Fetches a URL and retries automatically if Gmail says we're going too fast —
// either a plain 429, or a 403 whose reason is one of the rate/quota limits above.
// Waits longer between each attempt (exponential backoff), since per-minute
// quotas need more recovery time than a simple "too many at once" 429 does.
async function fetchWithRetry(url, options, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, options)

    const isLastAttempt = attempt >= retries
    const rateLimited = response.status === 429 || (response.status === 403 && await is403RateLimit(response))

    if (rateLimited && !isLastAttempt) {
      const waitMs = 2000 * Math.pow(2, attempt) // 2s, 4s, 8s, 16s, 32s
      await sleep(waitMs)
      continue
    }

    return handleResponse(response)
  }
}

// Quickly estimates how many emails match a query without fetching all of them.
// Gmail's resultSizeEstimate is an approximation — treat it as "roughly X".
// Returns Gmail's estimate of how many emails match a query.
// Using maxResults=500 gives a significantly more accurate estimate than maxResults=1.
// Note: resultSizeEstimate is still approximate — treat it as "roughly X".
export async function estimateMessageCount(token, query) {
  const params = new URLSearchParams({ q: query, maxResults: '500' })
  const data = await fetchWithRetry(`${GMAIL_BASE}/messages?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return data.resultSizeEstimate || 0
}

// Fetches ALL matching message IDs by paginating through every page.
// Uses fetchWithRetry so rate limits (429) are handled automatically.
// Calls onProgress(count) after each page so the UI can show a live counter.
// Returns the full array of IDs (count = ids.length).
export async function getAllIds(token, query, onProgress) {
  const ids = []
  let pageToken = undefined

  while (true) {
    const params = new URLSearchParams({ q: query, maxResults: '500' })
    if (pageToken) params.set('pageToken', pageToken)

    const data = await fetchWithRetry(`${GMAIL_BASE}/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    ids.push(...(data.messages || []).map((m) => m.id))

    if (onProgress) onProgress(ids.length)

    if (!data.nextPageToken) break  // no more pages
    pageToken = data.nextPageToken

    // Brief pause between pages to stay well under Gmail's rate limits.
    await sleep(100)
  }

  return ids
}

// Fetches ALL matching message IDs by paginating through every page of results.
// Returns { ids: string[], totalEstimate: number }.
// `maxTotal` is a safety cap — Gmail could return thousands of results for broad queries.
export async function listAllMessageIds(token, query, maxTotal = 500) {
  const ids = []
  let pageToken = undefined
  let totalEstimate = 0

  while (ids.length < maxTotal) {
    const params = new URLSearchParams({ q: query, maxResults: '500' })
    if (pageToken) params.set('pageToken', pageToken)

    const data = await fetchWithRetry(`${GMAIL_BASE}/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    // resultSizeEstimate is only reliable on the first page
    if (!pageToken) totalEstimate = data.resultSizeEstimate || 0

    const messages = data.messages || []
    ids.push(...messages.map((m) => m.id))

    // Stop if there are no more pages
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }

  return { ids: ids.slice(0, maxTotal), totalEstimate }
}

// Scans every message in the given scope (Inbox or All mail) and returns one
// record PER MESSAGE — not pre-grouped by sender. Keeping the raw per-message
// list (rather than only returning sender totals) is what lets the Senders tab
// apply filters (age, unread, size) and the "subscriptions only" toggle
// instantly in the UI, without a new scan every time one of those changes —
// only the scope (Inbox vs All mail) requires re-scanning.
//
// Each record: { id, email, name, sizeEstimate, dateMs, isUnread, isSubscription, unsubHeader }
// - `dateMs` comes from Gmail's own `internalDate` field (already a timestamp),
//   which is always present and doesn't need parsing the way a Date header would.
// - `isUnread` comes from `labelIds`, which (like sizeEstimate and internalDate)
//   is included on every message regardless of the `format` requested — free.
// - `isSubscription` is true when the message carries a List-Unsubscribe header —
//   the same signal the old Subscriptions tab used, just recorded per message
//   instead of being used as a filter on what gets fetched.
//
// `options.scope` — 'inbox' (default) searches in:inbox only; 'all' searches every
//   message (in:anywhere), including everything outside the inbox.
// `onProgress(loaded, total)` — drives the progress bar (total is 0 while still counting IDs).
// `onUpdate(results)` — called after every batch with the current live (partial) results.
export async function scanSenders(token, options = {}, onProgress, onUpdate) {
  const { scope = 'inbox' } = options
  const query = scope === 'all' ? 'in:anywhere' : 'in:inbox'

  if (onProgress) onProgress(0, 0)
  const allIds = await getAllIds(token, query)
  if (allIds.length === 0) return []

  const messages = []

  // Helper: fetches metadata for a single batch of IDs. Only From and
  // List-Unsubscribe need to be requested as headers — size, date, and read
  // status all come back automatically on every message regardless of format.
  function fetchBatch(batch) {
    return Promise.allSettled(
      batch.map((id) => {
        const p = new URLSearchParams({ format: 'metadata' })
        p.append('metadataHeaders', 'From')
        p.append('metadataHeaders', 'List-Unsubscribe')
        return fetchWithRetry(`${GMAIL_BASE}/messages/${id}?${p}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      })
    )
  }

  // Helper: turns one fetched message into a record and adds it to the list.
  function processResult(msg) {
    const headers = msg.payload?.headers || []
    const from = headers.find((h) => h.name === 'From')?.value || '(unknown)'
    const unsubHeader = headers.find((h) => h.name === 'List-Unsubscribe')?.value || ''

    const emailMatch = from.match(/<([^>]+)>/)
    const email = (emailMatch ? emailMatch[1] : from).toLowerCase().trim()
    const name = emailMatch ? from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() : from

    messages.push({
      id: msg.id,
      email,
      name,
      sizeEstimate: msg.sizeEstimate || 0,
      dateMs: msg.internalDate ? Number(msg.internalDate) : null,
      isUnread: (msg.labelIds || []).includes('UNREAD'),
      isSubscription: !!unsubHeader,
      unsubHeader: unsubHeader || null,
    })
  }

  // Step by 20 — two batches of 10 fire simultaneously each round, roughly halving scan time.
  // Any IDs that fail (e.g. due to rate limiting) are collected for a retry pass below.
  const failedIds = []

  for (let i = 0; i < allIds.length; i += 20) {
    const batchA = allIds.slice(i, i + 10)
    const batchB = allIds.slice(i + 10, i + 20)

    const [results1, results2] = await Promise.all([fetchBatch(batchA), fetchBatch(batchB)])

    const paired = [
      ...results1.map((r, j) => ({ result: r, id: batchA[j] })),
      ...results2.map((r, j) => ({ result: r, id: batchB[j] })),
    ]

    for (const { result, id } of paired) {
      if (result.status !== 'fulfilled') {
        if (id) failedIds.push(id)
        continue
      }
      processResult(result.value)
    }

    if (onProgress) onProgress(Math.min(i + 20, allIds.length), allIds.length)
    if (onUpdate) onUpdate([...messages])

    if (i + 20 < allIds.length) await sleep(100)
  }

  // Retry pass for anything that failed mid-scan (usually transient rate limits).
  if (failedIds.length > 0) {
    for (let i = 0; i < failedIds.length; i += 10) {
      const batch = failedIds.slice(i, i + 10)
      const results = await fetchBatch(batch)

      for (const result of results) {
        if (result.status !== 'fulfilled') continue // truly unrecoverable — skip
        processResult(result.value)
      }

      if (onUpdate) onUpdate([...messages])
      if (i + 10 < failedIds.length) await sleep(500)
    }
  }

  return messages
}

// Parses a List-Unsubscribe header and returns the best URL to use.
// Header format: "<https://example.com/unsub>, <mailto:unsub@example.com>"
// Prefers HTTP URLs over mailto since they work immediately in a browser.
export function parseUnsubscribeUrl(header) {
  const urls = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1])
  return urls.find((u) => u.startsWith('http')) || urls.find((u) => u.startsWith('mailto')) || null
}

// Returns 'automated' if the unsubscribe page processed silently,
// or 'manual' if it looks like a confirmation form that needs a button click.
// We ask the background service worker to fetch the URL — it has full cross-origin
// read access via host_permissions, unlike fetch() calls from the page itself.
async function fetchUnsubUrl(url) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FETCH_UNSUB', url }, (result) => {
      resolve(result)
    })
  })
}

// Checks the HTML body of an unsubscribe page to decide if it needs manual action.
// Most legitimate services show a plain success message.
// Pages with a <form> usually need the user to click a confirmation button.
function requiresManualAction(body) {
  if (!body) return true
  const lower = body.toLowerCase()
  // A <form> tag usually means there's a submit button the user needs to click.
  if (lower.includes('<form')) return true
  return false
}

// Attempts to unsubscribe from a sender using their List-Unsubscribe header.
// Returns 'automated' if the request was handled silently, or 'manual' if the
// sender's page requires a button click that we can't do automatically.
export async function attemptUnsubscribe(token, unsubHeader) {
  const urls = [...unsubHeader.matchAll(/<([^>]+)>/g)].map((m) => m[1])
  const httpUrl = urls.find((u) => u.startsWith('http'))
  const mailtoUrl = urls.find((u) => u.startsWith('mailto'))

  if (httpUrl) {
    try {
      // Ask the service worker to fetch the URL and return the response body.
      const result = await fetchUnsubUrl(httpUrl)
      if (!result?.ok) return 'manual'
      if (requiresManualAction(result.body)) return 'manual'
      return 'automated'
    } catch {
      return 'manual'
    }
  }

  if (mailtoUrl) {
    // mailto: links need a separate gmail.send scope to automate.
    // Flag as manual so the user can open it themselves.
    return 'manual'
  }

  return 'manual'
}

// Trashes all emails from a specific sender.
// Fetches every matching ID first, then deletes in batches of 10.
// Calls onProgress(deleted, total) after each batch.
// Returns { count, ids } — `ids` is every message that was actually trashed
// successfully, so callers can support Undo (via untrashMessage) afterward.
export async function trashAllFromSender(token, senderEmail, onProgress) {
  const ids = await getAllIds(token, `from:${senderEmail}`)
  const trashedIds = []
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10)
    const results = await Promise.allSettled(batch.map((id) => trashMessage(token, id)))
    batch.forEach((id, j) => { if (results[j].status === 'fulfilled') trashedIds.push(id) })
    if (onProgress) onProgress(i + batch.length, ids.length)
    if (i + 10 < ids.length) await sleep(300)
  }
  return { count: trashedIds.length, ids: trashedIds }
}

// Moves a single message to Trash.
// Gmail keeps trashed emails for 30 days before permanently deleting them.
export function trashMessage(token, id) {
  return fetchWithRetry(`${GMAIL_BASE}/messages/${id}/trash`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

// Reverses trashMessage — takes a message back out of Trash. Gmail restores
// whatever labels it auto-removed when the message was trashed (e.g. INBOX),
// so this is what powers the "Undo" button right after a delete.
export function untrashMessage(token, id) {
  return fetchWithRetry(`${GMAIL_BASE}/messages/${id}/untrash`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

// Archives a single message by removing it from the Inbox.
// The email stays in Gmail (searchable, in All Mail) — it just leaves the inbox.
export function archiveMessage(token, id) {
  return fetchWithRetry(`${GMAIL_BASE}/messages/${id}/modify`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
  })
}

// Reverses archiveMessage — adds the Inbox label back. Powers "Undo" right
// after an Archive action.
export function restoreToInbox(token, id) {
  return fetchWithRetry(`${GMAIL_BASE}/messages/${id}/modify`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ addLabelIds: ['INBOX'] }),
  })
}

// Returns sender, subject, date, and size for a single message.
// `format: "metadata"` skips the full body so the response stays small.
// Uses fetchWithRetry so rate limit errors don't crash the whole search.
export function getMessageMetadata(token, id) {
  const params = new URLSearchParams({ format: 'metadata' })
  params.append('metadataHeaders', 'From')
  params.append('metadataHeaders', 'Subject')
  params.append('metadataHeaders', 'Date')
  return fetchWithRetry(`${GMAIL_BASE}/messages/${id}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}
