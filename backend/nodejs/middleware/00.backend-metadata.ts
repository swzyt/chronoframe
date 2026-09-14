import {
  resolveBackendMode,
  resolveNodeMaturity,
  resolveRequestId,
} from '#server/utils/backend-metadata'

export default defineEventHandler((event) => {
  const requestId = resolveRequestId(getHeader(event, 'x-request-id'))
  event.context.requestId = requestId

  setResponseHeader(event, 'X-Request-Id', requestId)
  setResponseHeader(event, 'X-ChronoFrame-Backend', 'node')
  setResponseHeader(
    event,
    'X-ChronoFrame-Backend-Version',
    process.env.CFRAME_BACKEND_VERSION || 'dev',
  )
  setResponseHeader(
    event,
    'X-ChronoFrame-Maturity',
    resolveNodeMaturity(process.env.CFRAME_NODE_MATURITY),
  )
  setResponseHeader(
    event,
    'X-ChronoFrame-Mode',
    resolveBackendMode(process.env.CFRAME_BACKEND_MODE),
  )
})
