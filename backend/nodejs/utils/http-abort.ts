import type { H3Event } from 'h3'

export function requestAbortSignal(event: H3Event): AbortSignal {
  const controller = new AbortController()
  const req = event.node.req
  const res = event.node.res

  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort()
    }
  }

  if (req.aborted || (res.destroyed && !res.writableEnded)) {
    abort()
  }

  req.once('aborted', abort)
  res.once('close', () => {
    if (!res.writableEnded) {
      abort()
    }
  })

  return controller.signal
}
