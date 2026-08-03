import { z } from 'zod'
import { settingsManager } from '~~/server/services/settings/settingsManager'

const attempts = new Map<string, { count: number; resetAt: number }>()

export default eventHandler(async (event) => {
  const ip = getRequestIP(event, { xForwardedFor: true }) || 'unknown'
  const now = Date.now()
  const current = attempts.get(ip)
  if (current && current.resetAt > now && current.count >= 5) {
    throw createError({ statusCode: 429, statusMessage: 'Too many attempts' })
  }
  const state = await getAccessState(event)
  if (!state.enabled) return { success: true }

  const { password } = await readValidatedBody(
    event,
    z.object({ password: z.string().min(1).max(128) }).parse,
  )
  const hash =
    (await settingsManager.get<string>('app', 'access.passwordHash')) || ''
  if (!hash || !(await verifyPassword(hash, password))) {
    attempts.set(ip, {
      count: current && current.resetAt > now ? current.count + 1 : 1,
      resetAt: current && current.resetAt > now ? current.resetAt : now + 900000,
    })
    throw createError({ statusCode: 401, statusMessage: 'Invalid password' })
  }

  attempts.delete(ip)
  await grantSiteAccess(event, state.version)
  return { success: true }
})
