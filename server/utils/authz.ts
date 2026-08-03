import type { H3Event } from 'h3'
import { and, eq } from 'drizzle-orm'

export async function requireCurrentUser(event: H3Event) {
  const session = await requireUserSession(event)
  const sessionUser = session.user
  const user = useDB()
    .select()
    .from(tables.users)
    .where(eq(tables.users.id, sessionUser.id))
    .get()

  if (!user?.isActive) {
    await clearUserSession(event)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  return user
}

export async function requireAdmin(event: H3Event) {
  const user = await requireCurrentUser(event)
  if (!user.isAdmin) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  return user
}

export function photoScope(user: { id: number; isAdmin: number }) {
  return user.isAdmin ? undefined : eq(tables.photos.ownerUserId, user.id)
}

export function albumScope(
  user: { id: number; isAdmin: number },
  albumId?: number,
) {
  const owner = user.isAdmin
    ? undefined
    : eq(tables.albums.ownerUserId, user.id)
  const id = albumId === undefined ? undefined : eq(tables.albums.id, albumId)
  return owner && id ? and(owner, id) : owner || id
}

export async function requireOwnedPhoto(
  event: H3Event,
  photoId: string,
) {
  const user = await requireCurrentUser(event)
  const photo = useDB()
    .select()
    .from(tables.photos)
    .where(
      user.isAdmin
        ? eq(tables.photos.id, photoId)
        : and(
            eq(tables.photos.id, photoId),
            eq(tables.photos.ownerUserId, user.id),
          ),
    )
    .get()
  if (!photo) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }
  return { user, photo }
}
