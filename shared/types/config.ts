import type { StorageConfig } from '../../backend/nodejs/services/storage'

export interface ChronoConfig {
  storage: StorageConfig
}

export interface MatomoConfig {
  enabled: boolean
  url: string
  siteId: string
}

export interface AnalyticsConfig {
  matomo: MatomoConfig
}
