import { logger } from '~~/server/utils/logger'
import { settingsManager } from '~~/server/services/settings/settingsManager'

export default eventHandler(async (event) => {
  const token = getRouterParam(event, 'token') || ''
  const { share } = await requireUploadShare(token)
  const { storageProvider } = useStorageProvider(event)
  const key = getQuery(event).key as string | undefined
  const t = await useTranslation(event)

  if (!key) {
    throw createError({
      statusCode: 400,
      statusMessage: t('upload.error.required.title'),
    })
  }

  const normalizedKey = key.replace(/^\/+/, '')
  if (
    !isUploadShareStorageKey(event, share.ownerUserId, share.id, normalizedKey)
  ) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Storage object not found',
    })
  }

  const contentType =
    getHeader(event, 'content-type') || 'application/octet-stream'

  const config = useRuntimeConfig(event)
  const whitelistEnabled = config.upload.mime.whitelistEnabled

  if (whitelistEnabled) {
    const whitelistStr = config.upload.mime.whitelist
    const allowedTypes = whitelistStr
      ? whitelistStr
          .split(',')
          .map((type: string) => type.trim())
          .filter(Boolean)
      : []

    if (allowedTypes.length > 0 && !allowedTypes.includes(contentType)) {
      throw createError({
        statusCode: 415,
        statusMessage: t('upload.error.invalidType.title'),
      })
    }
  }

  const raw = await readRawBody(event, false)
  if (!raw || !(raw instanceof Buffer)) {
    throw createError({
      statusCode: 400,
      statusMessage: t('upload.error.uploadFailed.title'),
    })
  }

  const maxFileSizeMB =
    (await settingsManager.get<number>('system', 'upload.maxFileSize')) ?? 256
  const maxBytes = maxFileSizeMB * 1024 * 1024
  if (raw.byteLength > maxBytes) {
    throw createError({
      statusCode: 413,
      statusMessage: t('upload.error.tooLarge.title'),
    })
  }

  try {
    await storageProvider.create(normalizedKey, raw, contentType)
  } catch (error) {
    logger.chrono.error('Upload share storage provider create error:', error)
    throw createError({
      statusCode: 500,
      statusMessage: t('upload.error.uploadFailed.title'),
    })
  }

  return { ok: true, key: normalizedKey }
})
