import { setHeader, type H3Event } from 'h3'

export function setCookieVaryHeader(event: H3Event) {
  setHeader(event, 'Vary', 'Cookie')
}

export function setPrivateMediaCacheHeaders(
  event: H3Event,
  cacheControl: string,
) {
  setHeader(event, 'Cache-Control', cacheControl)
  setCookieVaryHeader(event)
}
