import type { H3Event } from 'h3'
import { eq } from 'drizzle-orm'
import { settingsManager } from '~~/server/services/settings/settingsManager'

const ACCESS_SESSION_NAME = 'chronoframe-access'
const ACCESS_MAX_AGE = 60 * 60 * 24 * 30

function sessionPassword() {
  const password = process.env.NUXT_SESSION_PASSWORD
  if (!password || password.length < 32) {
    throw new Error('NUXT_SESSION_PASSWORD must contain at least 32 characters')
  }
  return password
}

export async function getAccessState(event: H3Event) {
  const enabled =
    (await settingsManager.get<boolean>('app', 'access.enabled')) ?? false
  const version =
    (await settingsManager.get<number>('app', 'access.version')) ?? 1
  if (!enabled) return { enabled, granted: true, version }

  const userSession = await getUserSession(event)
  if (userSession.user) {
    const user = useDB()
      .select({
        id: tables.users.id,
        isActive: tables.users.isActive,
      })
      .from(tables.users)
      .where(eq(tables.users.id, userSession.user.id))
      .get()
    if (user?.isActive) return { enabled, granted: true, version }
    await clearUserSession(event)
  }

  const session = await useSession<{ version?: number }>(event, {
    name: ACCESS_SESSION_NAME,
    password: sessionPassword(),
    maxAge: ACCESS_MAX_AGE,
    cookie: { httpOnly: true, sameSite: 'lax', secure: false },
  })
  return {
    enabled,
    granted: session.data.version === version,
    version,
  }
}

export async function grantSiteAccess(event: H3Event, version: number) {
  const session = await useSession<{ version?: number }>(event, {
    name: ACCESS_SESSION_NAME,
    password: sessionPassword(),
    maxAge: ACCESS_MAX_AGE,
    cookie: { httpOnly: true, sameSite: 'lax', secure: false },
  })
  await session.update({ version })
}
