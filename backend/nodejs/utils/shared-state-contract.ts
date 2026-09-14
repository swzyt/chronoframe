import { createHash, randomBytes } from 'node:crypto'

export const SHARED_STATE_SCHEMA_VERSION = 1
export const SHARED_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

const environmentPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/
const tokenPattern = /^[A-Za-z0-9_-]{43}$/

export interface SharedSessionRecord {
  schemaVersion: 1
  userId: number
  authVersion: number
  issuedAt: number
  expiresAt: number
}

export interface SharedAccessRecord {
  schemaVersion: 1
  accessVersion: number
  issuedAt: number
  expiresAt: number
}

export function assertSharedStateEnvironment(environment: string) {
  if (!environmentPattern.test(environment)) {
    throw new Error('CFRAME_ENV has an invalid shared-state namespace')
  }
  return environment
}

export function generateOpaqueToken() {
  return randomBytes(32).toString('base64url')
}

export function digestOpaqueToken(token: string) {
  if (
    !tokenPattern.test(token) ||
    Buffer.from(token, 'base64url').length !== 32
  ) {
    throw new Error('Opaque token must be 32-byte base64url without padding')
  }
  return createHash('sha256').update(token).digest('hex')
}

export function sharedStateKey(
  environment: string,
  purpose: 'session' | 'access',
  token: string,
) {
  return `cf:v1:${assertSharedStateEnvironment(environment)}:${purpose}:${digestOpaqueToken(token)}`
}

export function encodeSharedSession(record: SharedSessionRecord) {
  assertSharedSession(record)
  return JSON.stringify(record)
}

export function decodeSharedSession(value: string, nowSeconds: number) {
  const record = JSON.parse(value) as SharedSessionRecord
  assertSharedSession(record)
  if (record.expiresAt <= nowSeconds) throw new Error('Shared session expired')
  return record
}

export function encodeSharedAccess(record: SharedAccessRecord) {
  assertSharedAccess(record)
  return JSON.stringify(record)
}

export function decodeSharedAccess(value: string, nowSeconds: number) {
  const record = JSON.parse(value) as SharedAccessRecord
  assertSharedAccess(record)
  if (record.expiresAt <= nowSeconds)
    throw new Error('Shared access grant expired')
  return record
}

function assertUnixRange(issuedAt: number, expiresAt: number) {
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt <= 0 ||
    expiresAt <= issuedAt
  ) {
    throw new Error('Shared-state timestamps are invalid')
  }
}

function assertSharedSession(record: SharedSessionRecord) {
  if (
    record?.schemaVersion !== SHARED_STATE_SCHEMA_VERSION ||
    !Number.isSafeInteger(record.userId) ||
    record.userId <= 0 ||
    !Number.isSafeInteger(record.authVersion) ||
    record.authVersion <= 0
  ) {
    throw new Error('Shared session record is invalid')
  }
  assertUnixRange(record.issuedAt, record.expiresAt)
}

function assertSharedAccess(record: SharedAccessRecord) {
  if (
    record?.schemaVersion !== SHARED_STATE_SCHEMA_VERSION ||
    !Number.isSafeInteger(record.accessVersion) ||
    record.accessVersion <= 0
  ) {
    throw new Error('Shared access record is invalid')
  }
  assertUnixRange(record.issuedAt, record.expiresAt)
}
