import path from 'path'
import { useStorageProvider } from '~~/server/utils/useStorageProvider'
import { eq } from 'drizzle-orm'
import {
  generateSafePhotoId,
  generateSafeVideoId,
} from '~~/server/utils/file-utils'
import { settingsManager } from '~~/server/services/settings/settingsManager'

const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4'])

const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.heif',
  '.jpeg',
  '.jpg',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
])

const isVideoFile = (
  fileName: string,
  contentType?: string | null,
): boolean => {
  if (contentType?.toLowerCase().startsWith('video/')) {
    return true
  }

  const ext = path.extname(fileName).toLowerCase()
  return ext !== '' && VIDEO_EXTENSIONS.has(ext)
}

const isLikelyImageKey = (storageKey?: string | null): boolean => {
  if (!storageKey) {
    return false
  }

  const ext = path.extname(storageKey).toLowerCase()
  return ext !== '' && IMAGE_EXTENSIONS.has(ext)
}

export default eventHandler(async (event) => {
  const user = await requireCurrentUser(event)
  const { storageProvider } = useStorageProvider(event)
  const t = await useTranslation(event)

  const body = await readBody(event)
  const { fileName, contentType, skipDuplicateCheck } = body
  const isVideoUpload = fileName ? isVideoFile(fileName, contentType) : false

  if (!fileName) {
    throw createError({
      statusCode: 400,
      statusMessage: t('upload.error.required.title'),
    })
  }

  try {
    const prefix =
      storageProvider.config && 'prefix' in storageProvider.config
        ? (storageProvider.config.prefix || '')
            .replace(/^\/+/, '')
            .replace(/\/+$/, '')
        : ''
    const objectKey = [prefix, 'users', String(user.id), fileName]
      .filter(Boolean)
      .join('/')

    // 重复文件检测
    const duplicateCheckEnabled =
      ((await settingsManager.get<boolean>(
        'system',
        'upload.duplicateCheck.enabled',
      )) ??
        true) &&
      !skipDuplicateCheck
    let existingPhoto = null

    if (duplicateCheckEnabled) {
      const photoId =
        path.extname(fileName).toLowerCase() === '.mp4'
          ? generateSafeVideoId(objectKey)
          : generateSafePhotoId(objectKey)
      const db = useDB()

      existingPhoto = await db
        .select({
          id: tables.photos.id,
          title: tables.photos.title,
          storageKey: tables.photos.storageKey,
          originalUrl: tables.photos.originalUrl,
          thumbnailUrl: tables.photos.thumbnailUrl,
          dateTaken: tables.photos.dateTaken,
        })
        .from(tables.photos)
        .where(eq(tables.photos.id, photoId))
        .get()

      if (
        existingPhoto &&
        isVideoUpload &&
        isLikelyImageKey(existingPhoto.storageKey)
      ) {
        existingPhoto = null
      }

      if (existingPhoto) {
        const checkMode =
          (await settingsManager.get<'warn' | 'block' | 'skip'>(
            'system',
            'upload.duplicateCheck.mode',
          )) ?? 'skip'

        if (checkMode === 'block') {
          // 阻止模式：直接拒绝上传
          throw createError({
            statusCode: 409,
            statusMessage: t('upload.duplicate.block.title'),
            data: {
              duplicate: true,
              existingPhoto,
              title: t('upload.duplicate.block.title'),
              message: t('upload.duplicate.block.message', { fileName }),
            },
          })
        } else if (checkMode === 'skip') {
          // 跳过模式：返回现有照片信息，不上传
          return {
            skipped: true,
            duplicate: true,
            existingPhoto,
            fileKey: objectKey,
            title: t('upload.duplicate.skip.title'),
            message: t('upload.duplicate.skip.message', { fileName }),
            info: t('upload.duplicate.skip.info', {
              dateTaken:
                existingPhoto.dateTaken || t('common.unknown', 'unknown date'),
            }),
          }
        }
        // 'warn' 模式：继续上传但返回警告信息
      }
    }

    const isTencentCos =
      storageProvider.config &&
      'endpoint' in storageProvider.config &&
      typeof storageProvider.config.endpoint === 'string' &&
      storageProvider.config.endpoint.includes('myqcloud.com')

    // 若存储提供商支持预签名 URL，返回外部直传地址。
    // Tencent COS often blocks browser PUT requests unless bucket CORS is
    // configured explicitly. Use the internal upload endpoint by default for
    // COS so uploads work out-of-the-box after switching storage providers.
    if (storageProvider.getSignedUrl && !isTencentCos) {
      const signedUrl = await storageProvider.getSignedUrl(objectKey, 3600, {
        contentType: contentType || 'application/octet-stream',
      })

      const response: any = {
        signedUrl,
        fileKey: objectKey,
        expiresIn: 3600,
      }

      if (existingPhoto) {
        response.duplicate = true
        response.existingPhoto = existingPhoto
        response.warningInfo = {
          title: t('upload.duplicate.warn.title'),
          message: t('upload.duplicate.warn.message', { fileName }),
          warning: t('upload.duplicate.warn.warning'),
          info: t('upload.duplicate.warn.info', {
            title: existingPhoto.title || fileName,
            dateTaken:
              existingPhoto.dateTaken || t('common.unknown', 'unknown date'),
          }),
        }
      }

      return response
    }

    // 否则回退到内部直传端点（需会话）
    const internalUploadUrl = `/api/photos/upload?key=${encodeURIComponent(objectKey)}`
    const response: any = {
      signedUrl: internalUploadUrl,
      fileKey: objectKey,
      expiresIn: 3600,
    }

    if (existingPhoto) {
      response.duplicate = true
      response.existingPhoto = existingPhoto
      response.warningInfo = {
        title: t('upload.duplicate.warn.title'),
        message: t('upload.duplicate.warn.message', { fileName }),
        warning: t('upload.duplicate.warn.warning'),
        info: t('upload.duplicate.warn.info', {
          title: existingPhoto.title || fileName,
          dateTaken:
            existingPhoto.dateTaken || t('common.unknown', 'unknown date'),
        }),
      }
    }

    return response
  } catch (error) {
    if ((error as any).statusCode) {
      throw error
    }
    logger.chrono.error('Failed to prepare upload:', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to prepare upload',
    })
  }
})
