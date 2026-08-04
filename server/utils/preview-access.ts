import {
  asc,
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  notInArray,
} from 'drizzle-orm'
import type { H3Event } from 'h3'
import { settingsManager } from '~~/server/services/settings/settingsManager'

export async function getPreviewLimits() {
  const [photoLimit, albumLimit] = await Promise.all([
    settingsManager.get<number>('app', 'access.previewPhotoLimit'),
    settingsManager.get<number>('app', 'access.previewAlbumLimit'),
  ])
  return {
    photoLimit: Math.max(1, Number(photoLimit) || 10),
    albumLimit: Math.max(1, Number(albumLimit) || 1),
  }
}

async function hiddenPhotoIds() {
  return useDB()
    .select({ photoId: tables.albumPhotos.photoId })
    .from(tables.albumPhotos)
    .innerJoin(tables.albums, eq(tables.albumPhotos.albumId, tables.albums.id))
    .where(eq(tables.albums.isHidden, true))
    .all()
    .map((row) => row.photoId)
}

interface PublicPhotoQueryOptions {
  limit?: number
}

const normalizeLimit = (limit?: number) => {
  if (limit === undefined) return undefined
  const parsed = Math.floor(Number(limit))
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.min(parsed, 500)
}

export async function getPublicPhotos(options: PublicPhotoQueryOptions = {}) {
  const db = useDB()
  const hiddenIds = await hiddenPhotoIds()
  const limit = normalizeLimit(options.limit)

  if (hiddenIds.length) {
    const query = db
      .select()
      .from(tables.photos)
      .where(notInArray(tables.photos.id, hiddenIds))
      .orderBy(desc(tables.photos.lastModified), desc(tables.photos.dateTaken))
    return limit ? query.limit(limit).all() : query.all()
  }

  const query = db
    .select()
    .from(tables.photos)
    .orderBy(desc(tables.photos.lastModified), desc(tables.photos.dateTaken))
  return limit ? query.limit(limit).all() : query.all()
}

export async function getPublicPhotoCount() {
  const hiddenIds = await hiddenPhotoIds()
  const query = useDB().select({ count: count() }).from(tables.photos)
  return (
    (hiddenIds.length
      ? query.where(notInArray(tables.photos.id, hiddenIds)).get()
      : query.get()
    )?.count || 0
  )
}

export async function isPublicPhoto(photoId: string) {
  const hiddenIds = await hiddenPhotoIds()
  if (hiddenIds.includes(photoId)) return false
  return Boolean(
    useDB()
      .select({ id: tables.photos.id })
      .from(tables.photos)
      .where(eq(tables.photos.id, photoId))
      .limit(1)
      .get(),
  )
}

const pickMapExif = (exif: any) => {
  if (!exif || typeof exif !== 'object') return undefined
  return {
    DateTimeOriginal: exif.DateTimeOriginal,
    Make: exif.Make,
    Model: exif.Model,
    FocalLength: exif.FocalLength,
    FocalLengthIn35mmFormat: exif.FocalLengthIn35mmFormat,
    ExposureTime: exif.ExposureTime,
    GPSLatitude: exif.GPSLatitude,
    GPSLatitudeRef: exif.GPSLatitudeRef,
    GPSLongitude: exif.GPSLongitude,
    GPSLongitudeRef: exif.GPSLongitudeRef,
    GPSAltitude: exif.GPSAltitude,
    GPSAltitudeRef: exif.GPSAltitudeRef,
  }
}

export async function getPublicPhotoMarkers(
  options: PublicPhotoQueryOptions = {},
) {
  const db = useDB()
  const hiddenIds = await hiddenPhotoIds()
  const limit = normalizeLimit(options.limit)
  const selectFields = {
    id: tables.photos.id,
    title: tables.photos.title,
    latitude: tables.photos.latitude,
    longitude: tables.photos.longitude,
    thumbnailKey: tables.photos.thumbnailKey,
    thumbnailHash: tables.photos.thumbnailHash,
    dateTaken: tables.photos.dateTaken,
    city: tables.photos.city,
    exif: tables.photos.exif,
  }
  const base = db
    .select(selectFields)
    .from(tables.photos)
    .where(
      and(
        isNotNull(tables.photos.latitude),
        isNotNull(tables.photos.longitude),
        hiddenIds.length
          ? notInArray(tables.photos.id, hiddenIds)
          : isNotNull(tables.photos.id),
      ),
    )
    .orderBy(desc(tables.photos.lastModified), desc(tables.photos.dateTaken))
  const rows = limit ? base.limit(limit).all() : base.all()
  return rows.map(({ thumbnailKey, exif, ...photo }) => ({
    ...photo,
    thumbnailUrl: thumbnailKey
      ? `/image/${thumbnailKey
          .replace(/^\/+/, '')
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`
      : null,
    exif: pickMapExif(exif),
  }))
}

