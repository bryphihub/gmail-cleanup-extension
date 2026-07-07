// Small helper functions for talking to the Gmail API.
// Each one takes the OAuth access token and returns a Promise that
// resolves with the parsed JSON response (or throws an error).

const GMAIL_BASE = "https://www.googleapis.com/gmail/v1/users/me";

// Shared error handling: the Gmail API returns a normal HTTP response
// even on failure (e.g. 401, 403, 429), so we check `response.ok`
// ourselves and turn failures into thrown errors.
function handleResponse(response) {
  if (!response.ok) {
    throw new Error(`Gmail API error: ${response.status}`);
  }
  return response.json();
}

// Fetches a page of message IDs matching a Gmail search query.
// `query` uses the same syntax as the Gmail search bar, e.g.
// "larger:5M older_than:1y from:newsletter@example.com".
function listMessages(token, query) {
  const params = new URLSearchParams({
    q: query,
    maxResults: "10", // keep it small for now -- just a sanity check
  });

  return fetch(`${GMAIL_BASE}/messages?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(handleResponse);
}

// Fetches details for a single message: who sent it, the subject,
// the date, and its approximate size (sizeEstimate, in bytes).
// `format: "metadata"` keeps the response small -- we don't need the
// full email body for filtering/listing.
function getMessageMetadata(token, id) {
  const params = new URLSearchParams({ format: "metadata" });
  params.append("metadataHeaders", "From");
  params.append("metadataHeaders", "Subject");
  params.append("metadataHeaders", "Date");

  return fetch(`${GMAIL_BASE}/messages/${id}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(handleResponse);
}
