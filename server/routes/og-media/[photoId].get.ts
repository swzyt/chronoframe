import { getAccessVersion } from '~~/server/utils/og-media'

export default eventHandler(async (event) => {
  const photoId = getRouterParam(event, 'photoId')
  const token = getQuery(event).token
  if (!photoId || typeof token !== 'string') {
    throw createError({ statusCode: 404, statusMessage: 'Image not found' })
  }

  const photo = useDB()
    .select({
      id: tables.photos.id,
      thumbnailKey: tables.photos.thumbnailKey,
    })
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()
  const accessVersion = await getAccessVersion()
  if (
    !photo?.thumbnailKey ||
    !(await verifyOgMediaToken(photo.id, photo.thumbnailKey, token, accessVersion))
  ) {
    throw createError({ statusCode: 404, statusMessage: 'Image not found' })
  }

  const { storageProvider } = useStorageProvider(event)
  const image = await storageProvider.get(photo.thumbnailKey)
  if (!image) {
    throw createError({ statusCode: 404, statusMessage: 'Image not found' })
  }

  setHeader(event, 'Content-Type', 'image/webp')
  setHeader(event, 'Content-Length', String(image.length))
  setHeader(event, 'Cache-Control', 'private, max-age=86400')
  return image
})
