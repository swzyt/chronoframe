import path from 'node:path'
import { z } from 'zod'
import {
  generateSafePhotoId,
  generateSafeVideoId,
} from '~~/server/utils/file-utils'
import { settingsManager } from '~~/server/services/settings/settingsManager'

const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4'])

const isVideoFile = (fileName: string, contentType?: string | null) => {
  if (contentType?.toLowerCase().startsWith('video/')) return true
  return VIDEO_EXTENSIONS.has(path.extname(fileName).toLowerCase())
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
    }).parse,
  )

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
    const existingPhoto = useDB()
      .select({ id: tables.photos.id, title: tables.photos.title })
      .from(tables.photos)
      .where(eq(tables.photos.id, photoId))
      .get()

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
      expiresIn: 3600,
    }
  }

  return {
    signedUrl: `/api/upload-shares/public/${encodeURIComponent(token)}/upload?key=${encodeURIComponent(objectKey)}`,
    fileKey: objectKey,
    expiresIn: 3600,
  }
})
