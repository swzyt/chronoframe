import { asc, count, eq } from 'drizzle-orm'

export default eventHandler(async (event) => {
  await requireAdmin(event)
  const db = useDB()
  const users = await db
    .select({
      id: tables.users.id,
      username: tables.users.username,
      email: tables.users.email,
      avatar: tables.users.avatar,
      createdAt: tables.users.createdAt,
      isAdmin: tables.users.isAdmin,
      isActive: tables.users.isActive,
    })
    .from(tables.users)
    .orderBy(asc(tables.users.createdAt))

  return Promise.all(
    users.map(async (user) => {
      const [photos, albums] = await Promise.all([
        db
          .select({ value: count() })
          .from(tables.photos)
          .where(eq(tables.photos.ownerUserId, user.id))
          .get(),
        db
          .select({ value: count() })
          .from(tables.albums)
          .where(eq(tables.albums.ownerUserId, user.id))
          .get(),
      ])
      return {
        ...user,
        photoCount: photos?.value ?? 0,
        albumCount: albums?.value ?? 0,
      }
    }),
  )
})
