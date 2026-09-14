import {
  createError,
  defineEventHandler,
  getMethod,
  getProxyRequestHeaders,
  getRequestHeader,
  getRequestURL,
  proxyRequest,
  setHeader,
} from 'h3'
import {
  joinGoUpstreamURL,
  resolveGoRoute,
  resolveGoUpstream,
} from '#server/utils/backend-routing'
import { readBackendProviderForDispatch } from '#server/utils/backend-provider-setting'

/**
 * Node is the public gateway. When the administrator selects Go as the API
 * provider, every explicitly registered Go-capable route is dispatched to the
 * independent Go service. The single setting route that controls this switch
 * remains Node-owned so a stale settings cache can never strand the
 * administrator on a backend that cannot be selected again. Other settings
 * writes are ordinary dual-backend operations.
 */
export default defineEventHandler(async (event) => {
  const requestURL = getRequestURL(event)
  const route = resolveGoRoute(
    getMethod(event),
    requestURL.pathname,
    requestURL.searchParams,
  )
  if (!route) return
  if (
    route.id === 'settings.key.update' &&
    requestURL.pathname === '/api/system/settings/system/backend.readProvider'
  ) {
    return
  }

  const provider = readBackendProviderForDispatch()
  if (provider !== 'go') return

  let upstream: URL | null
  try {
    upstream = resolveGoUpstream()
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: (error as Error).message,
    })
  }
  if (!upstream) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Go backend is not configured',
    })
  }

  const target = joinGoUpstreamURL(
    upstream,
    requestURL.pathname,
    requestURL.search,
  )
  const originalAcceptEncoding = getRequestHeader(event, 'accept-encoding')
  const headers = {
    ...getProxyRequestHeaders(event, { host: false }),
    'x-chronoframe-backend-request': 'go',
    'x-chronoframe-route-id': route.id,
    'x-chronoframe-original-url': requestURL.toString(),
    'x-chronoframe-original-accept-encoding': originalAcceptEncoding || '',
  }

  return proxyRequest(event, target.toString(), {
    headers,
    onResponse(proxyEvent, response) {
      const contentLength = response.headers.get('content-length')
      if (contentLength && !response.headers.has('content-encoding')) {
        setHeader(proxyEvent, 'Content-Length', contentLength)
      }
    },
  })
})
