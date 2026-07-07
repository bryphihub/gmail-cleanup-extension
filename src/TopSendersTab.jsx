// TopSendersTab.jsx — no longer used.
//
// Subscriptions and Top Senders were merged into one "Senders" tab, since
// most subscription senders were also showing up as top senders — two tabs
// telling the user almost the same thing. See SendersTab.jsx, which now
// handles both jobs: it scans once, tags each sender as a "subscription" if
// they ever send a List-Unsubscribe header, and lets a "Show" toggle switch
// between all senders / non-subscriptions / subscriptions only — all without
// a second scan. The age/unread/size filters are also client-side there now,
// so switching them doesn't rescan either — only "Where to look" (scope) does.
