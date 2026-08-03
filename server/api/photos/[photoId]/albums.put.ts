import { and, eq, inArray, sql } from 'drizzle-orm'
import z from 'zod'
import { getPhotoAlbumMap } from '~~/server/utils/photo-albums'

export default eventHandler(async (event) => {
  const user = await requireCurrentUser(event)

  const { photoId } = await getValidatedRouterParams(
    event,
    z.object({
      photoId: z.string().min(1),
    }).parse,
  )

  const body = await readValidatedBody(
    event,
    z.object({
      albumIds: z.array(z.number().int().positive()).default([]),
    }).parse,
  )

  const db = useDB()
  const photo = await db
    .select({
      id: tables.photos.id,
      ownerUserId: tables.photos.ownerUserId,
    })
    .from(tables.photos)
    .where(
      user.isAdmin
        ? eq(tables.photos.id, photoId)
        : and(
            eq(tables.photos.id, photoId),
            eq(tables.photos.ownerUserId, user.id),
          ),
    )
    .get()

  if (!photo) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  const nextAlbumIds = [...new Set(body.albumIds)]
  let manageableAlbumIds: number[] = []

  if (nextAlbumIds.length > 0) {
    const albums = await db
      .select({
        id: tables.albums.id,
      })
      .from(tables.albums)
      .where(
        and(
          inArray(tables.albums.id, nextAlbumIds),
          user.isAdmin ? sql`1 = 1` : eq(tables.albums.ownerUserId, user.id),
        ),
      )

    if (albums.length !== nextAlbumIds.length) {
      throw createError({ statusCode: 404, statusMessage: 'Album not found' })
    }

    manageableAlbumIds = albums.map((album) => album.id)
  }

  const currentRows = await db
    .select({
      albumId: tables.albumPhotos.albumId,
    })
    .from(tables.albumPhotos)
    .innerJoin(tables.albums, eq(tables.albums.id, tables.albumPhotos.albumId))
    .where(
      and(
        eq(tables.albumPhotos.photoId, photoId),
        user.isAdmin ? sql`1 = 1` : eq(tables.albums.ownerUserId, user.id),
      ),
    )

  const currentAlbumIds = [...new Set(currentRows.map((row) => row.albumId))]
  const nextAlbumIdSet = new Set(manageableAlbumIds)
  const removedAlbumIds = currentAlbumIds.filter(
    (id) => !nextAlbumIdSet.has(id),
  )

  db.transaction((tx) => {
    for (const albumId of currentAlbumIds) {
      tx.delete(tables.albumPhotos)
        .where(
          and(
            eq(tables.albumPhotos.photoId, photoId),
            eq(tables.albumPhotos.albumId, albumId),
          ),
        )
        .run()
    }

    for (const albumId of removedAlbumIds) {
      tx.update(tables.albums)
        .set({ coverPhotoId: null, updatedAt: new Date() })
        .where(
          and(
            eq(tables.albums.id, albumId),
            eq(tables.albums.coverPhotoId, photoId),
          ),
        )
        .run()
    }

    for (const albumId of nextAlbumIds) {
      const maxPositionRow = tx
        .select({
          value: sql<number | null>`max(${tables.albumPhotos.position})`,
        })
        .from(tables.albumPhotos)
        .where(eq(tables.albumPhotos.albumId, albumId))
        .get()

      tx.insert(tables.albumPhotos)
        .values({
          albumId,
          photoId,
          position: (maxPositionRow?.value ?? 1000000) + 10,
        })
        .run()
    }
  })

  const albumMap = await getPhotoAlbumMap([photoId])
  return {
    photoId,
    albums: albumMap.get(photoId) || [],
    albumIds: (albumMap.get(photoId) || []).map((album) => album.id),
  }
})
