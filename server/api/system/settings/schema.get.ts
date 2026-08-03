import { settingsManager } from '~~/server/services/settings/settingsManager'

export default eventHandler(async (event) => {
  await requireAdmin(event)

  const settingsSchema = settingsManager.getSchema()
  return settingsSchema
})
