import { eq } from 'drizzle-orm'
import { z } from 'zod'

export default eventHandler(async (event) => {
  const actor = await requireAdmin(event)
  const id = z.coerce.number().int().positive().parse(getRouterParam(event, 'id'))
  if (id === actor.id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'You cannot delete your own account',
    })
  }
  const db = useDB()
  const target = db
    .select()
    .from(tables.users)
    .where(eq(tables.users.id, id))
    .get()
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }
  if (target.isAdmin) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Demote the administrator before deleting the account',
    })
  }

  db.transaction((tx) => {
    tx.update(tables.photos)
      .set({ ownerUserId: actor.id })
      .where(eq(tables.photos.ownerUserId, id))
      .run()
    tx.update(tables.albums)
      .set({ ownerUserId: actor.id })
      .where(eq(tables.albums.ownerUserId, id))
      .run()
    tx.update(tables.pipelineQueue)
      .set({ ownerUserId: actor.id })
      .where(eq(tables.pipelineQueue.ownerUserId, id))
      .run()
    tx.delete(tables.users).where(eq(tables.users.id, id)).run()
  })

  return { success: true }
})
