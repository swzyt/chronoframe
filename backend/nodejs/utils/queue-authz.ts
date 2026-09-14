import { and, eq, or } from 'drizzle-orm'
import type { H3Event } from 'h3'
import type { User } from './db'

type QueuePayload =
  | { type: 'photo'; storageKey: string }
  | { type: 'live-photo-video'; storageKey: string }
  | { type: 'video'; storageKey: string }
  | { type: 'photo-reverse-geocoding'; photoId: string }
  | { type: 'photo-erase-location'; photoId: string }

function normalizeStorageKey(key: string) {
  return key.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

export function isUserStorageKey(
  event: H3Event,
  userId: number,
  storageKey: string,
) {
  const { storageProvider } = useStorageProvider(event)
  const prefix =
    storageProvider.config && 'prefix' in storageProvider.config
      ? String(storageProvider.config.prefix || '')
          .replace(/^\/+/, '')
          .replace(/\/+$/, '')
      : ''
  const userPrefix = [prefix, 'users', String(userId)].filter(Boolean).join('/')
  const normalizedKey = normalizeStorageKey(storageKey)
  return normalizedKey.startsWith(`${userPrefix}/`)
}

export async function requireQueuePayloadAccess(
  event: H3Event,
  user: User,
  payload: QueuePayload,
) {
  if (user.isAdmin) return

  if ('photoId' in payload) {
    const photo = useDB()
      .select({ id: tables.photos.id })
      .from(tables.photos)
      .where(
        and(
          eq(tables.photos.id, payload.photoId),
          eq(tables.photos.ownerUserId, user.id),
        ),
      )
      .get()
    if (!photo) {
      throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
    }
    return
  }

  if (!isUserStorageKey(event, user.id, payload.storageKey)) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Storage object not found',
    })
  }
}

export function findPhotoByMediaKey(storageKey: string) {
  const normalizedKey = normalizeStorageKey(storageKey)
  return useDB()
    .select()
    .from(tables.photos)
    .where(
      or(
        eq(tables.photos.storageKey, normalizedKey),
        eq(tables.photos.storageKey, `/${normalizedKey}`),
        eq(tables.photos.thumbnailKey, normalizedKey),
        eq(tables.photos.thumbnailKey, `/${normalizedKey}`),
        eq(tables.photos.displayKey, normalizedKey),
        eq(tables.photos.displayKey, `/${normalizedKey}`),
        eq(tables.photos.livePhotoVideoKey, normalizedKey),
        eq(tables.photos.livePhotoVideoKey, `/${normalizedKey}`),
        eq(tables.photos.videoPlaybackKey, normalizedKey),
        eq(tables.photos.videoPlaybackKey, `/${normalizedKey}`),
        eq(tables.photos.originalUrl, `/image/${normalizedKey}`),
        eq(tables.photos.originalUrl, `/image//${normalizedKey}`),
        eq(tables.photos.originalUrl, `/storage/${normalizedKey}`),
        eq(tables.photos.originalUrl, `/storage//${normalizedKey}`),
      ),
    )
    .get()
}

export function findPhotoByMediaUrl(url: string) {
  const normalizedKey = normalizeStorageKey(
    url.replace(/^\/image\/+/, '').replace(/^\/storage\/+/, ''),
  )
  return useDB()
    .select()
    .from(tables.photos)
    .where(
      or(
        eq(tables.photos.originalUrl, url),
        eq(tables.photos.thumbnailUrl, url),
        eq(tables.photos.livePhotoVideoUrl, url),
        eq(tables.photos.displayKey, normalizedKey),
        eq(tables.photos.displayKey, `/${normalizedKey}`),
      ),
    )
    .get()
}

const mediaKeyMatches = (
  key: string | null | undefined,
  normalizedKey: string,
) => {
  if (!key) return false
  const normalizedPhotoKey = normalizeStorageKey(key)
  return normalizedPhotoKey === normalizedKey
}

export function isOriginalImageMediaKey(
  photo: Pick<typeof tables.photos.$inferSelect, 'mediaType' | 'storageKey'>,
  storageKey: string,
) {
  return (
    photo.mediaType !== 'video' &&
    mediaKeyMatches(photo.storageKey, normalizeStorageKey(storageKey))
  )
}

export async function requireOriginalImageMediaAccess(event: H3Event) {
  const state = await getAccessState(event)
  if (state.granted) return

  throw createError({
    statusCode: 401,
    statusMessage: 'Site access required to download original photos',
  })
}
