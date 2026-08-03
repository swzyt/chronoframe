import { z } from 'zod'
import { settingsManager } from '~~/server/services/settings/settingsManager'

export default eventHandler(async (event) => {
  const body = await readValidatedBody(
    event,
    z.discriminatedUnion('provider', [
      z.object({
        provider: z.literal('mapbox'),
        token: z.string().min(1),
        style: z.string().optional(),
      }),
      z.object({
        provider: z.literal('maplibre'),
        token: z.string().min(1),
        style: z.string().optional(),
      }),
      z.object({
        provider: z.literal('amap'),
        key: z.string().min(1),
        securityJsCode: z.string().min(1),
      }),
    ]).parse,
  )

  await settingsManager.set('map', 'provider', body.provider)

  if (body.provider === 'amap') {
    await settingsManager.set('map', 'amap.key', body.key)
    await settingsManager.set(
      'map',
      'amap.securityJsCode',
      body.securityJsCode,
    )
  } else if (body.provider === 'mapbox') {
    await settingsManager.set('map', 'mapbox.token', body.token)
    if (body.style) await settingsManager.set('map', 'mapbox.style', body.style)
  } else {
    await settingsManager.set('map', 'maplibre.token', body.token)
    if (body.style)
      await settingsManager.set('map', 'maplibre.style', body.style)
  }

  return { success: true }
})
