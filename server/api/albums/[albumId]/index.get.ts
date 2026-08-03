import { asc, getTableColumns } from 'drizzle-orm'
import z from 'zod'
import { getAccessVersion } from '~~/server/utils/og-media'
import { withOwners } from '~~/server/utils/owner-response'

export default eventHandler(async (event) => {
  const { albumId } = await getValidatedRouterParams(
    event,
    z.object({
      albumId: z
        .string()
        .regex(/^\d+$/)
        .transform((val) => parseInt(val, 10)),
    }).parse,
  )

  const db = useDB()

  const album = db
    .select()
    .from(tables.albums)
    .where(eq(tables.albums.id, albumId))
    .get()

  if (!album) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Album not found',
    })
  }

  if (!album.isHidden) {
    await requirePublicAlbumAccess(event, albumId)
  }

  // 检查相册是否隐藏，如果隐藏则需要用户登录才能访问
  if (album.isHidden) {
    const session = await getUserSession(event)
    const user = session.user ? await requireCurrentUser(event) : null
    if (!user || (!user.isAdmin && album.ownerUserId !== user.id)) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Album not found',
      })
    }
  }

  // 获取相册中的照片
  const photos = await db
    // all fields from tables.photos
    .select({
      ...getTableColumns(tables.photos),
    })
    .from(tables.photos)
    .innerJoin(
      tables.albumPhotos,
      eq(tables.photos.id, tables.albumPhotos.photoId),
    )
    .where(eq(tables.albumPhotos.albumId, albumId))
    .orderBy(asc(tables.albumPhotos.position))
    .all()
  const {
    photos: accessiblePhotos,
    hasMorePhotos,
  } = await filterAccessibleAlbumPhotos(
    event,
    albumId,
    photos,
  )

  // 验证相册数据完整性
  if (!accessiblePhotos || !Array.isArray(accessiblePhotos)) {
    // 空相册也是合法的，只需要返回空数组
    return {
      ...album,
      photos: [],
    }
  }

  const accessVersion = await getAccessVersion()
  const [albumWithOwner] = await withOwners([album])
  return {
    ...albumWithOwner,
    totalPhotoCount: photos.length,
    hasMorePhotos,
    photos: await toPublicPhotos(accessiblePhotos, accessVersion),
  }
})
