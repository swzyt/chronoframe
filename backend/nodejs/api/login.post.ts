import { z } from 'zod'
import {
  acquireRequestRateLimit,
  buildLoginRateLimitSubject,
  requestRateLimitSubject,
  resetRequestRateLimit,
} from '#server/utils/rate-limiter'
import {
  establishIdentitySession,
  sharedIdentityUnavailableError,
  SharedStateUnavailableError,
} from '#server/utils/shared-session'

const _invalidCredentialsError = createError({
  statusCode: 401,
  message: 'Invalid credentials',
})

export default eventHandler(async (event) => {
  const db = useDB()
  const { email: rawEmail, password } = await readValidatedBody(
    event,
    z.object({
      email: z.email(),
      password: z.string().min(6),
    }).parse,
  )
  const email = rawEmail.trim().toLowerCase()

  let rateLimit: Awaited<ReturnType<typeof acquireRequestRateLimit>>
  try {
    rateLimit = await acquireRequestRateLimit(event, 'login', {
      subject: buildLoginRateLimitSubject(
        requestRateLimitSubject(event),
        email,
      ),
    })
  } catch (error) {
    throw sharedIdentityUnavailableError(error)
  }
  if (!rateLimit.allowed) {
    setResponseHeader(event, 'Retry-After', rateLimit.retryAfterSeconds)
    throw createError({
      statusCode: 429,
      statusMessage: 'Too many attempts',
    })
  }

  const user = db
    .select()
    .from(tables.users)
    .where(eq(tables.users.email, email))
    .get()

  if (!user?.isActive) {
    throw _invalidCredentialsError
  }

  if (!(await verifyPassword(user.password || '', password))) {
    throw _invalidCredentialsError
  }

  try {
    await resetRequestRateLimit(rateLimit)
    await establishIdentitySession(event, user)
  } catch (error) {
    if (error instanceof SharedStateUnavailableError) {
      throw sharedIdentityUnavailableError(error)
    }
    throw error
  }

  return setResponseStatus(event, 201)
})
