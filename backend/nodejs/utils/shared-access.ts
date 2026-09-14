import type { H3Event } from 'h3'
import { getSiteAccessCookieOptions } from './security-policy'
import {
  decodeSharedAccess,
  encodeSharedAccess,
  generateOpaqueToken,
  sharedStateKey,
  type SharedAccessRecord,
} from './shared-state-contract'
import {
  configuredSharedRedis,
  InvalidSharedStateRecordError,
  readAbsoluteSharedState,
  sharedStateEnvironment,
  shouldUseSharedRedis,
  type SharedRedisCommands,
  validateAbsoluteRedisTTL,
  writeAbsoluteSharedState,
} from './shared-session'

export const DEFAULT_SHARED_ACCESS_COOKIE = 'cf_access'
export const LEGACY_ACCESS_COOKIE = 'chronoframe-access'
export const SHARED_ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export type SharedAccessLookup =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | {
      kind: 'valid'
      token: string
      key: string
      record: SharedAccessRecord
    }

export function sharedAccessCookieName(): string {
  const name =
    process.env.CFRAME_ACCESS_COOKIE?.trim() || DEFAULT_SHARED_ACCESS_COOKIE
  if (!COOKIE_NAME_PATTERN.test(name)) {
    throw new Error('CFRAME_ACCESS_COOKIE is not a valid Cookie name')
  }
  return name
}

function sharedAccessCookieOptions(event: H3Event, maxAge?: number) {
  return {
    path: '/',
    ...(maxAge === undefined ? {} : { maxAge }),
    ...getSiteAccessCookieOptions(
      useRuntimeConfig(event).allowInsecureCookie,
      getRequestProtocol(event, { xForwardedProto: true }),
    ),
  }
}

function legacyAccessPassword(): string {
  const password = process.env.NUXT_SESSION_PASSWORD
  if (!password || password.length < 32) {
    throw new Error('NUXT_SESSION_PASSWORD must contain at least 32 characters')
  }
  return password
}

function legacyAccessSessionConfig(event: H3Event) {
  return {
    name: LEGACY_ACCESS_COOKIE,
    password: legacyAccessPassword(),
    maxAge: SHARED_ACCESS_TTL_SECONDS,
    cookie: sharedAccessCookieOptions(event),
  }
}

export function buildSharedAccessWrite(input: {
  environment: string
  accessVersion: number
  nowSeconds: number
  token?: string
}) {
  const token = input.token || generateOpaqueToken()
  const record: SharedAccessRecord = {
    schemaVersion: 1,
    accessVersion: input.accessVersion,
    issuedAt: input.nowSeconds,
    expiresAt: input.nowSeconds + SHARED_ACCESS_TTL_SECONDS,
  }
  return {
    token,
    record,
    key: sharedStateKey(input.environment, 'access', token),
    value: encodeSharedAccess(record),
  }
}

export async function lookupSharedAccess(
  event: H3Event,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<SharedAccessLookup> {
  const token = getCookie(event, sharedAccessCookieName())
  if (!token) return { kind: 'absent' }

  let key: string
  try {
    key = sharedStateKey(sharedStateEnvironment(), 'access', token)
  } catch {
    return { kind: 'invalid' }
  }

  const redis = await configuredSharedRedis()
  if (!redis) return { kind: 'invalid' }

  try {
    const stored = await readAbsoluteSharedState(redis, key)
    if (!stored) return { kind: 'invalid' }
    const record = decodeSharedAccess(stored.value, nowSeconds)
    validateAbsoluteRedisTTL(
      record.expiresAt,
      nowSeconds,
      stored.ttlMilliseconds,
    )
    return { kind: 'valid', token, key, record }
  } catch (error) {
    if (error instanceof InvalidSharedStateRecordError) {
      return { kind: 'invalid' }
    }
    throw error
  }
}

export async function issueSharedAccess(
  event: H3Event,
  accessVersion: number,
): Promise<SharedAccessRecord | null> {
  const redis = await configuredSharedRedis()
  if (!redis) return null

  const write = buildSharedAccessWrite({
    environment: sharedStateEnvironment(),
    accessVersion,
    nowSeconds: Math.floor(Date.now() / 1_000),
  })
  await writeAbsoluteSharedState(
    redis,
    write.key,
    write.value,
    write.record.expiresAt,
  )
  setCookie(event, sharedAccessCookieName(), write.token, {
    ...sharedAccessCookieOptions(event, SHARED_ACCESS_TTL_SECONDS),
  })
  return write.record
}

export async function deleteSharedAccessRecord(
  redis: Pick<SharedRedisCommands, 'del'>,
  environment: string,
  token: string,
): Promise<void> {
  let key: string
  try {
    key = sharedStateKey(environment, 'access', token)
  } catch {
    return
  }
  await redis.del(key)
}

export async function clearSharedAccess(event: H3Event): Promise<void> {
  const token = getCookie(event, sharedAccessCookieName())
  if (token && shouldUseSharedRedis()) {
    const redis = await configuredSharedRedis()
    if (redis) {
      await deleteSharedAccessRecord(redis, sharedStateEnvironment(), token)
    }
  }
  deleteCookie(event, sharedAccessCookieName(), {
    ...sharedAccessCookieOptions(event),
  })
}

/**
 * Legacy access Cookies are unsealed directly. Calling useSession for a read
 * would create and emit a new H3 session whenever the Cookie is absent or bad.
 */
export async function readLegacyAccessVersion(
  event: H3Event,
): Promise<number | null> {
  const sealed = getCookie(event, LEGACY_ACCESS_COOKIE)
  if (!sealed) return null

  try {
    const session = await unsealSession(
      event,
      legacyAccessSessionConfig(event),
      sealed,
    )
    const version = session.data?.version
    return Number.isSafeInteger(version) && version > 0 ? version : null
  } catch {
    return null
  }
}

export async function grantSiteAccessToken(
  event: H3Event,
  accessVersion: number,
): Promise<void> {
  if (shouldUseSharedRedis()) {
    await issueSharedAccess(event, accessVersion)
    return
  }

  // Explicit single-process compatibility mode for deployments that have not
  // configured shared Redis yet. Redis-enabled deployments never mint legacy
  // access Cookies.
  const session = await useSession<{ version?: number }>(
    event,
    legacyAccessSessionConfig(event),
  )
  await session.update({ version: accessVersion })
}
