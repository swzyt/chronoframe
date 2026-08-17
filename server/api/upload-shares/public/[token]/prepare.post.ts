import path from 'node:path'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import {
  generateSafePhotoId,
  generateSafeVideoId,
} from '~~/server/utils/file-utils'
import { settingsManager } from '~~/server/services/settings/settingsManager'
import {
  findDuplicatePhotoByContentHash,
  normalizeContentHash,
  sha256Hex,
} from '~~/server/utils/photo-duplicate'

const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4'])

const isVideoFile = (fileName: string, contentType?: string | null) => {
  if (contentType?.toLowerCase().startsWith('video/')) return true
  return VIDEO_EXTENSIONS.has(path.extname(fileName).toLowerCase())
}

const legacyPhotoMatchesContentHash = async (
  storageProvider: ReturnType<typeof useStorageProvider>['storageProvider'],
  existingPhoto: {
    id: string
    storageKey: string | null
    contentHash?: string | null
  },
  contentHash: string | null,
) => {
  if (!contentHash || existingPhoto.contentHash || !existingPhoto.storageKey) {
    return false
  }

  const existingBuffer = await storageProvider.get(existingPhoto.storageKey)
  if (!existingBuffer) {
    return false
  }

  const existingHash = sha256Hex(existingBuffer)
  if (existingHash !== contentHash) {
    return false
  }

  useDB()
    .update(tables.photos)
    .set({ contentHash })
    .where(eq(tables.photos.id, existingPhoto.id))
    .run()
  existingPhoto.contentHash = contentHash
  return true
}

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token') || ''
  const { share } = await requireUploadShare(token)
  const { storageProvider } = useStorageProvider(event)
  const t = await useTranslation(event)
  const body = await readValidatedBody(
    event,
    z.object({
      fileName: z.string().min(1).max(255),
      contentType: z.string().optional(),
      contentHash: z.string().optional(),
    }).parse,
  )
  const contentHash = normalizeContentHash(body.contentHash)

  const objectKey = buildUploadShareStorageKey(
    event,
    share.ownerUserId,
    share.id,
    body.fileName,
  )

  const duplicateCheckEnabled =
    (await settingsManager.get<boolean>(
      'system',
      'upload.duplicateCheck.enabled',
    )) ?? true

  if (duplicateCheckEnabled) {
    const photoId = isVideoFile(body.fileName, body.contentType)
      ? generateSafeVideoId(objectKey)
      : generateSafePhotoId(objectKey)
    let existingPhoto = findDuplicatePhotoByContentHash(
      share.ownerUserId,
      contentHash,
    )

    if (!existingPhoto) {
      const legacyIdPhoto = useDB()
        .select({
          id: tables.photos.id,
          title: tables.photos.title,
          storageKey: tables.photos.storageKey,
          contentHash: tables.photos.contentHash,
        })
        .from(tables.photos)
        .where(
          and(
            eq(tables.photos.id, photoId),
            eq(tables.photos.ownerUserId, share.ownerUserId),
          ),
        )
        .get()

      if (!contentHash) {
        existingPhoto = legacyIdPhoto
      } else if (
        legacyIdPhoto &&
        (await legacyPhotoMatchesContentHash(
          storageProvider,
          legacyIdPhoto,
          contentHash,
        ))
      ) {
        existingPhoto = legacyIdPhoto
      }
    }

    if (existingPhoto) {
      throw createError({
        statusCode: 409,
        statusMessage: t('upload.duplicate.block.title'),
        data: {
          duplicate: true,
          existingPhoto,
          title: t('upload.duplicate.block.title'),
          message: t('upload.duplicate.block.message', {
            fileName: body.fileName,
          }),
        },
      })
    }
  }

  const isTencentCos =
    storageProvider.config &&
    'endpoint' in storageProvider.config &&
    typeof storageProvider.config.endpoint === 'string' &&
    storageProvider.config.endpoint.includes('myqcloud.com')

  if (storageProvider.getSignedUrl && !isTencentCos) {
    const signedUrl = await storageProvider.getSignedUrl(objectKey, 3600, {
      contentType: body.contentType || 'application/octet-stream',
    })
    return {
      signedUrl,
      fileKey: objectKey,
      contentHash,
      expiresIn: 3600,
    }
  }

  return {
    signedUrl: `/api/upload-shares/public/${encodeURIComponent(token)}/upload?key=${encodeURIComponent(objectKey)}`,
    fileKey: objectKey,
    contentHash,
    expiresIn: 3600,
  }
})
