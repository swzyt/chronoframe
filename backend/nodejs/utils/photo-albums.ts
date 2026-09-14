import { asc, eq, inArray } from 'drizzle-orm'

export interface PhotoAlbumSummary {
  id: number
  title: string
  isHidden: boolean
  ownerUserId: number
}

export async function getPhotoAlbumMap(photoIds: string[]) {
  const uniquePhotoIds = [...new Set(photoIds.filter(Boolean))]
  const map = new Map<string, PhotoAlbumSummary[]>()
  if (uniquePhotoIds.length === 0) {
    return map
  }

  const rows = await useDB()
    .select({
      photoId: tables.albumPhotos.photoId,
      id: tables.albums.id,
      title: tables.albums.title,
      isHidden: tables.albums.isHidden,
      ownerUserId: tables.albums.ownerUserId,
    })
    .from(tables.albumPhotos)
    .innerJoin(tables.albums, eq(tables.albums.id, tables.albumPhotos.albumId))
    .where(inArray(tables.albumPhotos.photoId, uniquePhotoIds))
    .orderBy(asc(tables.albumPhotos.position), asc(tables.albums.id))

  const seen = new Set<string>()
  for (const row of rows) {
    const key = `${row.photoId}:${row.id}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)

    const list = map.get(row.photoId) || []
    list.push({
      id: row.id,
      title: row.title,
      isHidden: row.isHidden,
      ownerUserId: row.ownerUserId,
    })
    map.set(row.photoId, list)
  }

  return map
}

export async function withPhotoAlbums<T extends { id: string }>(photos: T[]) {
  const albumMap = await getPhotoAlbumMap(photos.map((photo) => photo.id))
  return photos.map((photo) => {
    const albums = albumMap.get(photo.id) || []
    return {
      ...photo,
      albums,
      albumIds: albums.map((album) => album.id),
    }
  })
}
