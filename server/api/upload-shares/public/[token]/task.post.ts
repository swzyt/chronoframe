import { z } from 'zod'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token') || ''
  const { share } = await requireUploadShare(token)
  const { storageProvider } = useStorageProvider(event)
  const payloadSchema = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('photo'),
      storageKey: z.string().nonempty(),
      eraseLocation: z.boolean().optional(),
    }),
    z.object({
      type: z.literal('live-photo-video'),
      storageKey: z.string().nonempty(),
    }),
    z.object({
      type: z.literal('video'),
      storageKey: z.string().nonempty(),
    }),
  ])

  const { payload } = await readValidatedBody(
    event,
    z.object({ payload: payloadSchema }).parse,
  )

  if (
    !isUploadShareStorageKey(event, share.ownerUserId, share.id, payload.storageKey)
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

  const workerPool = globalThis.__workerPool
  if (!workerPool) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Worker pool not initialized',
    })
  }

  const priority = payload.type === 'live-photo-video' ? 0 : 1
  const taskId = await workerPool.addTask(payload, {
    priority,
    maxAttempts: 3,
    ownerUserId: share.ownerUserId,
  })

  markUploadShareUsed(share.id)

  return {
    success: true,
    taskId,
    message: 'Task added to queue successfully',
    payload,
  }
})
