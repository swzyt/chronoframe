import { and, eq, or } from 'drizzle-orm'
import z from 'zod'

export default eventHandler(async (event) => {
  const { photoId } = await getValidatedRouterParams(
    event,
    z.object({
      photoId: z.string(),
    }).parse,
  )

  const db = useDB()
  await requirePublicPhotoAccess(event, photoId)
  const session = await getUserSession(event)
  const user = session.user ? await requireCurrentUser(event) : null
  const visibilityScope =
    user?.isAdmin
      ? undefined
      : user
        ? or(
            eq(tables.albums.isHidden, false),
            eq(tables.albums.ownerUserId, user.id),
          )
        : eq(tables.albums.isHidden, false)

  // 获取包含该照片的所有相册
  const albums = await db
    .select({
      id: tables.albums.id,
      title: tables.albums.title,
      description: tables.albums.description,
      coverPhotoId: tables.albums.coverPhotoId,
      createdAt: tables.albums.createdAt,
      updatedAt: tables.albums.updatedAt,
    })
    .from(tables.albums)
    .innerJoin(
      tables.albumPhotos,
      eq(tables.albums.id, tables.albumPhotos.albumId),
    )
    .where(
      visibilityScope
        ? and(eq(tables.albumPhotos.photoId, photoId), visibilityScope)
        : eq(tables.albumPhotos.photoId, photoId),
    )
    .all()

  return albums
})
