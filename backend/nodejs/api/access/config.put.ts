import { z } from 'zod'
import {
  AccessPasswordRequiredError,
  updateAccessSecurityConfiguration,
} from '#server/utils/site-access'

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
  const passwordHash = body.password
    ? await hashPassword(body.password)
    : undefined
  let result: ReturnType<typeof updateAccessSecurityConfiguration>
  try {
    result = updateAccessSecurityConfiguration({
      enabled: body.enabled,
      passwordHash,
      photoLimit: body.photoLimit,
      albumLimit: body.albumLimit,
      updatedBy: user.id,
    })
  } catch (error) {
    if (error instanceof AccessPasswordRequiredError) {
      throw createError({
        statusCode: 400,
        statusMessage: error.message,
      })
    }
    throw error
  }
  return {
    enabled: body.enabled,
    hasPassword: result.hasPassword,
    photoLimit: body.photoLimit,
    albumLimit: body.albumLimit,
  }
})
