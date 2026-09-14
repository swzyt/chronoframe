import { settingsManager } from '#server/services/settings/settingsManager'
import { assertWizardAvailable } from '#server/utils/setup-security'

export default eventHandler(async (_event) => {
  assertWizardAvailable()

  // Set firstLaunch to false
  // Pass true as the last argument (sudo) to bypass readonly check
  await settingsManager.set('system', 'firstLaunch', false, undefined, true)

  return { success: true }
})
