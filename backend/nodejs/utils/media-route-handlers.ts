import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import {
  createError,
  getHeader,
  getMethod,
  getRouterParam,
  sendStream,
  setHeader,
  setResponseStatus,
  type H3Event,
} from 'h3'
import type { StorageProvider } from '#server/services/storage'
import { getStorageManager } from '#server/plugins/3.storage'
import { requestAbortSignal } from '#server/utils/http-abort'
import { getLegacyLocalMedia } from '#server/utils/legacy-local-media'
import { logger } from '#server/utils/logger'
import {
  isHTTPDateNotModified,
  parseHTTPByteRange,
  shouldServeHTTPByteRange,
} from '#server/utils/http-range'
import {
  findPhotoByMediaKey,
  isOriginalImageMediaKey,
  requireOriginalImageMediaAccess,
} from '#server/utils/queue-authz'
import {
  setCookieVaryHeader,
  setPrivateMediaCacheHeaders,
} from '#server/utils/media-cache'
import { requirePublicPhotoAccess } from '#server/utils/preview-access'
import { useStorageProvider } from '#server/utils/useStorageProvider'

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
}

const isHeadRequest = (event: H3Event) =>
  getMethod(event).toUpperCase() === 'HEAD'

const guessContentType = (filePath: string): string => {
  const ext = (filePath.split('.').pop() || '').toLowerCase()
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    case 'tif':
    case 'tiff':
      return 'image/tiff'
    case 'mp4':
      return 'video/mp4'
    case 'mov':
      return 'video/quicktime'
    case 'json':
      return 'application/json'
    default:
      return 'application/octet-stream'
  }
}

export async function handleImageMediaRequest(event: H3Event) {
  const { storageProvider } = useStorageProvider(event)
  const key = getRouterParam(event, 'key')

  if (!key) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid key' })
  }

  const normalizedKey = decodeURIComponent(key).replace(/^\/+/, '')
  setCookieVaryHeader(event)
  const abortSignal = requestAbortSignal(event)
  const mediaPhoto = findPhotoByMediaKey(normalizedKey)
  if (!mediaPhoto) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }
  await requirePublicPhotoAccess(event, mediaPhoto.id)
  if (isOriginalImageMediaKey(mediaPhoto, normalizedKey)) {
    await requireOriginalImageMediaAccess(event)
  }

  return serveProviderMedia(
    event,
    storageProvider,
    normalizedKey,
    abortSignal,
    'Photo not found',
    true,
  )
}

async function serveProviderMedia(
  event: H3Event,
  storageProvider: StorageProvider,
  normalizedKey: string,
  abortSignal: AbortSignal,
  notFoundMessage: string,
  allowLegacyLocalFallback: boolean,
) {
  const ext = normalizedKey.split('.').pop()?.toLowerCase()
  setHeader(
    event,
    'Content-Type',
    IMAGE_CONTENT_TYPES[ext || ''] || 'application/octet-stream',
  )
  setHeader(event, 'Accept-Ranges', 'bytes')
  setPrivateMediaCacheHeaders(event, 'private, max-age=86400')

  const isHead = isHeadRequest(event)
  const meta = await storageProvider.getFileMeta(normalizedKey, {
    signal: abortSignal,
  })
  const metaSize = typeof meta?.size === 'number' ? meta.size : undefined
  const lastModified = meta?.lastModified
  const range = getHeader(event, 'range')
  let etag: string | undefined

  if (typeof metaSize === 'number') {
    etag = `W/"${metaSize}-${encodeURIComponent(normalizedKey)}"`
    setHeader(event, 'ETag', etag)
    if (lastModified) {
      setHeader(event, 'Last-Modified', lastModified.toUTCString())
    }
    if (getHeader(event, 'if-none-match') === etag) {
      setResponseStatus(event, 304)
      return null
    }
    if (
      isHTTPDateNotModified(getHeader(event, 'if-modified-since'), lastModified)
    ) {
      setResponseStatus(event, 304)
      return null
    }
  }
  const serveRange = shouldServeHTTPByteRange(
    getHeader(event, 'if-range'),
    etag,
    lastModified,
  )

  if (typeof metaSize === 'number' && range && serveRange) {
    const parsedRange = parseHTTPByteRange(range, metaSize)
    if (parsedRange.type !== 'ok') {
      setHeader(event, 'Content-Range', `bytes */${metaSize}`)
      throw createError({
        statusCode: 416,
        statusMessage:
          parsedRange.type === 'invalid'
            ? 'Invalid range'
            : 'Range not satisfiable',
      })
    }
    const { start, end } = parsedRange

    setResponseStatus(event, 206)
    setHeader(event, 'Content-Range', `bytes ${start}-${end}/${metaSize}`)
    setHeader(event, 'Content-Length', String(end - start + 1))
    if (isHead) {
      return ''
    }

    const stream = await storageProvider.getRangeStream?.(
      normalizedKey,
      start,
      end,
      { signal: abortSignal },
    )
    if (stream) {
      logger.chrono.info('Serve image range stream from key', normalizedKey)
      return sendStream(event, stream)
    }

    const chunk =
      (await storageProvider.getRange?.(normalizedKey, start, end, {
        signal: abortSignal,
      })) ||
      (
        await storageProvider.get(normalizedKey, { signal: abortSignal })
      )?.subarray(start, end + 1) ||
      (allowLegacyLocalFallback
        ? (await getLegacyLocalMedia(normalizedKey))?.subarray(start, end + 1)
        : null)

    if (!chunk) {
      throw createError({ statusCode: 404, statusMessage: notFoundMessage })
    }

    logger.chrono.info('Serve image range from key', normalizedKey)
    return chunk
  }

  if (typeof metaSize === 'number') {
    setHeader(event, 'Content-Length', String(metaSize))
    if (isHead) {
      setResponseStatus(event, 200)
      return ''
    }
    const stream = await storageProvider.getStream?.(normalizedKey, {
      signal: abortSignal,
    })
    if (stream) {
      logger.chrono.info('Serve image stream from key', normalizedKey)
      return sendStream(event, stream)
    }
  }

  const photo =
    (await storageProvider.get(normalizedKey, { signal: abortSignal })) ||
    (allowLegacyLocalFallback ? await getLegacyLocalMedia(normalizedKey) : null)
  if (!photo) {
    throw createError({ statusCode: 404, statusMessage: notFoundMessage })
  }

  const fallbackETag = `W/"${photo.length}-${encodeURIComponent(normalizedKey)}"`
  setHeader(event, 'ETag', fallbackETag)
  if (getHeader(event, 'if-none-match') === fallbackETag) {
    setResponseStatus(event, 304)
    return null
  }

  if (range && serveRange) {
    const parsedRange = parseHTTPByteRange(range, photo.length)
    if (parsedRange.type !== 'ok') {
      setHeader(event, 'Content-Range', `bytes */${photo.length}`)
      throw createError({
        statusCode: 416,
        statusMessage:
          parsedRange.type === 'invalid'
            ? 'Invalid range'
            : 'Range not satisfiable',
      })
    }
    const { start, end } = parsedRange
    setResponseStatus(event, 206)
    setHeader(event, 'Content-Range', `bytes ${start}-${end}/${photo.length}`)
    setHeader(event, 'Content-Length', String(end - start + 1))
    if (isHead) {
      return ''
    }
    return photo.subarray(start, end + 1)
  }
  setHeader(event, 'Content-Length', String(photo.length))
  if (isHead) {
    setResponseStatus(event, 200)
    return ''
  }
  logger.chrono.info('Serve image from key', normalizedKey)
  return photo
}

