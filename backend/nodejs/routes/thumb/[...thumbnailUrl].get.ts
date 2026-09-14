import sharp from 'sharp'
import {
  setCookieVaryHeader,
  setPrivateMediaCacheHeaders,
} from '#server/utils/media-cache'

export default eventHandler(async (event) => {
  const { storageProvider } = useStorageProvider(event)

  const encodedUrl = getRouterParam(event, 'thumbnailUrl')

  if (!encodedUrl) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid thumbnailUrl',
    })
  }
  setCookieVaryHeader(event)

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
  const thumbnail = await sharpInst.jpeg({ quality: 85 }).toBuffer()
  setHeader(event, 'Content-Type', 'image/jpeg')
  setHeader(event, 'Content-Length', String(thumbnail.length))
  setPrivateMediaCacheHeaders(event, 'private, max-age=86400')
  return thumbnail
})
