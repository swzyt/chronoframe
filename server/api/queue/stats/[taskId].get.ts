import z from 'zod'
import { and, eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const user = await requireCurrentUser(event)

  try {
    const { taskId } = await getValidatedRouterParams(
      event,
      z.object({
        taskId: z.string().nonempty(),
      }).parse,
    )

    const numericTaskId = Number(taskId)
    const taskStats = useDB()
      .select()
      .from(tables.pipelineQueue)
      .where(
        user.isAdmin
          ? eq(tables.pipelineQueue.id, numericTaskId)
          : and(
              eq(tables.pipelineQueue.id, numericTaskId),
              eq(tables.pipelineQueue.ownerUserId, user.id),
            ),
      )
      .get()
    if (!taskStats) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Task not found',
      })
    }

    return taskStats
  } catch (error: any) {
    if (error?.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage:
        error instanceof Error ? error.message : 'Failed to get queue status',
    })
  }
})
