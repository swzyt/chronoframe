import type { H3Event } from 'h3'
import { and, eq } from 'drizzle-orm'
import { getOptionalCurrentUser } from './authz'
import { tables, useDB } from './db'
import {
  clearSharedAccess,
  grantSiteAccessToken,
  lookupSharedAccess,
  readLegacyAccessVersion,
} from './shared-access'
import { shouldUseSharedRedis } from './shared-session'
import {
  decodeSettingValue,
  encodeSettingValue,
  type SettingValueType,
} from './settings-value'

function freshAccessConfiguration() {
  const rows = useDB()
    .select({ key: tables.settings.key, value: tables.settings.value })
    .from(tables.settings)
    .where(eq(tables.settings.namespace, 'app'))
    .all()
  const setting = (key: string) =>
    rows.find((candidate) => candidate.key === key)?.value
  const parsedVersion = decodeSettingValue(
    'number',
    setting('access.version') ?? null,
  )

  return {
    enabled:
      decodeSettingValue('boolean', setting('access.enabled') ?? null) === true,
    version:
      typeof parsedVersion === 'number' &&
      Number.isSafeInteger(parsedVersion) &&
      parsedVersion > 0
        ? parsedVersion
        : 1,
  }
}

/**
 * Security credentials bypass SettingsManager's process-local cache so a
 * password rotation is observed consistently by every Node process.
 */
export function getFreshAccessPasswordHash(
  database: Pick<ReturnType<typeof useDB>, 'select'> = useDB(),
): string {
  return (
    database
      .select({ value: tables.settings.value })
      .from(tables.settings)
      .where(
        and(
          eq(tables.settings.namespace, 'app'),
          eq(tables.settings.key, 'access.passwordHash'),
        ),
      )
      .get()?.value || ''
  )
}

export class AccessPasswordRequiredError extends Error {
  constructor() {
    super('Set an access password before enabling protection')
    this.name = 'AccessPasswordRequiredError'
  }
}

export function updateAccessSecurityConfiguration(
  input: {
    enabled: boolean
    passwordHash?: string
    photoLimit: number
    albumLimit: number
    updatedBy: number
  },
  database: ReturnType<typeof useDB> = useDB(),
) {
  return database.transaction((transaction) => {
    const existingHash = getFreshAccessPasswordHash(transaction)
    const effectiveHash = input.passwordHash ?? existingHash
    if (input.enabled && !effectiveHash) {
      throw new AccessPasswordRequiredError()
    }

    const updateValue = (
      key: string,
      type: SettingValueType,
      value: unknown,
    ) => {
      const encoded = encodeSettingValue(type, value)
      const updated = transaction
        .update(tables.settings)
        .set({
          value: encoded.stored,
          updatedAt: new Date(),
          updatedBy: input.updatedBy,
        })
        .where(
          and(
            eq(tables.settings.namespace, 'app'),
            eq(tables.settings.key, key),
          ),
        )
        .returning({ id: tables.settings.id })
        .get()
      if (!updated) throw new Error(`Missing app setting: ${key}`)
    }

    if (input.passwordHash !== undefined) {
      updateValue('access.passwordHash', 'string', input.passwordHash)
    }
    updateValue('access.enabled', 'boolean', input.enabled)
    updateValue('access.previewPhotoLimit', 'number', input.photoLimit)
    updateValue('access.previewAlbumLimit', 'number', input.albumLimit)

    const versionRow = transaction
      .select({ value: tables.settings.value })
      .from(tables.settings)
      .where(
        and(
          eq(tables.settings.namespace, 'app'),
          eq(tables.settings.key, 'access.version'),
        ),
      )
      .get()
    const currentVersion = decodeSettingValue(
      'number',
      versionRow?.value ?? null,
    )
    if (
      typeof currentVersion !== 'number' ||
      !Number.isSafeInteger(currentVersion) ||
      currentVersion < 1 ||
      currentVersion === Number.MAX_SAFE_INTEGER
    ) {
      throw new Error('Access version setting is missing or invalid')
    }
    const version = currentVersion + 1
    updateValue('access.version', 'number', version)

    return { version, hasPassword: Boolean(effectiveHash) }
  })
}

async function hasActiveUser(event: H3Event): Promise<boolean> {
  try {
    return Boolean(await getOptionalCurrentUser(event))
  } catch {
    // Public reads stay available as a locked preview during Redis outages.
    return false
  }
}

async function hasSharedOrLegacyAccess(
  event: H3Event,
  version: number,
): Promise<boolean> {
  try {
    const shared = await lookupSharedAccess(event)
    if (shared.kind === 'valid') {
      if (shared.record.accessVersion === version) return true
      await clearSharedAccess(event)
    } else if (shared.kind === 'invalid') {
      await clearSharedAccess(event)
    }
  } catch {
    // Shared access is optional for public reads, but it must never be guessed.
    return false
  }

  if (shouldUseSharedRedis()) {
    // Shared-Redis mode is the dual-backend cutover boundary. A stateless
    // legacy Cookie must not be silently exchanged during a public read:
    // doing so would make Node mutate shared state while Go only reads it.
    // The access verification endpoint is the single writer that mints the
    // shared grant, keeping both implementations side-effect free here.
    return false
  }

  const legacyVersion = await readLegacyAccessVersion(event)
  if (legacyVersion !== version) return false
  return true
}

export async function getAccessState(event: H3Event) {
  const { enabled, version } = freshAccessConfiguration()
  if (!enabled) return { enabled, granted: true, version }

  if (await hasActiveUser(event)) {
    return { enabled, granted: true, version }
  }

  return {
    enabled,
    granted: await hasSharedOrLegacyAccess(event, version),
    version,
  }
}

export async function grantSiteAccess(event: H3Event, version: number) {
  await grantSiteAccessToken(event, version)
}
