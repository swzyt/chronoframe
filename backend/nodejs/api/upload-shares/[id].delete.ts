export default defineEventHandler(async (event) => {
  const user = await requireCurrentUser(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid share id' })
  }

  const deleted = useDB()
    .delete(tables.uploadShares)
    .where(
      and(
        eq(tables.uploadShares.id, id),
        eq(tables.uploadShares.ownerUserId, user.id),
      ),
    )
    .returning({ id: tables.uploadShares.id })
    .get()

  if (!deleted) {
    throw createError({ statusCode: 404, statusMessage: 'Upload link not found' })
  }

  return { ok: true }
})
