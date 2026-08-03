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
  return useDB()
    .select()
    .from(tables.photos)
    .where(
      or(
        eq(tables.photos.originalUrl, url),
        eq(tables.photos.thumbnailUrl, url),
        eq(tables.photos.livePhotoVideoUrl, url),
      ),
    )
    .get()
}
