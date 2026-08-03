import { desc, eq } from 'drizzle-orm'
import { getAccessVersion } from '~~/server/utils/og-media'
import { withOwners } from '~~/server/utils/owner-response'
import { withPhotoAlbums } from '~~/server/utils/photo-albums'

export default eventHandler(async (event) => {
  const query = getQuery(event)
  const db = useDB()
  if (query.scope === 'manage') {
    const user = await requireCurrentUser(event)
    const photos = user.isAdmin
      ? db
          .select()
          .from(tables.photos)
          .orderBy(
            desc(tables.photos.lastModified),
            desc(tables.photos.dateTaken),
          )
          .all()
      : db
          .select()
          .from(tables.photos)
          .where(eq(tables.photos.ownerUserId, user.id))
          .orderBy(
            desc(tables.photos.lastModified),
            desc(tables.photos.dateTaken),
          )
          .all()
    return withPhotoAlbums(await withOwners(photos))
  }
  const [state, limits, photos] = await Promise.all([
    getAccessState(event),
    getPreviewLimits(),
    getPublicPhotos(),
  ])
  const accessVersion = await getAccessVersion()
  return toPublicPhotos(
    state.granted ? photos : photos.slice(0, limits.photoLimit),
    accessVersion,
  )
})
