import { createHmac } from 'node:crypto'
import type { H3Event } from 'h3'
import { assertSharedStateEnvironment } from './shared-state-contract'
import {
  configuredSharedRedis,
  sharedStateEnvironment,
  SharedStateUnavailableError,
  shouldUseSharedRedis,
  type SharedRedisCommands,
} from './shared-session'

export type RateLimitPurpose = 'login' | 'access'

export const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 5
export const AUTH_RATE_LIMIT_WINDOW_SECONDS = 15 * 60
export const RATE_LIMIT_ACQUIRE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) >= tonumber(ARGV[1]) then
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then
    redis.call('EXPIREAT', KEYS[1], ARGV[2])
    ttl = redis.call('TTL', KEYS[1])
  end
  return {0, tonumber(current), ttl}
end

local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIREAT', KEYS[1], ARGV[2])
end
return {1, count, redis.call('TTL', KEYS[1])}
`

const RATE_LIMIT_SECRET_CONTEXT = 'chronoframe:rate-limit:v1'
const MAX_IN_MEMORY_BUCKETS = 10_000
const inMemoryBuckets = new Map<string, { count: number; expiresAt: number }>()

export interface RateLimitDecision {
  allowed: boolean
  count: number
  retryAfterSeconds: number
  key: string
  backend: 'redis' | 'memory'
}

function rateLimitSecret(): string | Buffer {
  const dedicatedSecret = process.env.CFRAME_RATE_LIMIT_SECRET
  if (dedicatedSecret) {
    if (dedicatedSecret.length < 32) {
      throw new Error(
        'CFRAME_RATE_LIMIT_SECRET must contain at least 32 characters',
      )
    }
    return dedicatedSecret
  }

  const sessionSecret = process.env.NUXT_SESSION_PASSWORD
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error(
      'CFRAME_RATE_LIMIT_SECRET or NUXT_SESSION_PASSWORD must contain at least 32 characters',
    )
  }
  return createHmac('sha256', sessionSecret)
    .update(RATE_LIMIT_SECRET_CONTEXT)
    .digest()
}

export function buildRateLimitKey(input: {
  environment: string
  purpose: RateLimitPurpose
  subject: string
  nowSeconds: number
  windowSeconds: number
  secret: string | Buffer
}) {
  const environment = assertSharedStateEnvironment(input.environment)
  if (
    !Number.isSafeInteger(input.nowSeconds) ||
    input.nowSeconds <= 0 ||
    !Number.isSafeInteger(input.windowSeconds) ||
    input.windowSeconds <= 0
  ) {
    throw new Error('Rate-limit time window is invalid')
  }
  const window = Math.floor(input.nowSeconds / input.windowSeconds)
  const windowExpiresAt = (window + 1) * input.windowSeconds
  const subjectDigest = createHmac('sha256', input.secret)
    .update(input.subject || 'unknown')
    .digest('hex')
  return {
    key: `cf:v1:${environment}:ratelimit:${input.purpose}:${subjectDigest}:${window}`,
    windowExpiresAt,
  }
}

function parseRedisDecision(result: unknown, key: string): RateLimitDecision {
  if (
    !Array.isArray(result) ||
    result.length !== 3 ||
    typeof result[0] !== 'number' ||
    typeof result[1] !== 'number' ||
    typeof result[2] !== 'number'
  ) {
    throw new SharedStateUnavailableError()
  }
  return {
    allowed: result[0] === 1,
    count: result[1],
    retryAfterSeconds: Math.max(1, result[2]),
    key,
    backend: 'redis',
  }
}

async function acquireRedisRateLimit(
  redis: SharedRedisCommands,
  key: string,
  maxAttempts: number,
  windowExpiresAt: number,
): Promise<RateLimitDecision> {
  let result: unknown
  try {
    result = await redis.eval(RATE_LIMIT_ACQUIRE_SCRIPT, {
      keys: [key],
      arguments: [String(maxAttempts), String(windowExpiresAt)],
    })
  } catch (error) {
    throw new SharedStateUnavailableError(error)
  }
  return parseRedisDecision(result, key)
}

function purgeExpiredMemoryBuckets(nowSeconds: number): void {
  for (const [key, bucket] of inMemoryBuckets) {
    if (bucket.expiresAt <= nowSeconds) inMemoryBuckets.delete(key)
  }
}

function acquireInMemoryRateLimit(
  key: string,
  maxAttempts: number,
  nowSeconds: number,
  windowExpiresAt: number,
): RateLimitDecision {
  let bucket = inMemoryBuckets.get(key)
  if (!bucket || bucket.expiresAt <= nowSeconds) {
    if (inMemoryBuckets.size >= MAX_IN_MEMORY_BUCKETS) {
      purgeExpiredMemoryBuckets(nowSeconds)
    }
    if (inMemoryBuckets.size >= MAX_IN_MEMORY_BUCKETS) {
      throw new SharedStateUnavailableError()
    }
    bucket = { count: 0, expiresAt: windowExpiresAt }
    inMemoryBuckets.set(key, bucket)
  }

  if (bucket.count >= maxAttempts) {
    return {
      allowed: false,
      count: bucket.count,
      retryAfterSeconds: Math.max(1, bucket.expiresAt - nowSeconds),
      key,
      backend: 'memory',
    }
  }
  bucket.count += 1
  return {
    allowed: true,
    count: bucket.count,
    retryAfterSeconds: Math.max(1, bucket.expiresAt - nowSeconds),
    key,
    backend: 'memory',
  }
}

export function requestRateLimitSubject(event: H3Event): string {
  return getRequestIP(event, { xForwardedFor: true }) || 'unknown'
}

export function buildLoginRateLimitSubject(
  ipAddress: string,
  email: string,
): string {
  return `${ipAddress || 'unknown'}\0${email.trim().toLowerCase()}`
}

export async function acquireRequestRateLimit(
  event: H3Event,
  purpose: RateLimitPurpose,
  options: {
    maxAttempts?: number
    windowSeconds?: number
    subject?: string
    nowSeconds?: number
  } = {},
): Promise<RateLimitDecision> {
  const maxAttempts = options.maxAttempts ?? AUTH_RATE_LIMIT_MAX_ATTEMPTS
  const windowSeconds = options.windowSeconds ?? AUTH_RATE_LIMIT_WINDOW_SECONDS
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error('Rate-limit maximum must be a positive integer')
  }

  const { key, windowExpiresAt } = buildRateLimitKey({
    environment: sharedStateEnvironment(),
    purpose,
    subject: options.subject || requestRateLimitSubject(event),
    nowSeconds,
    windowSeconds,
    secret: rateLimitSecret(),
  })

  if (shouldUseSharedRedis()) {
    const redis = await configuredSharedRedis()
    if (!redis) throw new SharedStateUnavailableError()
    return acquireRedisRateLimit(redis, key, maxAttempts, windowExpiresAt)
  }
  return acquireInMemoryRateLimit(key, maxAttempts, nowSeconds, windowExpiresAt)
}

export async function resetRequestRateLimit(
  decision: Pick<RateLimitDecision, 'backend' | 'key'>,
): Promise<void> {
  if (decision.backend === 'memory') {
    inMemoryBuckets.delete(decision.key)
    return
  }

  const redis = await configuredSharedRedis()
  if (!redis) throw new SharedStateUnavailableError()
  try {
    await redis.del(decision.key)
  } catch (error) {
    throw new SharedStateUnavailableError(error)
  }
}
