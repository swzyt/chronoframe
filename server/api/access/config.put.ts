import { z } from 'zod'
import { settingsManager } from '~~/server/services/settings/settingsManager'

export default eventHandler(async (event) => {
  const user = await requireAdmin(event)
  const body = await readValidatedBody(
    event,
    z.object({
      enabled: z.boolean(),
      password: z.string().min(8).max(128).optional(),
      photoLimit: z.number().int().min(1).max(10000),
      albumLimit: z.number().int().min(1).max(10000),
    }).parse,
  )
  const existingHash =
    (await settingsManager.get<string>('app', 'access.passwordHash')) || ''
  if (body.enabled && !body.password && !existingHash) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Set an access password before enabling protection',
    })
  }
  if (body.password) {
    await settingsManager.set(
      'app',
      'access.passwordHash',
      await hashPassword(body.password),
      user.id,
    )
  }
  await settingsManager.set('app', 'access.enabled', body.enabled, user.id)
  await settingsManager.set(
    'app',
    'access.previewPhotoLimit',
    body.photoLimit,
    user.id,
  )
  await settingsManager.set(
    'app',
    'access.previewAlbumLimit',
    body.albumLimit,
    user.id,
  )
  const version =
    ((await settingsManager.get<number>('app', 'access.version')) ?? 1) + 1
  await settingsManager.set('app', 'access.version', version, user.id, true)
  return {
    enabled: body.enabled,
    hasPassword: Boolean(body.password || existingHash),
    photoLimit: body.photoLimit,
    albumLimit: body.albumLimit,
  }
})
