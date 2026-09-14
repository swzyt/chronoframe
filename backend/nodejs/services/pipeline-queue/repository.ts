import type { NewPipelineQueueItem } from '../../utils/db'
import { tables, useDB } from '../../utils/db'

export type PipelineQueuePayload = NonNullable<NewPipelineQueueItem['payload']>

export interface EnqueuePipelineTaskOptions {
  ownerUserId: number
  priority?: number
  maxAttempts?: number
}

/**
 * SQLite-backed queue producer that does not depend on a running consumer.
 */
export async function enqueuePipelineTask(
  payload: PipelineQueuePayload,
  options: EnqueuePipelineTaskOptions,
): Promise<number> {
  if (!Number.isSafeInteger(options.ownerUserId) || options.ownerUserId <= 0) {
    throw new TypeError('ownerUserId must be a positive safe integer')
  }

  const result = useDB()
    .insert(tables.pipelineQueue)
    .values({
      payload,
      ownerUserId: options.ownerUserId,
      priority: options.priority,
      maxAttempts: options.maxAttempts,
    })
    .returning({ id: tables.pipelineQueue.id })
    .get()

  return result.id
}