export async function getPublicAlbums() {
  return useDB()
    .select()
    .from(tables.albums)
    .where(eq(tables.albums.isHidden, false))
    .orderBy(desc(tables.albums.createdAt))
    .all()
}

async function getPreviewAlbumPhotoIds(albumLimit: number, photoLimit: number) {
  const albums = (await getPublicAlbums()).slice(0, albumLimit)
  if (albums.length === 0) return []

  const albumPhotoRows = useDB()
    .select({
      albumId: tables.albumPhotos.albumId,
      photoId: tables.albumPhotos.photoId,
    })
    .from(tables.albumPhotos)
    .where(
      inArray(
        tables.albumPhotos.albumId,
        albums.map((album) => album.id),
      ),
    )
    .orderBy(asc(tables.albumPhotos.albumId), asc(tables.albumPhotos.position))
    .all()
  const countsByAlbum = new Map<number, number>()
  const albumPhotoIds: string[] = []
  for (const row of albumPhotoRows) {
    const count = countsByAlbum.get(row.albumId) || 0
    if (count >= photoLimit) continue
    countsByAlbum.set(row.albumId, count + 1)
    albumPhotoIds.push(row.photoId)
  }
  const coverPhotoIds = albums
    .map((album) => album.coverPhotoId)
    .filter((id): id is string => Boolean(id))

  return [...new Set([...albumPhotoIds, ...coverPhotoIds])]
}

async function getPreviewPhotoIds() {
  const { photoLimit, albumLimit } = await getPreviewLimits()
  return new Set([
    ...(await getPublicPhotos({ limit: photoLimit })).map((photo) => photo.id),
    ...(await getPreviewAlbumPhotoIds(albumLimit, photoLimit)),
  ])
}

export async function getPreviewAccessSummary(event: H3Event) {
  const [state, limits, totalPhotos, albums] = await Promise.all([
    getAccessState(event),
    getPreviewLimits(),
    getPublicPhotoCount(),
    getPublicAlbums(),
  ])
  return {
    required: state.enabled,
    granted: state.granted,
    ...limits,
    totalPhotos,
    totalAlbums: albums.length,
    hasMorePhotos:
      state.enabled && !state.granted && totalPhotos > limits.photoLimit,
    hasMoreAlbums:
      state.enabled && !state.granted && albums.length > limits.albumLimit,
  }
}

export async function requirePublicPhotoAccess(
  event: H3Event,
  photoId: string,
) {
  const state = await getAccessState(event)
  if (state.granted) return

  const allowedIds = await getPreviewPhotoIds()
  if (!allowedIds.has(photoId)) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Site access required to view more photos',
    })
  }
}

export async function requirePublicAlbumAccess(
  event: H3Event,
  albumId: number,
) {
  const state = await getAccessState(event)
  if (state.granted) return

  const { albumLimit } = await getPreviewLimits()
  const allowedIds = (await getPublicAlbums())
    .slice(0, albumLimit)
    .map((album) => album.id)
  if (!allowedIds.includes(albumId)) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Site access required to view more albums',
    })
  }
}

export async function filterAccessiblePhotoIds(
  event: H3Event,
  photoIds: string[],
) {
  const state = await getAccessState(event)
  if (state.granted) return photoIds
  const allowed = await getPreviewPhotoIds()
  return photoIds.filter((id) => allowed.has(id))
}

export async function filterAccessibleAlbumPhotos<T extends { id: string }>(
  event: H3Event,
  albumId: number,
  photos: T[],
) {
  const state = await getAccessState(event)
  if (state.granted) {
    return {
      photos,
      hasMorePhotos: false,
    }
  }

  await requirePublicAlbumAccess(event, albumId)
  const { photoLimit } = await getPreviewLimits()
  const accessiblePhotos = photos.slice(0, photoLimit)
  return {
    photos: accessiblePhotos,
    hasMorePhotos: accessiblePhotos.length < photos.length,
  }
}
