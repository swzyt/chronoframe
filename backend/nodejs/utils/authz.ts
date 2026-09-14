import type { H3Event } from 'h3'
import { and, eq } from 'drizzle-orm'
import type { User } from './db'
import { toSessionUser } from './security-policy'
import {
  establishIdentitySession,
  hasLegacySessionCookie,
  legacySessionFallbackAllowed,
  lookupSharedSession,
  revokeSharedSession,
  sharedIdentityUnavailableError,
  SharedStateUnavailableError,
  shouldUseSharedRedis,
} from './shared-session'

function findUser(userId: number) {
  return useDB()
    .select()
    .from(tables.users)
    .where(eq(tables.users.id, userId))
    .get()
}

async function clearLegacySessionIfPresent(event: H3Event): Promise<void> {
  if (hasLegacySessionCookie(event)) await clearUserSession(event)
}

function legacySessionNeedsReplacement(
  sessionUser: Record<string, unknown>,
  user: User,
): boolean {
  const expectedKeys = [
    'avatar',
    'email',
    'id',
    'isActive',
    'isAdmin',
    'username',
  ]
  const actualKeys = Object.keys(sessionUser).sort()
  return (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    sessionUser.id !== user.id ||
    sessionUser.username !== user.username ||
    sessionUser.email !== user.email ||
    sessionUser.avatar !== user.avatar ||
    sessionUser.isAdmin !== user.isAdmin ||
    sessionUser.isActive !== user.isActive
  )
}

export async function getOptionalCurrentUser(event: H3Event) {
  let sharedSession: Awaited<ReturnType<typeof lookupSharedSession>>
  try {
    sharedSession = await lookupSharedSession(event)
  } catch (error) {
    if (error instanceof SharedStateUnavailableError) {
      throw sharedIdentityUnavailableError(error)
    }
    throw error
  }

  if (sharedSession.kind === 'valid') {
    const user = findUser(sharedSession.record.userId)
    if (
      !user?.isActive ||
      user.authVersion !== sharedSession.record.authVersion
    ) {
      try {
        await revokeSharedSession(event)
        await clearLegacySessionIfPresent(event)
      } catch (error) {
        throw sharedIdentityUnavailableError(error)
      }
      return null
    }
    // Role and active state are deliberately returned from SQLite, never from
    // the Redis record or the legacy Cookie.
    return user
  }

  if (sharedSession.kind === 'invalid') {
    try {
      await revokeSharedSession(event)
      await clearLegacySessionIfPresent(event)
    } catch (error) {
      throw sharedIdentityUnavailableError(error)
    }
    return null
  }

  // Downgrade is allowed only when the new Cookie is genuinely absent.
  if (!hasLegacySessionCookie(event)) return null

  // In dual-backend/required mode a legacy Cookie is never an identity
  // credential. This makes logout final even if an attacker replays the old
  // sealed value after both current Cookies were cleared.
  if (!legacySessionFallbackAllowed()) {
    await clearUserSession(event)
    return null
  }

  const legacySession = await getUserSession(event)
  const legacyUser = legacySession.user as
    | (Record<string, unknown> & { id?: unknown })
    | undefined
  if (!legacyUser || !Number.isSafeInteger(legacyUser.id)) {
    await clearUserSession(event)
    return null
  }

  const user = findUser(legacyUser.id as number)
  if (!user?.isActive) {
    await clearUserSession(event)
    return null
  }

  if (
    shouldUseSharedRedis() ||
    legacySessionNeedsReplacement(legacyUser, user)
  ) {
    try {
      await establishIdentitySession(event, user)
    } catch (error) {
      if (error instanceof SharedStateUnavailableError) {
        throw sharedIdentityUnavailableError(error)
      }
      throw error
    }
  }
  return user
}

type SessionFetchData = Record<string, unknown> & {
  id?: unknown
  user?: unknown
}

function replaceFetchedSessionData(
  session: SessionFetchData,
  user?: User,
): void {
  for (const key of Object.keys(session)) {
    if (key !== 'id') delete session[key]
  }
  if (user) session.user = toSessionUser(user)
}

/**
 * nuxt-auth-utils fetches its sealed session directly for
 * GET /api/_auth/session. Validate it through the same shared identity path
 * as protected API routes so a replay cannot restore the UI session.
 */
export function registerSharedSessionFetchHook(
  hooks: {
    hook(
      name: 'fetch',
      callback: (session: SessionFetchData, event: H3Event) => Promise<void>,
    ): unknown
  },
  resolve: (
    event: H3Event,
  ) => Promise<User | null | undefined> = getOptionalCurrentUser,
  clear: (event: H3Event) => Promise<unknown> = clearUserSession,
): void {
  hooks.hook('fetch', async (session, event) => {
    let user: User | null | undefined
    try {
      user = await resolve(event)
    } catch (error) {
      replaceFetchedSessionData(session)
      throw error
    }

    replaceFetchedSessionData(session, user || undefined)
    if (!user) await clear(event)
  })
}

export async function requireCurrentUser(event: H3Event) {
  const user = await getOptionalCurrentUser(event)
  if (!user) {
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

export async function requireOwnedPhoto(event: H3Event, photoId: string) {
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
