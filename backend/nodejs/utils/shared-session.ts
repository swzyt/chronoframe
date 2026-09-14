import type { H3Event } from 'h3'
import type { User as DatabaseUser } from './db'
import { getSessionCookieOptions, toSessionUser } from './security-policy'
import {
  decodeSharedSession,
  encodeSharedSession,
  generateOpaqueToken,
  sharedStateKey,
  SHARED_SESSION_TTL_SECONDS,
  type SharedSessionRecord,
} from './shared-state-contract'
import {
  isSharedRedisConfigured,
  parseSharedRedisRequired,
  useSharedRedis,
} from './shared-redis'

export const DEFAULT_SHARED_SESSION_COOKIE = 'cf_session'
export const SHARED_STATE_TTL_CLOCK_SKEW_MS = 2_000

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const READ_WITH_PTTL_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then
  return {false, -2}
end
return {value, redis.call('PTTL', KEYS[1])}
`
const REVOKED_CONTEXT_KEY = '__chronoframeSharedSessionRevoked'

export interface SharedRedisCommands {
  set(
    key: string,
    value: string,
    options: {
      expiration: { type: 'EXAT'; value: number }
    },
  ): Promise<unknown>
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>
  del(key: string): Promise<unknown>
}

export type SharedSessionLookup =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | {
      kind: 'valid'
      token: string
      key: string
      record: SharedSessionRecord
    }

export class SharedStateUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Shared Redis is unavailable', { cause })
    this.name = 'SharedStateUnavailableError'
  }
}

export class InvalidSharedStateRecordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSharedStateRecordError'
  }
}

export function sharedStateEnvironment(): string {
  return process.env.CFRAME_ENV?.trim() || 'development'
}

function configuredCookieName(
  environmentKey: string,
  fallback: string,
): string {
  const name = process.env[environmentKey]?.trim() || fallback
  if (!COOKIE_NAME_PATTERN.test(name)) {
    throw new Error(`${environmentKey} is not a valid Cookie name`)
  }
  return name
}

export function sharedSessionCookieName(): string {
  return configuredCookieName(
    'CFRAME_SESSION_COOKIE',
    DEFAULT_SHARED_SESSION_COOKIE,
  )
}

export function legacySessionCookieName(event: H3Event): string {
  const runtimeConfig = useRuntimeConfig(event) as {
    session?: { name?: string }
  }
  return runtimeConfig.session?.name || 'nuxt-session'
}

export function hasLegacySessionCookie(event: H3Event): boolean {
  return Boolean(getCookie(event, legacySessionCookieName(event)))
}

export function shouldUseSharedRedis(): boolean {
  const required = parseSharedRedisRequired(process.env.CFRAME_REDIS_REQUIRED)
  return isSharedRedisConfigured() || required
}

/**
 * Legacy sealed sessions are a transitional compatibility mechanism only.
 * Configuring shared Redis is the explicit cutover point: accepting a
 * stateless legacy Cookie there would allow it to be replayed after logout.
 * A stateful, one-time migration bridge can be introduced separately; this
 * fallback deliberately never runs alongside shared sessions.
 */
export function legacySessionFallbackAllowed(
  requiredValue = process.env.CFRAME_REDIS_REQUIRED,
  redisConfigured = isSharedRedisConfigured(),
): boolean {
  return !redisConfigured && !parseSharedRedisRequired(requiredValue)
}

function sharedCookieOptions(event: H3Event, maxAge?: number) {
  return {
    httpOnly: true as const,
    sameSite: 'lax' as const,
    path: '/',
    ...(maxAge === undefined ? {} : { maxAge }),
    ...getSessionCookieOptions(
      useRuntimeConfig(event).allowInsecureCookie,
      getRequestProtocol(event, { xForwardedProto: true }),
    ),
  }
}

export function buildSharedSessionWrite(input: {
  environment: string
  userId: number
  authVersion: number
  nowSeconds: number
  token?: string
}) {
  const token = input.token || generateOpaqueToken()
  const record: SharedSessionRecord = {
    schemaVersion: 1,
    userId: input.userId,
    authVersion: input.authVersion,
    issuedAt: input.nowSeconds,
    expiresAt: input.nowSeconds + SHARED_SESSION_TTL_SECONDS,
  }

  return {
    token,
    record,
    key: sharedStateKey(input.environment, 'session', token),
    value: encodeSharedSession(record),
  }
}

export async function writeAbsoluteSharedState(
  redis: SharedRedisCommands,
  key: string,
  value: string,
  expiresAt: number,
): Promise<void> {
  let result: unknown
  try {
    result = await redis.set(key, value, {
      expiration: { type: 'EXAT', value: expiresAt },
    })
  } catch (error) {
    throw new SharedStateUnavailableError(error)
  }

  if (result !== 'OK') {
    throw new SharedStateUnavailableError()
  }
}

export async function readAbsoluteSharedState(
  redis: SharedRedisCommands,
  key: string,
): Promise<{ value: string; ttlMilliseconds: number } | null> {
  let result: unknown
  try {
    result = await redis.eval(READ_WITH_PTTL_SCRIPT, {
      keys: [key],
      arguments: [],
    })
  } catch (error) {
    throw new SharedStateUnavailableError(error)
  }

  if (!Array.isArray(result) || result.length !== 2) {
    throw new InvalidSharedStateRecordError(
      'Shared-state Redis response is invalid',
    )
  }
  if (result[0] === null || result[0] === false) return null
  if (typeof result[0] !== 'string' || typeof result[1] !== 'number') {
    throw new InvalidSharedStateRecordError(
      'Shared-state value or TTL is invalid',
    )
  }

  return { value: result[0], ttlMilliseconds: result[1] }
}

export function validateAbsoluteRedisTTL(
  expiresAt: number,
  nowSeconds: number,
  ttlMilliseconds: number,
): void {
  const remainingMilliseconds = (expiresAt - nowSeconds) * 1_000
  if (
    ttlMilliseconds <= 0 ||
    remainingMilliseconds <= 0 ||
    ttlMilliseconds > remainingMilliseconds + SHARED_STATE_TTL_CLOCK_SKEW_MS
  ) {
    throw new InvalidSharedStateRecordError(
      'Shared-state Redis TTL exceeds absolute expiry',
    )
  }
}

function asSharedRedisCommands(client: unknown): SharedRedisCommands {
  return client as SharedRedisCommands
}

export async function configuredSharedRedis(): Promise<SharedRedisCommands | null> {
  if (!shouldUseSharedRedis()) return null
  try {
    const redis = await useSharedRedis()
    if (!redis) throw new Error('Shared Redis is not configured')
    return asSharedRedisCommands(redis)
  } catch (error) {
    throw new SharedStateUnavailableError(error)
  }
}

export async function lookupSharedSession(
  event: H3Event,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<SharedSessionLookup> {
  const token = getCookie(event, sharedSessionCookieName())
  if (!token) return { kind: 'absent' }

  let key: string
  try {
    key = sharedStateKey(sharedStateEnvironment(), 'session', token)
  } catch {
    return { kind: 'invalid' }
  }

  const redis = await configuredSharedRedis()
  if (!redis) {
    // A cf_session Cookie can only be trusted through Redis. Do not downgrade
    // to a legacy session merely because runtime configuration changed.
    throw new SharedStateUnavailableError()
  }

  try {
    const stored = await readAbsoluteSharedState(redis, key)
    if (!stored) return { kind: 'invalid' }
    const record = decodeSharedSession(stored.value, nowSeconds)
    validateAbsoluteRedisTTL(
      record.expiresAt,
      nowSeconds,
      stored.ttlMilliseconds,
    )
    return { kind: 'valid', token, key, record }
  } catch (error) {
    if (error instanceof SharedStateUnavailableError) throw error
    return { kind: 'invalid' }
  }
}

export async function issueSharedSession(
  event: H3Event,
  user: Pick<DatabaseUser, 'id' | 'authVersion'>,
): Promise<SharedSessionRecord | null> {
  const redis = await configuredSharedRedis()
  if (!redis) return null

  const write = buildSharedSessionWrite({
    environment: sharedStateEnvironment(),
    userId: user.id,
    authVersion: user.authVersion,
    nowSeconds: Math.floor(Date.now() / 1_000),
  })
  await writeAbsoluteSharedState(
    redis,
    write.key,
    write.value,
    write.record.expiresAt,
  )
  setCookie(event, sharedSessionCookieName(), write.token, {
    ...sharedCookieOptions(event, SHARED_SESSION_TTL_SECONDS),
  })
  return write.record
}

/**
 * Node remains the identity writer. The sealed legacy session is retained only
 * for the current Nuxt UI and is replaced (not merged) so old password hashes
 * cannot survive a login or one-time legacy exchange.
 */
export async function establishIdentitySession(
  event: H3Event,
  user: DatabaseUser,
): Promise<void> {
  await issueSharedSession(event, user)
  await replaceUserSession(
    event,
    { user: toSessionUser(user) },
    {
      cookie: getSessionCookieOptions(
        useRuntimeConfig(event).allowInsecureCookie,
        getRequestProtocol(event, { xForwardedProto: true }),
      ),
    },
  )
}

export async function revokeSharedSessionRecord(
  redis: Pick<SharedRedisCommands, 'del'>,
  environment: string,
  token: string,
): Promise<void> {
  let key: string
  try {
    key = sharedStateKey(environment, 'session', token)
  } catch (error) {
    throw new InvalidSharedStateRecordError(
      error instanceof Error ? error.message : 'Opaque token is invalid',
    )
  }
  try {
    await redis.del(key)
  } catch (error) {
    throw new SharedStateUnavailableError(error)
  }
}

export async function revokeSharedSession(event: H3Event): Promise<void> {
  const context = event.context as Record<string, unknown>
  if (context[REVOKED_CONTEXT_KEY]) return

  const token = getCookie(event, sharedSessionCookieName())
  if (token) {
    const redis = await configuredSharedRedis()
    if (redis) {
      try {
        await revokeSharedSessionRecord(redis, sharedStateEnvironment(), token)
      } catch (error) {
        if (error instanceof InvalidSharedStateRecordError) {
          // A malformed client Cookie has no Redis key to revoke.
        } else {
          throw error
        }
      }
    }
  }

  deleteCookie(event, sharedSessionCookieName(), {
    ...sharedCookieOptions(event),
  })
  context[REVOKED_CONTEXT_KEY] = true
}

export function sharedIdentityUnavailableError(cause?: unknown) {
  return createError({
    statusCode: 503,
    statusMessage: 'Shared identity service unavailable',
    cause,
  })
}

export function registerSharedSessionClearHook(
  hooks: {
    hook(
      name: 'clear',
      callback: (session: unknown, event: H3Event) => Promise<void>,
    ): unknown
  },
  revoke: (event: H3Event) => Promise<void> = revokeSharedSession,
): void {
  hooks.hook('clear', async (_session, event) => {
    try {
      await revoke(event)
    } catch (error) {
      throw sharedIdentityUnavailableError(error)
    }
  })
}