export async function handleStorageMediaRequest(event: H3Event) {
  const manager = getStorageManager()
  const provider = manager.getProvider()

  const p = getRouterParam(event, 'path') || ''
  const relPathRaw = Array.isArray(p) ? p.join('/') : p
  const decodedPath = decodeURIComponent(relPathRaw)
  const relPath = decodedPath
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')

  if (relPath.includes('..')) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid path' })
  }

  setCookieVaryHeader(event)
  const abortSignal = requestAbortSignal(event)
  const mediaPhoto = findPhotoByMediaKey(relPath)
  if (!mediaPhoto) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  await requirePublicPhotoAccess(event, mediaPhoto.id)
  if (isOriginalImageMediaKey(mediaPhoto, relPath)) {
    await requireOriginalImageMediaAccess(event)
  }

  if ((provider as any).config?.provider !== 'local') {
    return serveProviderMedia(
      event,
      provider,
      relPath,
      abortSignal,
      'Not Found',
      false,
    )
  }

  const basePath = (provider as any).config.basePath as string
  const absolute = path.resolve(basePath, relPath)

  if (!absolute.startsWith(path.resolve(basePath) + path.sep)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid path' })
  }

  let stat
  try {
    stat = await fs.stat(absolute)
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  if (!stat.isFile()) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  const etag = `W/"${stat.size}-${stat.mtimeMs}"`
  setHeader(event, 'ETag', etag)
  setHeader(event, 'Last-Modified', stat.mtime.toUTCString())
  setPrivateMediaCacheHeaders(event, 'private, max-age=86400')
  setHeader(event, 'Content-Type', guessContentType(absolute))
  setHeader(event, 'Accept-Ranges', 'bytes')

  const inm = getHeader(event, 'if-none-match')
  const ims = getHeader(event, 'if-modified-since')
  if (inm === etag || isHTTPDateNotModified(ims, stat.mtime)) {
    setResponseStatus(event, 304)
    return null
  }

  const isHead = isHeadRequest(event)
  const range = getHeader(event, 'range')
  const serveRange = shouldServeHTTPByteRange(
    getHeader(event, 'if-range'),
    etag,
    stat.mtime,
  )
  if (range && serveRange) {
    const parsedRange = parseHTTPByteRange(range, stat.size)
    if (parsedRange.type !== 'ok') {
      setHeader(event, 'Content-Range', `bytes */${stat.size}`)
      throw createError({
        statusCode: 416,
        statusMessage:
          parsedRange.type === 'invalid'
            ? 'Invalid range'
            : 'Range not satisfiable',
      })
    }
    const { start, end } = parsedRange
    setResponseStatus(event, 206)
    setHeader(event, 'Content-Range', `bytes ${start}-${end}/${stat.size}`)
    setHeader(event, 'Content-Length', String(end - start + 1))
    if (isHead) {
      return ''
    }
    const stream = createReadStream(absolute, {
      start,
      end,
      signal: abortSignal,
    })
    return sendStream(event, stream)
  }

  setHeader(event, 'Content-Length', String(stat.size))
  if (isHead) {
    setResponseStatus(event, 200)
    return ''
  }
  const stream = createReadStream(absolute, { signal: abortSignal })
  return sendStream(event, stream)
}
