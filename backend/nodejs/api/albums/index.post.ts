import z from 'zod'
import { and, inArray, eq, sql } from 'drizzle-orm'

export default eventHandler(async (event) => {
  const user = await requireCurrentUser(event)

  const body = await readValidatedBody(
    event,
    z.object({
      title: z.string().min(1).max(255),
      description: z.string().max(1000).optional(),
      coverPhotoId: z.string().optional(),
      photoIds: z.array(z.string()).optional(),
      isHidden: z.boolean().optional(),
    }).parse,
  )

  const db = useDB()
  const requestedPhotoIds = new Set(body.photoIds || [])
  if (body.coverPhotoId) requestedPhotoIds.add(body.coverPhotoId)
  if (requestedPhotoIds.size) {
    const owned = await db
      .select({ id: tables.photos.id })
      .from(tables.photos)
      .where(
        and(
          inArray(tables.photos.id, [...requestedPhotoIds]),
          user.isAdmin
            ? sql`1 = 1`
            : eq(tables.photos.ownerUserId, user.id),
        ),
      )
    if (owned.length !== requestedPhotoIds.size) {
      throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
    }
  }

  const album = db.transaction((tx) => {
    const newAlbum = tx
      .insert(tables.albums)
      .values({
        title: body.title,
        description: body.description || null,
        coverPhotoId: body.coverPhotoId || null,
        isHidden: body.isHidden || false,
        ownerUserId: user.id,
      })
      .returning()
      .get()

    const albumId = newAlbum.id
    const photoIds = new Set(body.photoIds || [])

    if (body.coverPhotoId) {
      photoIds.add(body.coverPhotoId)
    }

    if (photoIds.size > 0) {
      let pos = 1000000
      for (const photoId of photoIds) {
        tx.insert(tables.albumPhotos)
          .values({
            albumId,
            photoId,
            position: (pos += 10),
          })
          .onConflictDoNothing()
          .run()
      }
    }

    return newAlbum
  })

  return album
})
