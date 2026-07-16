# Handoff: Gmail Cleanup Panel (browser extension)

## Overview
A Gmail cleanup side-panel for a browser extension. Two tabs: **Search** (filter emails by size/age/read status/sender, review results, bulk trash/archive) and **Senders** (subscription vs. non-subscription senders, bulk unsubscribe / trash / unsub-&-delete, with a manual-unsubscribe queue). Includes confirm dialogs, undo toast with countdown, animated buttons, and fully custom dropdowns.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, not production code to copy directly. Recreate them in the extension's existing codebase (framework, build setup, and conventions), using its established patterns. `CleanupPanel.dc.html` is the canonical, up-to-date design; the runtime files (`support.js`) are prototype plumbing and should be ignored.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, shadows, animation timings, and copy are final. Recreate pixel-perfectly.

## Design Tokens
Palette ("Porcelain" warm paper + blue accent):
- `--bg` #f6f5f1 (panel background)
- `--card` #fffefb (cards, fields, dropdown panels)
- `--ink` #26231e (primary text)
- `--sub` #6f6a60 (secondary text / labels)
- `--faint` #a8a294 (tertiary/hint text)
- `--line` #e6e2d8 (borders)
- `--chip` #edeae2 (chip/segmented backgrounds)
- `--sel` #e9eff8 (selected/hover blue tint)
- `--accent` #2f6bc4 (accent blue — links, checkmarks, selected states, focus rings)
- `--accent-ink` #ffffff
- `--danger` #a63d2e (danger text/buttons; #b3402f progress bar)
- Warning/manual queue: border #d9a02b, heading #a4770f
- `--radius` 12px, `--radius-sm` 8px
- `--shadow` 0 1px 2px rgba(40,35,25,.06); dropdown panel shadow 0 8px 24px rgba(40,35,25,.16)
- Font: 'Avenir Next','Seravek',system-ui,sans-serif. Base sizes: labels 11px/600, field text 12.5px, buttons 13px/600, section headers 11px uppercase .05em letter-spacing.
- Focus ring (all inputs/dropdown triggers): border-color #2f6bc4 + box-shadow 0 0 0 3px rgba(47,107,196,.55), outline:none.

## Motion System
- **Springy easing** everywhere: `cubic-bezier(.34,1.56,.64,1)`, ~.25s. Hover = slight lift/shadow; active = `scale(.96)` squash.
- **Primary Search / Scan buttons**: gradient blue background with an animated **shader glow** overlay (WebGL canvas, `shader-glow.js`, colors #6bb3f4 → #3775ce) that runs **only on hover** (paused otherwise). Hover shadow 0 4px 12px rgba(43,95,174,.3).
- **Dropdown open**: `gcDdIn` — .16s springy, from opacity 0 / translateY(-4px) scale(.98).
- Phase transitions: slide-in left/right (`gcInL`/`gcInR`, translateX ±22px + fade).
- Undo toast countdown bar: width 100%→0 linear over `undoSeconds` (default 10s).

## Custom Dropdowns (key component)
Native `<select>` replaced everywhere. Anatomy:
- **Trigger**: field-styled button (card bg, 1px `--line` border, radius 8px, padding 9px 34px 9px 10px), custom chevron SVG absolutely positioned 14px from right, blue focus ring. Sort variant is a pill (radius 999px, 11px/600 text, chevron inline).
- **Panel**: absolute, top calc(100%+4px), full trigger width (sort: right-aligned, min-width 150px), card bg, 1px border, radius 8px, shadow 0 8px 24px rgba(40,35,25,.16), 4px padding, `gcDdIn` animation, z-index 40.
- **Option rows**: full-width, padding 8px 10px, radius 6px, transparent bg; **hover follows the mouse** with `--sel` #e9eff8 tint; **selected** option shows a blue checkmark (12px, #2f6bc4) in a fixed 12px lead slot — no persistent tint.
- **Behavior**: click toggles; outside mousedown closes; Esc closes; only one open at a time (single `ddOpen` state key); picking closes.
- Instances: Minimum size, Age, Read status (Search form) + Results sort pill (results list).

## Screens / Views
### Search tab — form phase
Labels (11px/600 `--sub`) over fields, 10px grid gap. Fields: 3 custom dropdowns (above), From text input (same field styling + focus ring, placeholder newsletter@example.com), then the primary **Search** button (gradient + shader glow) and the reassurance line "Searching changes nothing — you choose what to remove." (11px `--faint`, centered). Quick preset chips above.
### Search tab — busy + results phases
Busy: progress state. Results: match summary card, RESULTS header row with sort pill dropdown, Select all/Deselect all text links (accent blue, 11.5px/600), message rows (sender, subject, size, age) with checkboxes and size bars (toggleable), sticky bulk-action bar (n selected · size, Trash, Archive), "Trash all" with animated progress (danger red bar), undo toast.
### Senders tab
Scope/segment controls (Subscriptions vs Others segmented pill on `--chip`), filter chips (older than 1y/6m, unread, large), sender rows (name, count · size, Select/Deselect), bulk actions: Unsubscribe, Trash, Unsub & delete (each with confirm dialog copy in the prototype), manual-unsubscribe queue panel (top border 2px #d9a02b, heading #a4770f) listing senders needing confirmation-page unsubscribe.
### Shared chrome
Header: "Gmail Cleanup" 13px/600 with close ✕. Confirm dialogs: title, body, danger/neutral CTA. Undo toast with countdown bar.

## State Management
- `tab` ('search'|'senders'); search: `sPhase` (form/busy/results), `fSize/fAge/fRead/fFrom`, `msgs`, `msgSel`, `sortM`, `taRun` (trash-all progress); senders: `zPhase`, `scope`, `show` (subs/others), `sortS`, `senders`, `sndSel`, `sndFilters`, `needsManual`; shared: `ddOpen` (which dropdown is open, or null), `confirm`, `toast`.
- Tweakable behavior props: `undoSeconds` (3–15, default 10), `showSizeBars` (bool, default true).

## Interactions & Behavior
- Searching/scanning is non-destructive; destructive actions always confirm first and (where possible) offer undo for `undoSeconds`.
- Unsubscribes are flagged as not undoable in confirm copy.
- Trash-all runs with live "Trashing… n / total" progress and a Stop button.
- Text links (Edit, Clear, Select all, Rescan…) are intentionally static (no motion) — motion marks primary/secondary actions only.

## Assets
No image assets. Chevron/checkmark are inline SVG (stroke round caps/joins). Shader glow is generated (see `shader-glow.js` for the fragment shader colors/timing) — in production, a CSS gradient sheen animation is an acceptable fallback if WebGL is unwanted.

## Screenshots
`screenshots/`: 01 search form · 02 custom dropdown open (checkmark on selected, hover tint follows mouse) · 03 search results with sort pill + selection rail · 04 senders scan form (shader-glow Scan button) · 05 senders results with filter chips and manual-unsub actions.

## Files
- `CleanupPanel.dc.html` — canonical design: full markup, inline styles, and interaction logic (state machine at the bottom of the file).
- `shader-glow.js` — hover glow shader for primary buttons.
- `Gmail Cleanup Redesign.dc.html` — exploration gallery (history of options 1a–7a); reference only, superseded by CleanupPanel.
