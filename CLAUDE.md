# Project context for Claude Code

This project was built collaboratively with Claude across many chat sessions (in Cowork/desktop
mode, not Claude Code). This file captures context, decisions, and conventions that live in
those conversations but aren't otherwise written down anywhere in the code or comments. Read
this before making changes.

## About the person you're working with

I have no prior coding experience — I'm learning as I build this. Please:
- Assume I'm starting from zero on any new concept. Give a one-line plain-English explanation
  before diving into code.
- Break work into small, clearly labeled steps rather than doing everything at once.
- Add short inline comments explaining what each section of code does.
- If something could be done multiple ways, briefly explain the tradeoff and recommend one.
- If my request is ambiguous, ask a clarifying question before proceeding.
- Warn me first if I'm about to do something that could break things or is hard to undo.

## What this project is

A Chrome extension (Manifest V3) that helps find and bulk-delete/archive storage-heavy emails
from Gmail. Entirely client-side — no backend, no accounts beyond the user's own Gmail OAuth
login. Built with React + Tailwind for the UI, vanilla JS for the background service worker.

## How the UI actually renders (not obvious from the code alone)

The popup UI is NOT a normal browser-action popup. `public/content/content.js` injects a fixed
panel directly into the Gmail page: **400px wide, full window height (100vh), docked to the
right edge** — it narrows Gmail's own layout rather than overlapping it. The React app
(`src/App.jsx` etc.) is built by Vite into `dist/` and loaded inside that injected panel via an
iframe. A `postMessage` bridge connects the iframe (React app) to the content script for actions
like opening an email, opening a search, opening an external URL, and closing the panel
(`OPEN_EMAIL`, `OPEN_SEARCH`, `OPEN_URL`, `CLOSE_PANEL`).

**Any UI redesign work must respect that 400px-wide, full-height constraint** — it's a narrow
vertical strip, not a normal webpage viewport.

## Locked-in interaction behavior — do not remove without asking

These were built deliberately over many iterations and should be preserved even if visual
styling changes:

- **Two tabs: Search and Senders.** Search filters/searches and acts on results directly.
  Senders scans the whole inbox (or all mail) and groups by sender, for spotting subscriptions
  and repeat offenders.
- **Confirmation before every destructive action.** Trash, archive, unsubscribe, and all bulk
  variants require an explicit "Yes, confirm" step before firing. This is a hard requirement to
  prevent accidental data loss, not just a style choice.
- **Drag-to-select rail.** Rows use a small vertical rail + draggable bead (not a plain
  checkbox) that can be dragged up/down to select/deselect a range at once, similar to a
  slider. Includes auto-scroll near the top/bottom edge of the list while dragging, which speeds
  up the closer the cursor gets to the edge (see `dragScrollSpeed` in `src/utils.js`).
- **The Undo toast.** Lives in `src/App.jsx` (not per-tab) so it appears as one consistent
  bottom-of-panel toast regardless of which tab the action happened in. Tabs report completed
  actions up via an `onAction(type, ids, restoreLocal)` prop; App.jsx owns the actual
  untrash/restore API calls and the toast UI, then calls the tab's `restoreLocal` callback so
  the removed rows visibly reappear in that tab's list — Undo should never just work silently
  on Gmail's side without the UI reflecting it.

## Other conventions to keep

- **Trash over permanent delete**, always, unless explicitly told otherwise.
- **Minimum necessary Gmail API scopes/permissions.**
- **Always handle API errors** — assume any Gmail API call can fail or hit a rate limit.
  `src/gmail.js`'s `fetchWithRetry` already handles 429/403 rate-limit retries with exponential
  backoff; a 401 throws a `GmailAuthError` (defined in `src/auth.js`) specifically so the UI can
  show a "Reconnect Gmail" prompt instead of a raw error message (see `App.jsx`'s
  `needsReconnect` state).
- **Keep files small and focused** — one job per file (this is why FilterPanel, SearchTab,
  SendersTab, gmail.js, auth.js, utils.js are all separate).

## Current state / where things stand

- The extension is functional and has been in active daily use.
- Git is set up and the repo is pushed to GitHub:
  `https://github.com/bryphihub/gmail-cleanup-extension.git`
- **The project folder was moved from `~/Claude/Projects/Clean Gmail` to
  `~/Desktop/Clean Gmail` on 2026-07-08.** If `chrome://extensions` shows an error on this
  extension, it's likely still pointing at the old path — remove it and "Load unpacked" again
  pointing at this folder's `dist/` directory.
- I'm currently working on a visual redesign of the UI (not the interaction model — see the
  locked-in behaviors above) to make it feel more polished/trustworthy, since I'm now planning
  for other people to install this, not just using it myself. I've been using a separate design
  tool for visual inspiration/mockups before bringing changes here for implementation. See
  `design-prompt.md` in this folder for the brief I gave that tool, which has more detail on the
  visual-design goals and constraints.
- Build note: earlier work happened inside a sandboxed cloud environment (not this machine)
  where the checked-in `node_modules` (built for macOS) didn't run on Linux, requiring a
  workaround of building in a temp copy elsewhere. **That workaround does not apply here** —
  running `npm install` and `npm run build` (or `vite build`) directly in this folder on this
  Mac should work normally.
