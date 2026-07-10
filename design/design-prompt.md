# Redesign prompt — Gmail Cleanup extension UI

I've attached screenshots of the current UI and some inspiration references. Please use them alongside this brief.

## What this is

A Chrome extension (Manifest V3) that helps people find and bulk-delete or archive storage-heavy emails from their Gmail inbox. It's entirely client-side — no backend, no accounts beyond the user's own Gmail login. The UI is a panel injected into the Gmail page (not a full browser tab), built with React and Tailwind CSS.

I originally built this for myself, but I'm now planning for other people to install and use it — so the design should feel trustworthy and approachable to someone who has never seen it before, not just usable to me.

## Where it lives — screen constraints

This is not a normal webpage. It's a fixed panel docked to the right edge of the browser window, on top of Gmail: **400px wide, full window height (100vh)** — it pushes Gmail's own content narrower rather than overlapping it. That width is fixed regardless of the user's screen size or window size; only the height changes (whatever the browser window's height happens to be). Attached screenshots show its actual current rendered look. Any redesign needs to work within that same fixed 400px-wide, full-height vertical strip — a beautiful layout that assumes a wide desktop viewport won't translate here.

## What must stay the same (locked-in behavior)

These are interaction patterns I've deliberately built and like — please preserve the underlying behavior even if the visual style around them changes:

- **Two tabs: Search and Senders.** Search lets someone filter/search for emails and act on the results directly. Senders scans the whole inbox (or all mail) and groups results by sender, for spotting subscriptions and repeat offenders.
- **Confirmation before any delete.** Every destructive action (trash, archive, unsubscribe, bulk actions) requires an explicit "yes, confirm" step before it fires. No one-click deletes. This is a hard requirement, not just a style choice — it exists to prevent accidental data loss.
- **Drag-to-select rail.** Instead of plain checkboxes, each row has a small vertical rail + bead that can be dragged up or down to select/deselect a range of rows at once, similar to a slider. This should stay functionally intact, though its visual styling is open to reinterpretation.
- **The Undo toast.** After any delete/archive/undo-able action, a toast appears at the bottom of the panel for a short time with an "Undo" option, then disappears on its own. Keep this pattern — timing and visual treatment can evolve.

## What's genuinely open

Everything else — layout, color palette, typography, spacing, iconography, how filters/search results are presented, progress/loading states, empty states, and the overall visual identity — is fair game. I like the current interaction model, but I'm open to suggestions on how the visual design and even minor interaction details (like exact placement of controls) could be improved, as long as the four locked-in behaviors above still work the same way underneath.

## Tone / audience

Design for someone installing this for the first time with no prior context: clear labeling, low-jargon copy, and an interface that reads as safe and trustworthy for something that can permanently move or delete emails. Avoid anything that feels like a "hacky developer tool" — this should feel like a small, polished consumer product.

## What I'd like back

- A visual direction (color palette, type, general mood) with rationale for why it fits a tool people trust with their email.
- Mockups for both tabs — Search and Senders — including their key states: empty/first-load, results loaded, an item selected, the confirmation prompt, and the Undo toast visible.
- Notes on anything you think should change about the interaction details (not the four locked-in behaviors themselves), since I'm open to that kind of feedback.
