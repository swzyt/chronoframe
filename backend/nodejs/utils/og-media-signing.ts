import { createHmac, timingSafeEqual } from 'node:crypto'

const MIN_SECRET_LENGTH = 32
const OG_SECRET_ENV_KEY = 'NUXT_OG_IMAGE_SECRET'
const LEGACY_SESSION_SECRET_ENV_KEY = 'NUXT_SESSION_PASSWORD'
const DERIVATION_CONTEXT = 'chronoframe:og-media:v1'
const BASE64URL_SHA256_PATTERN = /^[a-zA-Z0-9_-]{43}$/

type SigningKey = string | Buffer

function readOptionalSecret(name: string): string | null {
  const secret = process.env[name]
  if (!secret) return null
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must contain at least 32 characters`)
  }
  return secret
}

function deriveOgKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update(DERIVATION_CONTEXT).digest()
}

function signingKey(): SigningKey {
  const dedicatedSecret = readOptionalSecret(OG_SECRET_ENV_KEY)
  if (dedicatedSecret) return dedicatedSecret

  const sessionSecret = readOptionalSecret(LEGACY_SESSION_SECRET_ENV_KEY)
  if (!sessionSecret) {
    throw new Error(
      `${OG_SECRET_ENV_KEY} or ${LEGACY_SESSION_SECRET_ENV_KEY} must contain at least 32 characters`,
    )
  }
  return deriveOgKey(sessionSecret)
}

function verificationKeys(): SigningKey[] {
  const keys: SigningKey[] = []
  const dedicatedSecret = readOptionalSecret(OG_SECRET_ENV_KEY)
  const legacySessionSecret = readOptionalSecret(LEGACY_SESSION_SECRET_ENV_KEY)

  if (dedicatedSecret) keys.push(dedicatedSecret)
  if (legacySessionSecret) {
    // The derived key supports deployments that enabled domain-separated
    // fallback signing before configuring a dedicated OG secret.
    keys.push(deriveOgKey(legacySessionSecret))
    // The raw session secret verifies links issued by older releases.
    keys.push(legacySessionSecret)
  }

  if (keys.length === 0) {
    throw new Error(
      `${OG_SECRET_ENV_KEY} or ${LEGACY_SESSION_SECRET_ENV_KEY} must contain at least 32 characters`,
    )
  }
  return keys
}

function tokenPayload(photoId: string, storageKey: string, version: string) {
  return `${version}:${photoId}:${storageKey}`
}

function sign(payload: string, key: SigningKey): Buffer {
  return createHmac('sha256', key).update(payload).digest()
}

export function createOgMediaSignature(
  photoId: string,
  storageKey: string,
  version: string,
): string {
  return sign(
    tokenPayload(photoId, storageKey, version),
    signingKey(),
  ).toString('base64url')
}

export function verifyOgMediaSignature(
  photoId: string,
  storageKey: string,
  token: string,
  version: string,
): boolean {
  if (!BASE64URL_SHA256_PATTERN.test(token)) return false

  const actual = Buffer.from(token, 'base64url')
  if (actual.length !== 32) return false

  const payload = tokenPayload(photoId, storageKey, version)
  let matches = false

  for (const key of verificationKeys()) {
    const expected = sign(payload, key)
    matches = timingSafeEqual(expected, actual) || matches
  }

  return matches
}
