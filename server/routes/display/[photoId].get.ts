import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { generateDisplayImage } from '~~/server/services/image/thumbnail'
import { preprocessImageBuffer } from '~~/server/services/image/processor'

const displayImageKey = (ownerUserId: number, photoId: string) =>
  `display/${ownerUserId}/${photoId}.webp`

const canManagePhoto = async (
  event: H3Event,
  photo: typeof tables.photos.$inferSelect,
) => {
  const session = await getUserSession(event)
  const sessionUserId = session.user?.id
  if (!sessionUserId) return false

  const user = useDB()
    .select({
      id: tables.users.id,
      isAdmin: tables.users.isAdmin,
      isActive: tables.users.isActive,
    })
    .from(tables.users)
    .where(eq(tables.users.id, sessionUserId))
    .get()

  if (!user?.isActive) {
    await clearUserSession(event)
    return false
  }

  return Boolean(user.isAdmin || user.id === photo.ownerUserId)
}

const requireDisplayPhotoAccess = async (
  event: H3Event,
  photo: typeof tables.photos.$inferSelect,
) => {
  if (await canManagePhoto(event, photo)) return

  if (!(await isPublicPhoto(photo.id))) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  await requirePublicPhotoAccess(event, photo.id)
}

const serveDisplayBuffer = (
  event: H3Event,
  photoId: string,
  buffer: Buffer,
) => {
  const etag = `W/"display-${photoId}-${buffer.length}"`
  setHeader(event, 'Content-Type', 'image/webp')
  setHeader(event, 'Cache-Control', 'private, max-age=604800')
  setHeader(event, 'ETag', etag)

  if (getHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304)
    return
  }

  setHeader(event, 'Content-Length', String(buffer.length))
  return buffer
}

const serveDisplayStream = (
  event: H3Event,
  photoId: string,
  size: number,
  stream: NodeJS.ReadableStream,
) => {
  const etag = `W/"display-${photoId}-${size}"`
  setHeader(event, 'Content-Type', 'image/webp')
  setHeader(event, 'Cache-Control', 'private, max-age=604800')
  setHeader(event, 'ETag', etag)

  if (getHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304)
    return
  }

  setHeader(event, 'Content-Length', String(size))
  return sendStream(event, stream)
}

export default eventHandler(async (event) => {
  const photoId = getRouterParam(event, 'photoId')
  if (!photoId) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid photo id' })
  }

  const db = useDB()
  const photo = db
    .select()
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()

  if (!photo || photo.mediaType === 'video') {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  await requireDisplayPhotoAccess(event, photo)

  const { storageProvider } = useStorageProvider(event)

  if (photo.displayKey) {
    const meta = await storageProvider.getFileMeta(photo.displayKey)
    const stream = meta?.size
      ? await storageProvider.getStream?.(photo.displayKey)
      : null
    if (meta?.size && stream) {
      return serveDisplayStream(event, photo.id, meta.size, stream)
    }

    const displayBuffer = await storageProvider.get(photo.displayKey)
    if (displayBuffer) {
      return serveDisplayBuffer(event, photo.id, displayBuffer)
    }
  }

  if (!photo.storageKey) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Photo file not found',
    })
  }

  const originalBuffer = await storageProvider.get(photo.storageKey)
  if (!originalBuffer) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Photo file not found',
    })
  }

  const processedBuffer = await preprocessImageBuffer(
    originalBuffer,
    photo.storageKey,
  )
  const displayBuffer = await generateDisplayImage(
    processedBuffer,
    logger.image,
  )
  const key = displayImageKey(photo.ownerUserId, photo.id)
  const displayObject = await storageProvider.create(
    key,
    displayBuffer,
    'image/webp',
  )

  db.update(tables.photos)
    .set({ displayKey: displayObject.key })
    .where(eq(tables.photos.id, photo.id))
    .run()

  return serveDisplayBuffer(event, photo.id, displayBuffer)
})
