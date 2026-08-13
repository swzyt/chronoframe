import crypto from 'node:crypto'
import path from 'node:path'
import type { H3Event } from 'h3'
import { and, eq, sql } from 'drizzle-orm'
import { sanitizeFileName } from './file-utils'

export const UPLOAD_SHARE_TOKEN_BYTES = 32

export function generateUploadShareToken() {
  return crypto.randomBytes(UPLOAD_SHARE_TOKEN_BYTES).toString('base64url')
}

export function hashUploadShareToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function buildUploadShareUrl(event: H3Event, token: string) {
  const origin = getRequestURL(event).origin
  return `${origin}/upload/${encodeURIComponent(token)}`
}

export function serializeUploadShare(
  share: typeof tables.uploadShares.$inferSelect,
  event?: H3Event,
) {
  return {
    id: share.id,
    label: share.label,
    isActive: share.isActive,
    uploadCount: share.uploadCount,
    maxUploads: share.maxUploads,
    expiresAt: share.expiresAt?.toISOString() || null,
    lastUsedAt: share.lastUsedAt?.toISOString() || null,
    createdAt: share.createdAt.toISOString(),
    updatedAt: share.updatedAt.toISOString(),
    token: share.token || null,
    url: event && share.token ? buildUploadShareUrl(event, share.token) : null,
  }
}

export function assertUploadShareUsable(
  share: typeof tables.uploadShares.$inferSelect | undefined,
) {
  if (!share?.isActive) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Upload link not found',
    })
  }

  if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
    throw createError({
      statusCode: 410,
      statusMessage: 'Upload link expired',
    })
  }

  if (share.maxUploads !== null && share.uploadCount >= share.maxUploads) {
    throw createError({
      statusCode: 429,
      statusMessage: 'Upload link limit reached',
    })
  }
}

export async function requireUploadShare(token: string) {
  if (!token || token.length < 24) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Upload link not found',
    })
  }

  const db = useDB()
  const share = db
    .select()
    .from(tables.uploadShares)
    .where(eq(tables.uploadShares.tokenHash, hashUploadShareToken(token)))
    .get()

  assertUploadShareUsable(share)

  const owner = db
    .select({
      id: tables.users.id,
      username: tables.users.username,
      avatar: tables.users.avatar,
      isActive: tables.users.isActive,
    })
    .from(tables.users)
    .where(eq(tables.users.id, share!.ownerUserId))
    .get()

  if (!owner?.isActive) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Upload link not found',
    })
  }

  return { share: share!, owner }
}

export function buildUploadShareStorageKey(
  event: H3Event,
  ownerUserId: number,
  shareId: number,
  fileName: string,
) {
  const { storageProvider } = useStorageProvider(event)
  const prefix =
    storageProvider.config && 'prefix' in storageProvider.config
      ? String(storageProvider.config.prefix || '')
          .replace(/^\/+/, '')
          .replace(/\/+$/, '')
      : ''

  const parsed = path.parse(fileName)
  const safeBase = sanitizeFileName(parsed.name || 'upload', {
    maxLength: 80,
    fallbackPrefix: 'upload',
    minLength: 1,
  })
  const rawExt = parsed.ext.toLowerCase()
  const safeExt = /^[.][a-z0-9]{1,12}$/.test(rawExt) ? rawExt : ''
  const randomSuffix = crypto.randomBytes(6).toString('hex')
  const date = new Date().toISOString().slice(0, 10)
  const safeFileName = `${safeBase}-${randomSuffix}${safeExt}`

  return [
    prefix,
    'users',
    String(ownerUserId),
    'guest-uploads',
    String(shareId),
    date,
    safeFileName,
  ]
    .filter(Boolean)
    .join('/')
}

export function isUploadShareStorageKey(
  event: H3Event,
  ownerUserId: number,
  shareId: number,
  storageKey: string,
) {
  const { storageProvider } = useStorageProvider(event)
  const prefix =
    storageProvider.config && 'prefix' in storageProvider.config
      ? String(storageProvider.config.prefix || '')
          .replace(/^\/+/, '')
          .replace(/\/+$/, '')
      : ''
  const expectedPrefix = [
    prefix,
    'users',
    String(ownerUserId),
    'guest-uploads',
    String(shareId),
  ]
    .filter(Boolean)
    .join('/')
  const normalizedKey = storageKey
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
  return normalizedKey.startsWith(`${expectedPrefix}/`)
}

export function markUploadShareUsed(shareId: number) {
  const db = useDB()
  db.update(tables.uploadShares)
    .set({
      uploadCount: sql`${tables.uploadShares.uploadCount} + 1`,
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(tables.uploadShares.id, shareId), eq(tables.uploadShares.isActive, true)))
    .run()
}
