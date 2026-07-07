// utils.js — small formatting helpers shared across tabs.
// Pulling these out of App.jsx means Search, Subscriptions, and Top Senders
// can all use the same "format a size" logic without copy-pasting it three times.

// Converts raw bytes into a human-readable size string, e.g. 1234567 -> "1.2 MB".
export function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
  if (bytes >= 1024 * 1024)        return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}

// Converts a Unix timestamp (milliseconds) into a human-readable "X ago" string.
export function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days !== 1 ? 's' : ''} ago`
}

// Extracts a display name from a From header like `"Jane Doe" <jane@example.com>`.
// Falls back to the raw header if no display name is present.
export function parseSenderName(fromHeader) {
  const match = fromHeader.match(/^"?([^"<]+?)"?\s*</)
  return match ? match[1].trim() : fromHeader
}

// Used by the drag-to-select lists (Search and Senders): given a scrollable
// container's bounding box and the mouse's current Y position (in viewport
// coordinates), returns how fast that container should auto-scroll while a
// drag-select is in progress and the cursor is near its top or bottom edge —
// negative to scroll up, positive to scroll down, 0 in the middle where no
// auto-scrolling should happen. Speed ramps up smoothly the closer the
// cursor gets to the edge (0 right at `edge` px away, `maxSpeed` once at or
// past the edge itself), rather than snapping straight to full speed.
export function dragScrollSpeed(rect, clientY, { edge = 60, maxSpeed = 18 } = {}) {
  if (clientY < rect.top + edge) {
    const distanceIn = Math.min(edge, Math.max(0, clientY - rect.top))
    return -maxSpeed * (1 - distanceIn / edge)
  }
  if (clientY > rect.bottom - edge) {
    const distanceIn = Math.min(edge, Math.max(0, rect.bottom - clientY))
    return maxSpeed * (1 - distanceIn / edge)
  }
  return 0
}
