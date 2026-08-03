import { and, eq, inArray, sql } from 'drizzle-orm'
import z from 'zod'

type BatchAlbumMode = 'replace' | 'add' | 'remove'

export default eventHandler(async (event) => {
  const user = await requireCurrentUser(event)
  const body = await readValidatedBody(
    event,
    z.object({
      photoIds: z.array(z.string().min(1)).min(1),
      albumIds: z.array(z.number().int().positive()).default([]),
      mode: z.enum(['replace', 'add', 'remove']).default('replace'),
    }).parse,
  )

  const db = useDB()
  const photoIds = [...new Set(body.photoIds)]
  const albumIds = [...new Set(body.albumIds)]
  const mode = body.mode as BatchAlbumMode

  const photos = await db
    .select({
      id: tables.photos.id,
    })
    .from(tables.photos)
    .where(
      and(
        inArray(tables.photos.id, photoIds),
        user.isAdmin ? sql`1 = 1` : eq(tables.photos.ownerUserId, user.id),
      ),
    )

  if (photos.length !== photoIds.length) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  if (albumIds.length > 0) {
    const albums = await db
      .select({
        id: tables.albums.id,
      })
      .from(tables.albums)
      .where(
        and(
          inArray(tables.albums.id, albumIds),
          user.isAdmin ? sql`1 = 1` : eq(tables.albums.ownerUserId, user.id),
        ),
      )

    if (albums.length !== albumIds.length) {
      throw createError({ statusCode: 404, statusMessage: 'Album not found' })
    }
  }

  const currentRows = await db
    .select({
      photoId: tables.albumPhotos.photoId,
      albumId: tables.albumPhotos.albumId,
    })
    .from(tables.albumPhotos)
    .innerJoin(tables.albums, eq(tables.albums.id, tables.albumPhotos.albumId))
    .where(
      and(
        inArray(tables.albumPhotos.photoId, photoIds),
        user.isAdmin ? sql`1 = 1` : eq(tables.albums.ownerUserId, user.id),
      ),
    )

  const currentAlbumIdsByPhoto = new Map<string, Set<number>>()
  for (const row of currentRows) {
    const current = currentAlbumIdsByPhoto.get(row.photoId) || new Set<number>()
    current.add(row.albumId)
    currentAlbumIdsByPhoto.set(row.photoId, current)
  }

  const albumIdsToClearCover = new Set<number>()
  const nextPositionsByAlbum = new Map<number, number>()

  db.transaction((tx) => {
    const getNextPosition = (albumId: number) => {
      const existing = nextPositionsByAlbum.get(albumId)
      if (typeof existing === 'number') {
        const next = existing + 10
        nextPositionsByAlbum.set(albumId, next)
        return next
      }

      const maxPositionRow = tx
        .select({
          value: sql<number | null>`max(${tables.albumPhotos.position})`,
        })
        .from(tables.albumPhotos)
        .where(eq(tables.albumPhotos.albumId, albumId))
        .get()
      const next = (maxPositionRow?.value ?? 1000000) + 10
      nextPositionsByAlbum.set(albumId, next)
      return next
    }

    for (const photoId of photoIds) {
      const currentAlbumIds = currentAlbumIdsByPhoto.get(photoId) || new Set()

      if (mode === 'replace') {
        for (const albumId of currentAlbumIds) {
          if (!albumIds.includes(albumId)) {
            albumIdsToClearCover.add(albumId)
          }

          tx.delete(tables.albumPhotos)
            .where(
              and(
                eq(tables.albumPhotos.photoId, photoId),
                eq(tables.albumPhotos.albumId, albumId),
              ),
            )
            .run()
        }
      }

      if (mode === 'remove') {
        for (const albumId of albumIds) {
          if (currentAlbumIds.has(albumId)) {
            albumIdsToClearCover.add(albumId)
          }

          tx.delete(tables.albumPhotos)
            .where(
              and(
                eq(tables.albumPhotos.photoId, photoId),
                eq(tables.albumPhotos.albumId, albumId),
              ),
            )
            .run()
        }
      }

      if (mode === 'replace' || mode === 'add') {
        for (const albumId of albumIds) {
          tx.delete(tables.albumPhotos)
            .where(
              and(
                eq(tables.albumPhotos.photoId, photoId),
                eq(tables.albumPhotos.albumId, albumId),
              ),
            )
            .run()

          tx.insert(tables.albumPhotos)
            .values({
              albumId,
              photoId,
              position: getNextPosition(albumId),
            })
            .run()
        }
      }
    }

    for (const albumId of albumIdsToClearCover) {
      tx.update(tables.albums)
        .set({ coverPhotoId: null, updatedAt: new Date() })
        .where(
          and(
            eq(tables.albums.id, albumId),
            inArray(tables.albums.coverPhotoId, photoIds),
          ),
        )
        .run()
    }
  })

  return {
    success: true,
    updatedCount: photoIds.length,
    mode,
  }
})
