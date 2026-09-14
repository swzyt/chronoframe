import { useSharedRedis } from './shared-redis'
import { sharedStateEnvironment } from './shared-session'

export function pipelineWorkerTelemetryKey(
  environment = sharedStateEnvironment(),
) {
  return `cf:v1:${environment}:pipeline:worker_pool:stats`
}

export async function publishPipelineWorkerTelemetry(payload: unknown) {
  const redis = await useSharedRedis()
  if (!redis) return
  await redis.set(
    pipelineWorkerTelemetryKey(),
    JSON.stringify(payload),
    { EX: 30 },
  )
}
