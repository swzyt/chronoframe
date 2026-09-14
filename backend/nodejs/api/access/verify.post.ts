import { z } from 'zod'
import {
  acquireRequestRateLimit,
  resetRequestRateLimit,
} from '#server/utils/rate-limiter'
import { getFreshAccessPasswordHash } from '#server/utils/site-access'
import { sharedIdentityUnavailableError } from '#server/utils/shared-session'

export default eventHandler(async (event) => {
  const state = await getAccessState(event)
  if (!state.enabled) return { success: true }

  const { password } = await readValidatedBody(
    event,
    z.object({ password: z.string().min(1).max(128) }).parse,
  )

  let rateLimit: Awaited<ReturnType<typeof acquireRequestRateLimit>>
  try {
    rateLimit = await acquireRequestRateLimit(event, 'access')
  } catch (error) {
    throw sharedIdentityUnavailableError(error)
  }
  if (!rateLimit.allowed) {
    setResponseHeader(event, 'Retry-After', rateLimit.retryAfterSeconds)
    throw createError({ statusCode: 429, statusMessage: 'Too many attempts' })
  }

  const hash = getFreshAccessPasswordHash()
  if (!hash || !(await verifyPassword(hash, password))) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid password' })
  }

  try {
    await resetRequestRateLimit(rateLimit)
    await grantSiteAccess(event, state.version)
  } catch (error) {
    throw sharedIdentityUnavailableError(error)
  }
  return { success: true }
})
