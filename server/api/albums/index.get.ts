import { getTableColumns, inArray } from 'drizzle-orm'
import { getAccessVersion } from '~~/server/utils/og-media'
import { withOwners } from '~~/server/utils/owner-response'

export default eventHandler(async (event) => {
  const db = useDB()
  const manage = getQuery(event).scope === 'manage'
  const user = manage ? await requireCurrentUser(event) : null
  const accessState = manage ? null : await getAccessState(event)
  const limits = manage ? null : await getPreviewLimits()
  const accessVersion =
    !manage && !accessState!.granted ? await getAccessVersion() : null

  const albums = manage
    ? await db
        .select()
        .from(tables.albums)
        .where(
          user!.isAdmin
            ? undefined
            : eq(tables.albums.ownerUserId, user!.id),
        )
    : accessState!.granted
      ? await getPublicAlbums()
      : (await getPublicAlbums()).slice(0, limits!.albumLimit)

  // 为每个相册获取照片 ID 列表（避免循环引用）
  const albumsWithOwners = await withOwners(albums)
  const albumsWithPhotoIds = await Promise.all(
    albumsWithOwners.map(async (album) => {
      const photoIds = await db
        .select({
          photoId: tables.albumPhotos.photoId,
          position: tables.albumPhotos.position,
        })
        .from(tables.albumPhotos)
        .where(eq(tables.albumPhotos.albumId, album.id))
        .orderBy(tables.albumPhotos.position)
      const orderedPhotoIds = photoIds.map((p) => p.photoId)
      const previewPhotoIds = [
        ...new Set([
          album.coverPhotoId,
          ...orderedPhotoIds.slice(0, 3),
        ].filter((id): id is string => Boolean(id))),
      ]
      const previewPhotos =
        accessVersion && previewPhotoIds.length > 0
          ? await db
              .select({ ...getTableColumns(tables.photos) })
              .from(tables.photos)
              .where(inArray(tables.photos.id, previewPhotoIds))
              .then((rows) =>
                toPublicPhotos(rows, accessVersion),
              )
          : undefined

      return {
        ...album,
        // 即使是空相册，也返回空数组而不是 undefined
        photoIds: orderedPhotoIds,
        previewPhotos,
      }
    }),
  )

  // 按创建时间倒序排列
  return albumsWithPhotoIds
})
