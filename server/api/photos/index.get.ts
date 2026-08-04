import { and, count, desc, eq, like, or, sql } from 'drizzle-orm'
import { getAccessVersion } from '~~/server/utils/og-media'
import { withOwners } from '~~/server/utils/owner-response'
import { withPhotoAlbums } from '~~/server/utils/photo-albums'

const parsePositiveInteger = (
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(1, Math.floor(parsed)))
}

const escapeLike = (value: string) =>
  value.replace(/[\\%_]/g, (match) => `\\${match}`)

export default eventHandler(async (event) => {
  const query = getQuery(event)
  const db = useDB()
  if (query.scope === 'manage') {
    const user = await requireCurrentUser(event)
    const paginated = query.page !== undefined || query.pageSize !== undefined
    const metaOnly = query.metaOnly === '1' || query.metaOnly === 'true'
    const page = parsePositiveInteger(query.page, 1)
    const pageSize = parsePositiveInteger(query.pageSize, 50, 200)
    const offset = (page - 1) * pageSize
    const search = String(query.search || '').trim()
    const mediaType = String(query.mediaType || '')
    const ownerCondition = user.isAdmin
      ? undefined
      : eq(tables.photos.ownerUserId, user.id)
    const mediaCondition =
      mediaType === 'image' || mediaType === 'video'
        ? eq(tables.photos.mediaType, mediaType)
        : undefined
    const searchCondition = search
      ? or(
          like(tables.photos.id, `%${escapeLike(search)}%`),
          like(tables.photos.title, `%${escapeLike(search)}%`),
          like(tables.photos.description, `%${escapeLike(search)}%`),
          like(tables.photos.city, `%${escapeLike(search)}%`),
          like(tables.photos.country, `%${escapeLike(search)}%`),
          like(tables.photos.locationName, `%${escapeLike(search)}%`),
          like(tables.photos.storageKey, `%${escapeLike(search)}%`),
        )
      : undefined
    const where = and(ownerCondition, mediaCondition, searchCondition)

    const total = paginated
      ? db.select({ count: count() }).from(tables.photos).where(where).get()
          ?.count || 0
      : undefined
    if (paginated && metaOnly) {
      return {
        items: [],
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil((total || 0) / pageSize)),
      }
    }

    const baseQuery = db
      .select()
      .from(tables.photos)
      .where(where)
      .orderBy(
        desc(sql`COALESCE(${tables.photos.lastModified}, '')`),
        desc(sql`COALESCE(${tables.photos.dateTaken}, '')`),
        desc(tables.photos.id),
      )

    const photos = paginated
      ? baseQuery.limit(pageSize).offset(offset).all()
      : baseQuery.all()
    const items = await withPhotoAlbums(await withOwners(photos))

    if (paginated) {
      return {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil((total || 0) / pageSize)),
      }
    }

    return items
  }
  const [state, limits] = await Promise.all([
    getAccessState(event),
    getPreviewLimits(),
  ])
  const photos = await getPublicPhotos({
    limit: state.granted ? undefined : limits.photoLimit,
  })
  const accessVersion = await getAccessVersion()
  return toPublicPhotos(photos, accessVersion)
})
