import { and, eq } from 'drizzle-orm'
import {
  createOgMediaSignature,
  verifyOgMediaSignature,
} from './og-media-signing'
import { decodeSettingValue } from './settings-value'

export async function getAccessVersion() {
  const setting = useDB()
    .select({ value: tables.settings.value })
    .from(tables.settings)
    .where(
      and(
        eq(tables.settings.namespace, 'app'),
        eq(tables.settings.key, 'access.version'),
      ),
    )
    .get()
  const value = decodeSettingValue('number', setting?.value ?? null)
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
      ? value
      : 1
  ).toString()
}

export async function createOgMediaToken(
  photoId: string,
  storageKey: string,
  version?: string,
) {
  const resolvedVersion = version ?? (await getAccessVersion())
  return createOgMediaSignature(photoId, storageKey, resolvedVersion)
}

export async function verifyOgMediaToken(
  photoId: string,
  storageKey: string,
  token: string,
  version?: string,
) {
  const resolvedVersion = version ?? (await getAccessVersion())
  return verifyOgMediaSignature(photoId, storageKey, token, resolvedVersion)
}
