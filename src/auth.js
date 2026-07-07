// auth.js — one shared way to get a Gmail access token.
// "Token" here means a temporary access pass that proves to Google we're allowed
// to read/modify this user's Gmail, without ever handling their password.

// Thrown whenever Gmail won't accept our credentials — either chrome.identity
// couldn't get/refresh a token, or (see gmail.js) the Gmail API itself came
// back with a 401 using a token that looked fine a moment ago. Callers catch
// this specifically so they can show a "Reconnect Gmail" prompt instead of a
// generic error message — the fix is always the same either way: reconnect
// and go through Google's sign-in again.
export class GmailAuthError extends Error {}

// `interactive` — true shows Google's consent popup (only needed the first time,
// or when reconnecting after an expired/revoked token). false tries to get a
// token silently in the background.
export function getToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new GmailAuthError(chrome.runtime.lastError?.message || 'No token'))
        return
      }
      resolve(token)
    })
  })
}
