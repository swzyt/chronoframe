import { z } from 'zod'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token') || ''
  const { share } = await requireUploadShare(token)
  const { storageProvider } = useStorageProvider(event)
  const payloadSchema = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('photo'),
      storageKey: z.string().nonempty(),
      contentHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
      eraseLocation: z.boolean().optional(),
    }),
    z.object({
      type: z.literal('live-photo-video'),
      storageKey: z.string().nonempty(),
    }),
    z.object({
      type: z.literal('video'),
      storageKey: z.string().nonempty(),
      contentHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
    }),
  ])

  const { payload } = await readValidatedBody(
    event,
    z.object({ payload: payloadSchema }).parse,
  )

  if (
    !isUploadShareStorageKey(
      event,
      share.ownerUserId,
      share.id,
      payload.storageKey,
    )
  ) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Storage object not found',
    })
  }

  let storageObject = await storageProvider.getFileMeta(payload.storageKey)
  if (!storageObject) {
    const maybeBuffer = await storageProvider.get(payload.storageKey)
    if (maybeBuffer) {
      storageObject = {
        key: payload.storageKey,
        size: maybeBuffer.length,
        lastModified: new Date(),
      }
    }
  }
  if (!storageObject) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Storage object not found',
    })
  }

  const priority = payload.type === 'live-photo-video' ? 0 : 1
  let taskId = enqueueUploadShareTaskAtomically({
    shareId: share.id,
    ownerUserId: share.ownerUserId,
    payload,
    priority,
    maxAttempts: 3,
  })
  if (taskId === null) {
    // Re-read to preserve the public 404/410/429 error contract while the
    // conditional UPDATE remains the concurrency authority.
    await requireUploadShare(token)
    taskId = enqueueUploadShareTaskAtomically({
      shareId: share.id,
      ownerUserId: share.ownerUserId,
      payload,
      priority,
      maxAttempts: 3,
    })
    if (taskId === null) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Upload link changed, please retry',
      })
    }
  }

  return {
    success: true,
    taskId,
    message: 'Task added to queue successfully',
    payload,
  }
})
