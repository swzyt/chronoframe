import { asc, eq, getTableColumns, inArray } from 'drizzle-orm'
import { getAccessVersion } from '~~/server/utils/og-media'
import { withOwners } from '~~/server/utils/owner-response'

export default eventHandler(async (event) => {
  const db = useDB()
  const manage = getQuery(event).scope === 'manage'
  const user = manage ? await requireCurrentUser(event) : null
  const accessState = manage ? null : await getAccessState(event)
  const limits = manage ? null : await getPreviewLimits()
  const accessVersion =
    !manage && !accessState!.granted ? await getAccessVersion() : null

  const albums = manage
    ? await db
        .select()
        .from(tables.albums)
        .where(
          user!.isAdmin ? undefined : eq(tables.albums.ownerUserId, user!.id),
        )
    : accessState!.granted
      ? await getPublicAlbums()
      : await getPublicAlbums({ limit: limits!.albumLimit })

  const albumsWithOwners = await withOwners(albums)
  if (albumsWithOwners.length === 0) {
    return []
  }

  const albumIds = albumsWithOwners.map((album) => album.id)
  const albumPhotoRows = await db
    .select({
      albumId: tables.albumPhotos.albumId,
      photoId: tables.albumPhotos.photoId,
      position: tables.albumPhotos.position,
    })
    .from(tables.albumPhotos)
    .where(inArray(tables.albumPhotos.albumId, albumIds))
    .orderBy(asc(tables.albumPhotos.albumId), asc(tables.albumPhotos.position))

  const photoIdsByAlbum = new Map<number, string[]>()
  for (const row of albumPhotoRows) {
    const ids = photoIdsByAlbum.get(row.albumId) || []
    ids.push(row.photoId)
    photoIdsByAlbum.set(row.albumId, ids)
  }

  const previewPhotoIdsByAlbum = new Map<number, string[]>()
  const allPreviewPhotoIds = new Set<string>()
  if (accessVersion) {
    for (const album of albumsWithOwners) {
      const orderedPhotoIds = photoIdsByAlbum.get(album.id) || []
      const previewPhotoIds = [
        ...new Set(
          [album.coverPhotoId, ...orderedPhotoIds.slice(0, 3)].filter(
            (id): id is string => Boolean(id),
          ),
        ),
      ]
      previewPhotoIdsByAlbum.set(album.id, previewPhotoIds)
      for (const photoId of previewPhotoIds) {
        allPreviewPhotoIds.add(photoId)
      }
    }
  }

  const previewPhotoMap = new Map<string, any>()
  if (accessVersion && allPreviewPhotoIds.size > 0) {
    const rows = await db
      .select({ ...getTableColumns(tables.photos) })
      .from(tables.photos)
      .where(inArray(tables.photos.id, [...allPreviewPhotoIds]))
    const publicPhotos = await toPublicPhotos(rows, accessVersion)
    for (const photo of publicPhotos) {
      previewPhotoMap.set(photo.id, photo)
    }
  }

  return albumsWithOwners.map((album) => {
    const orderedPhotoIds = photoIdsByAlbum.get(album.id) || []
    const previewPhotoIds = previewPhotoIdsByAlbum.get(album.id) || []
    const previewPhotos = accessVersion
      ? previewPhotoIds
          .map((photoId) => previewPhotoMap.get(photoId))
          .filter(Boolean)
      : undefined

    return {
      ...album,
      photoIds: orderedPhotoIds,
      previewPhotos,
    }
  })
})
