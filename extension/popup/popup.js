// This file runs every time the popup window opens.
// It ties together the UI (popup.html) and the Gmail API helpers (gmail.js).

const connectBtn = document.getElementById("connectBtn");
const statusEl = document.getElementById("status");
const findBtn = document.getElementById("findBtn");
const emailListEl = document.getElementById("emailList");
const storageIndicatorEl = document.getElementById("storageIndicator");

// Wraps chrome.identity.getAuthToken (a callback-style API) in a Promise,
// which lets us use .then()/.catch() instead of nested callbacks.
// `interactive: true` shows Google's sign-in popup if needed.
// `interactive: false` only returns a token if one is already cached --
// useful for "are we still connected?" checks without bugging the user.
function getToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "No token returned"));
        return;
      }
      resolve(token);
    });
  });
}

connectBtn.addEventListener("click", () => {
  statusEl.textContent = "Connecting...";

  getToken(true)
    .then((token) => fetchProfile(token))
    .catch((error) => {
      statusEl.textContent = "Error: " + error.message;
    });
});

// Uses the access token to ask the Gmail API "who am I?" -- a simple
// read-only call that proves the OAuth setup is working end to end.
function fetchProfile(token) {
  return fetch("https://www.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${token}` },
  })
    .then(handleResponse)
    .then((data) => {
      statusEl.textContent = `Connected as ${data.emailAddress}`;
      // Now that we know we're connected, allow searching.
      findBtn.disabled = false;
    });
}

// Shared response handler (also used by fetchProfile above).
function handleResponse(response) {
  if (!response.ok) {
    throw new Error(`Gmail API error: ${response.status}`);
  }
  return response.json();
}

findBtn.addEventListener("click", () => {
  emailListEl.innerHTML = "";
  storageIndicatorEl.textContent = "";
  findBtn.disabled = true;
  findBtn.textContent = "Searching...";

  // Use a cached token (we already connected via the button above).
  getToken(false)
    .then((token) => {
      return listMessages(token, "larger:5M").then((data) => {
        const matches = data.messages || [];

        if (matches.length === 0) {
          emailListEl.innerHTML = "<li>No emails larger than 5MB found.</li>";
          return;
        }

        // Fetch details for each matching message, in parallel.
        return Promise.all(
          matches.map((m) => getMessageMetadata(token, m.id))
        ).then((messages) => {
          // Add up all the sizes and display the total.
          // sizeEstimate is in bytes, so we divide to get MB.
          const totalBytes = messages.reduce(
            (sum, m) => sum + (m.sizeEstimate || 0),
            0
          );
          const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
          storageIndicatorEl.textContent = `Could free ~${totalMB} MB`;

          messages.forEach(renderMessage);
        });
      });
    })
    .catch((error) => {
      emailListEl.innerHTML = `<li>Error: ${error.message}</li>`;
    })
    .finally(() => {
      findBtn.disabled = false;
      findBtn.textContent = "Find emails over 5MB";
    });
});

// Adds one row to the results list for a given message.
function renderMessage(msg) {
  const headers = msg.payload?.headers || [];
  const getHeader = (name) =>
    headers.find((h) => h.name === name)?.value || "(unknown)";

  const sizeKB = Math.round((msg.sizeEstimate || 0) / 1024);

  const li = document.createElement("li");
  li.textContent = `${getHeader("From")} — ${getHeader("Subject")} (${sizeKB} KB)`;
  emailListEl.appendChild(li);
}
