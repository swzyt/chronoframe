import z from 'zod'
import { asc, eq } from 'drizzle-orm'

export default eventHandler(async (event) => {
  const user = await requireCurrentUser(event)

  const { albumIds } = await readValidatedBody(
    event,
    z.object({
      albumIds: z
        .array(z.number().int().positive())
        .min(1)
        .refine((ids) => new Set(ids).size === ids.length, {
          message: 'Album IDs must be unique',
        }),
    }).parse,
  )

  const db = useDB()
  const visibleAlbums = db
    .select({ id: tables.albums.id, position: tables.albums.position })
    .from(tables.albums)
    .where(user.isAdmin ? undefined : eq(tables.albums.ownerUserId, user.id))
    .orderBy(asc(tables.albums.position), asc(tables.albums.id))
    .all()

  const visibleIds = new Set(visibleAlbums.map((album) => album.id))
  if (
    visibleAlbums.length !== albumIds.length ||
    albumIds.some((id) => !visibleIds.has(id))
  ) {
    throw createError({ statusCode: 404, statusMessage: 'Album not found' })
  }

  db.transaction((tx) => {
    albumIds.forEach((id, index) => {
      tx.update(tables.albums)
        .set({ position: visibleAlbums[index]!.position })
        .where(eq(tables.albums.id, id))
        .run()
    })
  })

  return { success: true }
})
