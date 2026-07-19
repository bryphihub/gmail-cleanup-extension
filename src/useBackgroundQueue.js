// useBackgroundQueue.js — a tiny, panel-lifetime serial work queue.
//
// Tabs remove rows optimistically, then enqueue the slower Gmail API work
// here. Jobs run one at a time (friendlier to Gmail's rate limits), but React
// stays completely free for searching, selecting, scrolling, and switching
// tabs. The queue lives in App so Search and Top Senders share it.

import { useCallback, useEffect, useRef } from 'react'

export default function useBackgroundQueue() {
  const queuedRef = useRef([])
  const activeRef = useRef(null)
  const drainingRef = useRef(false)
  const mountedRef = useRef(true)

  const drain = useCallback(async () => {
    if (drainingRef.current) return
    drainingRef.current = true

    while (mountedRef.current && queuedRef.current.length > 0) {
      const job = queuedRef.current.shift()
      activeRef.current = job

      if (job.cancelled) {
        job.onCancel?.()
        activeRef.current = null
        continue
      }

      try {
        await job.run({ isCancelled: () => job.cancelled || !mountedRef.current })
      } catch (err) {
        job.onError?.(err)
      } finally {
        if (activeRef.current === job) activeRef.current = null
      }
    }

    drainingRef.current = false
  }, [])

  const enqueueBackgroundAction = useCallback((definition) => {
    const job = { ...definition, cancelled: false }
    queuedRef.current.push(job)
    void drain()

    // Returned for the rare case where a caller needs to cancel just its job.
    return () => { job.cancelled = true }
  }, [drain])

  const cancelBackgroundActions = useCallback(() => {
    // The active job checks this between pages/batches. Queued jobs have not
    // touched Gmail yet, so their optimistic UI can be restored immediately.
    if (activeRef.current) activeRef.current.cancelled = true
    const queued = queuedRef.current.splice(0)
    for (const job of queued) {
      job.cancelled = true
      job.onCancel?.()
    }
  }, [])

  useEffect(() => {
    // React's development Strict Mode intentionally mounts, cleans up, and
    // mounts effects again. Reset this flag on every setup so that safety
    // check cannot leave the real preview queue permanently disabled.
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      if (activeRef.current) activeRef.current.cancelled = true
      queuedRef.current = []
    }
  }, [])

  return { enqueueBackgroundAction, cancelBackgroundActions }
}
