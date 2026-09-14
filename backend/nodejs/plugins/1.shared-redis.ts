import {
  closeSharedRedis,
  isSharedRedisConfigured,
  parseSharedRedisRequired,
  useSharedRedis,
} from '#server/utils/shared-redis'
import { registerSharedSessionFetchHook } from '#server/utils/authz'
import { registerSharedSessionClearHook } from '#server/utils/shared-session'

export default defineNitroPlugin(async (nitroApp) => {
  // Validate unconditionally so a typo cannot silently disable shared state,
  // even when CFRAME_REDIS_URL happens to be configured.
  const required = parseSharedRedisRequired(process.env.CFRAME_REDIS_REQUIRED)
  registerSharedSessionClearHook(sessionHooks)
  registerSharedSessionFetchHook(sessionHooks)
  if (isSharedRedisConfigured() || required) {
    await useSharedRedis()
  }
  nitroApp.hooks.hook('close', closeSharedRedis)
})
