export default eventHandler(async (event) => {
  const { storageProvider } = useStorageProvider(event)
  const key = getRouterParam(event, 'key')

  if (!key) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid key' })
  }

  const normalizedKey = decodeURIComponent(key).replace(/^\/+/, '')
  const mediaPhoto = findPhotoByMediaKey(normalizedKey)
  if (!mediaPhoto) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }
  await requirePublicPhotoAccess(event, mediaPhoto.id)

  const ext = normalizedKey.split('.').pop()?.toLowerCase()
  const contentTypes: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
  }
  setHeader(
    event,
    'Content-Type',
    contentTypes[ext || ''] || 'application/octet-stream',
  )
  setHeader(event, 'Accept-Ranges', 'bytes')
  setHeader(event, 'Cache-Control', 'private, max-age=86400')

  const meta = await storageProvider.getFileMeta(normalizedKey)
  const range = getHeader(event, 'range')

  if (meta?.size && range) {
    const etag = `W/"${meta.size}-${encodeURIComponent(normalizedKey)}"`
    setHeader(event, 'ETag', etag)
    if (getHeader(event, 'if-none-match') === etag) {
      setResponseStatus(event, 304)
      return
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match) {
      throw createError({ statusCode: 416, statusMessage: 'Invalid range' })
    }

    const size = meta.size
    const start = match[1] ? Number(match[1]) : 0
    const end = match[2] ? Number(match[2]) : size - 1
    if (start > end || end >= size) {
      setHeader(event, 'Content-Range', `bytes */${size}`)
      throw createError({
        statusCode: 416,
        statusMessage: 'Range not satisfiable',
      })
    }

    const chunk =
      (await storageProvider.getRange?.(normalizedKey, start, end)) ||
      (await storageProvider.get(normalizedKey))?.subarray(start, end + 1) ||
      (await getLegacyLocalMedia(normalizedKey))?.subarray(start, end + 1)

    if (!chunk) {
      throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
    }

    setResponseStatus(event, 206)
    setHeader(event, 'Content-Range', `bytes ${start}-${end}/${size}`)
    setHeader(event, 'Content-Length', String(chunk.length))
    logger.chrono.info('Serve image range from key', normalizedKey)
    return chunk
  }

  const photo =
    (await storageProvider.get(normalizedKey)) ||
    (await getLegacyLocalMedia(normalizedKey))
  if (!photo) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  const etag = `W/"${photo.length}-${encodeURIComponent(normalizedKey)}"`
  setHeader(event, 'ETag', etag)
  if (getHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304)
    return
  }

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match) {
      throw createError({ statusCode: 416, statusMessage: 'Invalid range' })
    }
    const start = match[1] ? Number(match[1]) : 0
    const end = match[2] ? Number(match[2]) : photo.length - 1
    if (start > end || end >= photo.length) {
      setHeader(event, 'Content-Range', `bytes */${photo.length}`)
      throw createError({
        statusCode: 416,
        statusMessage: 'Range not satisfiable',
      })
    }
    setResponseStatus(event, 206)
    setHeader(event, 'Content-Range', `bytes ${start}-${end}/${photo.length}`)
    setHeader(event, 'Content-Length', String(end - start + 1))
    return photo.subarray(start, end + 1)
  }
  setHeader(event, 'Content-Length', String(photo.length))
  logger.chrono.info('Serve image from key', normalizedKey)
  return photo
})
