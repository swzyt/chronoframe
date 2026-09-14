import type { WorkerPool } from '../../backend/nodejs/services/pipeline-queue'

declare global {
  var __workerPool: WorkerPool | undefined
}

export {}
