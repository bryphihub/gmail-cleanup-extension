# Gmail Cleanup Extension — Build Plan

This plan breaks the project into small, ordered steps. Each step produces something that
runs or can be tested before moving to the next. We won't jump ahead — finish a step,
see it work, then continue.

## Phase 0 — Setup
1. **Project scaffold**: Create the folder structure (`/popup`, `/background`, `/content`,
   `/assets`) and a minimal `manifest.json` so Chrome can load the extension as an
   "unpacked extension" (a folder you point Chrome at directly, no Chrome Web Store needed).
2. **Sanity check**: Load the extension in Chrome (`chrome://extensions` → Developer
   mode → Load unpacked) and confirm the icon shows up and the popup opens (even if empty).

## Phase 1 — Google OAuth (sign in to Gmail)
3. **Google Cloud setup** (manual steps you'll do, with my guidance): create a Google Cloud
   project, enable the Gmail API, create OAuth credentials, and request only the minimal
   scope needed (e.g. `gmail.modify` for trashing/archiving — not full account access).
4. **OAuth flow in the extension**: use Chrome's `identity` API (built into MV3) to get an
   access token. Add a "Connect Gmail" button in the popup.
5. **Sanity check**: click "Connect Gmail", approve the consent screen, and confirm we can
   fetch the user's email address from the Gmail API as proof the token works.

## Phase 2 — Reading emails
6. **Fetch message list**: call the Gmail API to list messages, with support for filters
   (size, age/date, sender, label, read/unread).
7. **Fetch message details**: for each message, get size, date, sender, subject, snippet.
8. **Storage usage indicator**: sum up sizes of matching messages and show "You could free
   up X MB" in the popup.
9. **Sanity check**: filter by something simple (e.g. "older than 1 year") and confirm the
   list and total size look correct against what you see in Gmail's web UI.

## Phase 3 — Display & selection UI
10. **Results list**: React component showing each email (sender, subject, date, size) with
    a checkbox.
11. **Bulk select controls**: "select all", "select none", running total of size selected.
12. **Sanity check**: select a few emails and confirm the count/size totals update correctly.

## Phase 4 — Bulk actions
13. **Archive action**: remove the `INBOX` label from selected messages via batch API call.
14. **Trash action** (default; permanent delete only if you explicitly ask later): move
    selected messages to Trash via batch API call.
15. **Confirmation dialog**: before any trash/archive action, show a summary ("Move 42
    emails to Trash, freeing ~120 MB?") and require explicit confirmation.
16. **Error handling**: handle API failures, rate limits, and partial batch failures
    gracefully (show what succeeded/failed).
17. **Sanity check**: test trash/archive on a small batch (2-3 emails) first, confirm in
    Gmail web UI they moved correctly, before trying larger batches.

## Phase 5 — Polish
18. **Loading states & empty states** in the popup UI.
19. **Persist filter preferences** (e.g. last-used filters) using `chrome.storage.local`.
20. **Icon/branding** for the extension.

---

## Notes
- We'll do one numbered step at a time. I'll explain new concepts in plain English before
  showing code, and keep files small and focused.
- Anything destructive (trash, archive) always gets a confirmation step — no exceptions.
- We'll only request the Gmail scopes we actually need, reviewed at step 3.
