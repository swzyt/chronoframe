import { useSettingsStore } from '~/stores/settings'

export default defineNuxtRouteMiddleware(async (to, _from) => {
  const settingsStore = useSettingsStore()
  const isOnboarding = to.path.startsWith('/onboarding')

  // Ensure settings are loaded
  if (!settingsStore.isReady) {
    try {
      await settingsStore.initSettings()
    } catch (e) {
      console.error('Failed to load settings in middleware', e)
      // Never expose onboarding when setup state cannot be verified.
      if (isOnboarding) {
        return navigateTo('/')
      }
      return
    }
  }

  const isFirstLaunch = settingsStore.getSetting('system:firstLaunch')

  if (isFirstLaunch === true) {
    if (!isOnboarding) {
      return navigateTo('/onboarding')
    }
  } else if (isOnboarding) {
    return navigateTo('/')
  }
})
