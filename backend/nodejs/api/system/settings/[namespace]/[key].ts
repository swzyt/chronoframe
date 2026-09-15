import { z } from 'zod'
import {
  settingKeys,
  settingNamespaces,
} from '#server/services/settings/contants'
import { settingsManager } from '#server/services/settings/settingsManager'
import {
  assertGoBackendReadyForSwitch,
  normalizeBackendProvider,
} from '#server/utils/backend-routing'

export default eventHandler(async (event) => {
  const user = await requireAdmin(event)

  const { namespace, key } = await getValidatedRouterParams(
    event,
    z.object({
      namespace: z.enum([...settingNamespaces]),
      key: z.enum([...settingKeys]),
    }).parse,
  )

  if (event.method === 'GET') {
    try {
      const value = await settingsManager.get(namespace, key)
      return { namespace, key, value }
    } catch {
      throw createError({
        statusCode: 404,
        statusMessage: `Setting ${namespace}:${key} not found`,
      })
    }
  }

  if (event.method === 'PUT') {
    const { value } = await readValidatedBody(
      event,
      z.object({
        value: z.any(),
      }).parse,
    )

    try {
      if (
        namespace === 'system' &&
        key === 'backend.readProvider' &&
        normalizeBackendProvider(value) === 'go'
      ) {
        await assertGoBackendReadyForSwitch(event)
      }
      await settingsManager.set(namespace, key, value, user.id)
      return { namespace, key, value }
    } catch (err) {
      throw createError({
        statusCode: 400,
        statusMessage: (err as Error).message || 'Failed to update setting',
      })
    }
  }

  throw createError({ statusCode: 405 })
})
