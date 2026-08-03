import { asc, desc, eq, inArray, notInArray } from 'drizzle-orm'
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

export async function getPublicPhotos() {
  const db = useDB()
  const hiddenIds = await hiddenPhotoIds()
  const query = db
    .select()
    .from(tables.photos)
    .orderBy(desc(tables.photos.lastModified), desc(tables.photos.dateTaken))
  return hiddenIds.length
    ? query.where(notInArray(tables.photos.id, hiddenIds)).all()
    : query.all()
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
    ...(await getPublicPhotos()).slice(0, photoLimit).map((photo) => photo.id),
    ...(await getPreviewAlbumPhotoIds(albumLimit, photoLimit)),
  ])
}

export async function getPreviewAccessSummary(event: H3Event) {
  const [state, limits, photos, albums] = await Promise.all([
    getAccessState(event),
    getPreviewLimits(),
    getPublicPhotos(),
    getPublicAlbums(),
  ])
  return {
    required: state.enabled,
    granted: state.granted,
    ...limits,
    totalPhotos: photos.length,
    totalAlbums: albums.length,
    hasMorePhotos:
      state.enabled && !state.granted && photos.length > limits.photoLimit,
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
