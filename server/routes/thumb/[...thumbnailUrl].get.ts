import sharp from 'sharp'

export default eventHandler(async (event) => {
  const { storageProvider } = useStorageProvider(event)

  const encodedUrl = getRouterParam(event, 'thumbnailUrl')

  if (!encodedUrl) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid thumbnailUrl',
    })
  }

  const url = decodeURIComponent(encodedUrl)
  let key =
    url.startsWith('/image/') || url.startsWith('/storage/')
      ? decodeURIComponent(url.replace(/^\/(?:image|storage)\//, ''))
      : null
  const photo = key ? findPhotoByMediaKey(key) : findPhotoByMediaUrl(url)
  key ||= photo?.thumbnailKey || photo?.storageKey || null

  if (!photo || !key) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }
  await requirePublicPhotoAccess(event, photo.id)

  const source = await storageProvider.get(key)
  if (!source) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  const sharpInst = sharp(source).rotate()
  return await sharpInst.jpeg({ quality: 85 }).toBuffer()
})
