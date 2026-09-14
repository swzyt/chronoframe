export type HTTPByteRangeResult =
  | { type: 'ok'; start: number; end: number }
  | { type: 'invalid' }
  | { type: 'unsatisfiable' }

const byteRangePattern = /^bytes=(\d*)-(\d*)$/

export function parseHTTPByteRange(
  value: string,
  size: number,
): HTTPByteRangeResult {
  if (!Number.isSafeInteger(size) || size < 0) {
    return { type: 'invalid' }
  }

  const match = byteRangePattern.exec(value)
  if (!match || (!match[1] && !match[2])) {
    return { type: 'invalid' }
  }
  if (size === 0) {
    return { type: 'unsatisfiable' }
  }

  if (!match[1]) {
    const suffixLength = parseRangeNumber(match[2])
    if (suffixLength === null || suffixLength <= 0) {
      return { type: 'unsatisfiable' }
    }
    return {
      type: 'ok',
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    }
  }

  const start = parseRangeNumber(match[1])
  const requestedEnd = match[2] ? parseRangeNumber(match[2]) : size - 1
  if (start === null || requestedEnd === null) {
    return { type: 'invalid' }
  }
  if (start >= size || start > requestedEnd) {
    return { type: 'unsatisfiable' }
  }

  return { type: 'ok', start, end: Math.min(requestedEnd, size - 1) }
}

export function shouldServeHTTPByteRange(
  ifRange: string | undefined | null,
  currentETag: string | undefined | null,
  lastModified: Date | undefined | null,
): boolean {
  const value = ifRange?.trim()
  if (!value) return true

  if (value.startsWith('"') || value.startsWith('W/"')) {
    return Boolean(currentETag) && value === currentETag
  }

  const ifRangeTime = parseHTTPDateSeconds(value)
  const lastModifiedTime = httpDateSeconds(lastModified)
  if (ifRangeTime === null || lastModifiedTime === null) {
    return false
  }

  return lastModifiedTime <= ifRangeTime
}

export function isHTTPDateNotModified(
  ifModifiedSince: string | undefined | null,
  lastModified: Date | undefined | null,
): boolean {
  const ifModifiedSinceTime = parseHTTPDateSeconds(ifModifiedSince?.trim())
  const lastModifiedTime = httpDateSeconds(lastModified)
  if (ifModifiedSinceTime === null || lastModifiedTime === null) {
    return false
  }
  return lastModifiedTime <= ifModifiedSinceTime
}

function parseRangeNumber(value: string): number | null {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null
  }
  return parsed
}

function parseHTTPDateSeconds(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return Math.floor(parsed / 1000)
}

function httpDateSeconds(value: Date | undefined | null): number | null {
  const timestamp = value?.getTime()
  if (!Number.isFinite(timestamp)) return null
  return Math.floor(timestamp / 1000)
}
