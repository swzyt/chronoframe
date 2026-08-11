export default defineEventHandler(async (event) => {
  const user = await requireCurrentUser(event)

  const shares = useDB()
    .select()
    .from(tables.uploadShares)
    .where(eq(tables.uploadShares.ownerUserId, user.id))
    .orderBy(tables.uploadShares.createdAt)
    .all()
    .toReversed()

  return shares.map(serializeUploadShare)
})
