import { desc } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const user = await requireCurrentUser(event)

  const shares = useDB()
    .select()
    .from(tables.uploadShares)
    .where(eq(tables.uploadShares.ownerUserId, user.id))
    .orderBy(desc(tables.uploadShares.createdAt))
    .all()

  return shares.map((share) => serializeUploadShare(share, event))
})
