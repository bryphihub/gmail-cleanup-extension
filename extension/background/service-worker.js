// The "service worker" is a script that runs in the background, separate
// from the popup. It can run even when the popup is closed.
// We'll use it later to handle things like OAuth tokens and Gmail API calls.

// This runs once, the first time the extension is installed (or updated).
chrome.runtime.onInstalled.addListener(() => {
  console.log("Gmail Cleanup extension installed.");
});
