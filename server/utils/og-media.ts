import { createHmac, timingSafeEqual } from 'node:crypto'
import { settingsManager } from '~~/server/services/settings/settingsManager'

function signingSecret() {
  const secret = process.env.NUXT_SESSION_PASSWORD
  if (!secret || secret.length < 32) {
    throw new Error('NUXT_SESSION_PASSWORD must contain at least 32 characters')
  }
  return secret
}

export async function getAccessVersion() {
  return (
    (await settingsManager.get<number>('app', 'access.version')) ?? 1
  ).toString()
}

export async function createOgMediaToken(
  photoId: string,
  storageKey: string,
  version?: string,
) {
  const resolvedVersion = version ?? (await getAccessVersion())
  return createHmac('sha256', signingSecret())
    .update(`${resolvedVersion}:${photoId}:${storageKey}`)
    .digest('base64url')
}

export async function verifyOgMediaToken(
  photoId: string,
  storageKey: string,
  token: string,
  version?: string,
) {
  const expected = Buffer.from(
    await createOgMediaToken(photoId, storageKey, version),
  )
  const actual = Buffer.from(token)
  return (
    expected.length === actual.length && timingSafeEqual(expected, actual)
  )
}
