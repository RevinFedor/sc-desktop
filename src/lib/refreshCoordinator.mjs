// Coalesce refresh storms into one active read plus at most one trailing read.
// A trailing pass is important for correctness: invalidation may arrive while
// the first IPC query is already in flight and represent a newer DB commit.

export function createRefreshCoordinator(pull) {
  let running = null
  let rerun = false

  function request() {
    if (running) {
      rerun = true
      return running
    }
    const current = (async () => {
      do {
        rerun = false
        await pull()
      } while (rerun)
    })()
    running = current
    current.then(() => {
      if (running === current) running = null
    }, () => {
      if (running === current) running = null
    })
    return current
  }

  return {
    request,
    isRunning: () => running != null,
  }
}
