import { and, eq, isNotNull } from 'drizzle-orm'
import crypto from 'node:crypto'

export const normalizeContentHash = (hash?: string | null) => {
  const normalized = hash?.trim().toLowerCase()
  return normalized && /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

export const sha256Hex = (buffer: Buffer | Uint8Array) =>
  crypto.createHash('sha256').update(buffer).digest('hex')

export const findDuplicatePhotoByContentHash = (
  ownerUserId: number,
  contentHash?: string | null,
) => {
  const normalizedHash = normalizeContentHash(contentHash)
  if (!normalizedHash) return null

  return useDB()
    .select({
      id: tables.photos.id,
      title: tables.photos.title,
      storageKey: tables.photos.storageKey,
      originalUrl: tables.photos.originalUrl,
      thumbnailUrl: tables.photos.thumbnailUrl,
      dateTaken: tables.photos.dateTaken,
      fileSize: tables.photos.fileSize,
      width: tables.photos.width,
      height: tables.photos.height,
      contentHash: tables.photos.contentHash,
    })
    .from(tables.photos)
    .where(
      and(
        eq(tables.photos.ownerUserId, ownerUserId),
        eq(tables.photos.contentHash, normalizedHash),
        isNotNull(tables.photos.contentHash),
      ),
    )
    .get()
}
