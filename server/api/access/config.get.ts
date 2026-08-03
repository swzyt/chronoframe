import { settingsManager } from '~~/server/services/settings/settingsManager'

export default eventHandler(async (event) => {
  await requireAdmin(event)
  const limits = await getPreviewLimits()
  return {
    enabled:
      (await settingsManager.get<boolean>('app', 'access.enabled')) ?? false,
    hasPassword: Boolean(
      await settingsManager.get<string>('app', 'access.passwordHash'),
    ),
    ...limits,
  }
})
