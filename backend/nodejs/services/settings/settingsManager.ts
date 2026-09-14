import type {
  NewSettingStorageProvider,
  SettingConfig,
  SettingStorageProvider,
  SettingValue,
} from '~~/shared/types/settings'
import { useSharedRedis } from '../../utils/shared-redis'
import {
  ExpiringCache,
  resolveSettingsCacheVersionKey,
  resolveSettingsCacheTtlMs,
} from '../../utils/settings-cache'
import {
  decodeSettingValue,
  encodeSettingValue,
} from '../../utils/settings-value'
import type { SettingKey, SettingNamespace } from './contants'

export class SettingsManager {
  private static instance: SettingsManager
  protected settingsCache = new ExpiringCache<string, SettingValue>(
    resolveSettingsCacheTtlMs(),
  )
  protected settingsCacheVersionKey = resolveSettingsCacheVersionKey()
  protected observedSharedSettingsVersion: string | null = null
  protected _logger = logger.dynamic('settings-mgr')
  protected isInitializing = false

  private constructor() {}

  static getInstance(): SettingsManager {
    if (!SettingsManager.instance) {
      SettingsManager.instance = new SettingsManager()
    }
    return SettingsManager.instance
  }

  /**
   * Set the initializing flag externally
   * Used during plugin initialization to prevent storage provider switch triggers
   * @param flag Boolean flag to set
   */
  setInitializingFlag(flag: boolean): void {
    this.isInitializing = flag
  }

  /**
   * Check if currently initializing
   * @returns true if initializing, false otherwise
   */
  isInitializing_(): boolean {
    return this.isInitializing
  }

  /**
   * Validate setting value against enum if defined
   * @param value Setting value
   * @param enumValues Enum values if defined
   * @returns true if valid, false if not valid
   */
  private validateEnum(
    value: SettingValue,
    enumValues: string[] | null,
  ): boolean {
    // Allow null values if no enum is defined
    if (value === null) {
      return !enumValues || enumValues.length === 0
    }

    if (!enumValues || enumValues.length === 0) {
      return true
    }
    return enumValues.includes(String(value))
  }

  /**
   * Generate cache key for a setting
   * @param namespace
   * @param key
   * @returns Cache key string
   * @example
   * getCacheKey('app', 'theme') => 'app:theme'
   */
  private getCacheKey(
    namespace: SettingNamespace,
    key: SettingKey<typeof namespace>,
  ): string {
    return `${namespace}:${key}`
  }

  /**
   * Initialize settings manager with default settings
   * @param configs Array of setting configurations
   */
  async init(configs: SettingConfig[]): Promise<void> {
    const db = useDB()

    this._logger.info('Initializing settings manager with default settings')

    for (const config of configs) {
      // Skip if namespace or key is missing
      if (!config.namespace || !config.key) {
        this._logger.warn('Skipping config with missing namespace or key')
        continue
      }

      const encodedDefault = encodeSettingValue(
        config.type,
        config.defaultValue,
      )

      // Check if setting exists
      const existing = db
        .select()
        .from(tables.settings)
        .where(
          and(
            eq(tables.settings.namespace, config.namespace),
            eq(tables.settings.key, config.key),
          ),
        )
        .get()

      // If not exists and has default value, insert it
      if (!existing) {
        db.insert(tables.settings)
          .values({
            namespace: config.namespace,
            key: config.key,
            type: config.type,
            value: encodedDefault.stored,
            defaultValue: encodedDefault.stored,
            label: config.label,
            description: config.description,
            isPublic: config.isPublic,
            isReadonly: config.isReadonly,
            isSecret: config.isSecret,
            enum: config.enum ? [...config.enum] : null,
          })
          .run()
      } else {
        // Keep persisted values, but synchronize schema metadata so newly added
        // enum members and visibility/security changes also apply to upgrades.
        db.update(tables.settings)
          .set({
            type: config.type,
            defaultValue: encodedDefault.stored,
            label: config.label,
            description: config.description,
            isPublic: config.isPublic ?? false,
            isReadonly: config.isReadonly ?? false,
            isSecret: config.isSecret ?? false,
            enum: config.enum ? [...config.enum] : null,
          })
          .where(eq(tables.settings.id, existing.id))
          .run()
      }
    }
  }

  async get<T = SettingValue>(
    namespace: SettingNamespace,
    key: SettingKey<typeof namespace>,
    defaultValue?: T,
  ): Promise<T | null> {
    await this.refreshSharedSettingsCacheVersion()

    const cacheKey = this.getCacheKey(namespace, key)

    // Check cache first
    const cached = this.settingsCache.get(cacheKey)
    if (cached.hit) {
      this._logger.debug(`Cache hit for setting ${cacheKey}`)
      return cached.value as T
    }

    // If not in cache, fetch from database
    const db = useDB()
    const setting = db
      .select()
      .from(tables.settings)
      .where(
        and(
          eq(tables.settings.namespace, namespace),
          eq(tables.settings.key, key),
        ),
      )
      .get()

    // If not found, return default value
    if (!setting) {
      this._logger.debug(
        `Setting ${cacheKey} not found, returning default value`,
      )
      return defaultValue ?? null
    }

    this._logger.debug(`Setting ${cacheKey} fetched from database`)
    const value = decodeSettingValue(setting.type, setting.value)
    this.settingsCache.set(cacheKey, value)

    return value as T
  }

  async set(
    namespace: SettingNamespace,
    key: SettingKey<typeof namespace>,
    value: SettingValue,
    updatedBy?: number,
    sudo = false,
  ): Promise<void> {
    const db = useDB()
    const cacheKey = this.getCacheKey(namespace, key)
    await this.refreshSharedSettingsCacheVersion()

    const existing = db
      .select()
      .from(tables.settings)
      .where(
        and(
          eq(tables.settings.namespace, namespace),
          eq(tables.settings.key, key),
        ),
      )
      .get()

    if (!existing) {
      this._logger.warn(`Setting ${namespace}:${key} does not exist`)
      throw new Error(`Setting ${namespace}:${key} does not exist`)
    }

    if (existing.isReadonly && !sudo) {
      this._logger.warn(
        `Attempt to modify readonly setting ${namespace}:${key}`,
      )
      throw new Error(`Setting ${namespace}:${key} is readonly`)
    }

    let encodedValue
    try {
      encodedValue = encodeSettingValue(existing.type, value)
    } catch (error) {
      throw new Error(
        `Invalid value for setting ${namespace}:${key}: ${(error as Error).message}`,
      )
    }

    if (!this.validateEnum(encodedValue.value, existing.enum)) {
      this._logger.warn(
        `Invalid value for enum setting ${namespace}:${key}. Value: ${encodedValue.value}, allowed: ${existing.enum?.join(', ')}`,
      )
      throw new Error(
        `Invalid value for setting ${namespace}:${key}. Allowed values: ${existing.enum?.join(', ')}`,
      )
    }

    db.update(tables.settings)
      .set({
        value: encodedValue.stored,
        updatedAt: new Date(),
        updatedBy: updatedBy ?? null,
      })
      .where(
        and(
          eq(tables.settings.namespace, namespace),
          eq(tables.settings.key, key),
        ),
      )
      .run()

    this._logger.info(`Setting ${namespace}:${key} updated`)
    await this.publishSharedSettingsCacheVersion()
    this.settingsCache.set(cacheKey, encodedValue.value)

    // Trigger storage provider switch if storage:provider is being changed
    // Skip during initialization as storage manager is not yet initialized
    if (namespace === 'storage' && key === 'provider' && !this.isInitializing) {
      // Use setImmediate to avoid blocking and handle async operation
      setImmediate(() => {
        this.triggerStorageProviderSwitch(encodedValue.value as number).catch(
          (error) => {
            this._logger.error(
              'Failed to trigger storage provider switch:',
              error,
            )
          },
        )
      })
    }
  }

  private async refreshSharedSettingsCacheVersion(): Promise<void> {
    let redis
    try {
      redis = await useSharedRedis()
    } catch (error) {
      this._logger.warn('Failed to read shared settings cache version', error)
      return
    }
    if (!redis) {
      this.observedSharedSettingsVersion = null
      return
    }

    let version: string | null
    try {
      version = await redis.get(this.settingsCacheVersionKey)
    } catch (error) {
      this._logger.warn('Failed to read shared settings cache version', error)
      return
    }

    const normalizedVersion = version ?? '0'
    if (this.observedSharedSettingsVersion === null) {
      this.observedSharedSettingsVersion = normalizedVersion
      return
    }
    if (this.observedSharedSettingsVersion !== normalizedVersion) {
      this.settingsCache.clear()
      this.observedSharedSettingsVersion = normalizedVersion
    }
  }

  private async publishSharedSettingsCacheVersion(): Promise<void> {
    let redis
    try {
      redis = await useSharedRedis()
    } catch (error) {
      this._logger.warn(
        'Failed to publish shared settings cache version',
        error,
      )
      return
    }
    if (!redis) {
      this.observedSharedSettingsVersion = null
      return
    }

    try {
      const version = await redis.incr(this.settingsCacheVersionKey)
      this.observedSharedSettingsVersion = String(version)
    } catch (error) {
      this._logger.warn(
        'Failed to publish shared settings cache version',
        error,
      )
    }
  }

  /**
   * Trigger storage provider switch
   * @param providerId Provider ID to switch to
   */
  async triggerStorageProviderSwitch(providerId: number): Promise<void> {
    try {
      // Dynamically import to avoid circular dependency issues
      const { getGlobalStorageManager, setGlobalStorageManager } =
        await import('#server/services/storage/events')
      const { StorageManager } = await import('#server/services/storage')
      const loggerModule = await import('#server/utils/logger')

      const newProvider = await this.storage.getProviderById(providerId)
      if (!newProvider) {
        this._logger.error(`Provider with ID ${providerId} not found`)
        return
      }

      let storageManager = getGlobalStorageManager()
      if (!storageManager) {
        this._logger.info(
          `Storage manager not initialized, bootstrapping with provider: ${newProvider.name} (ID: ${providerId})`,
        )
        try {
          storageManager = new StorageManager(
            newProvider.config,
            loggerModule.logger.dynamic('storage'),
          )
          setGlobalStorageManager(storageManager)

          if (newProvider.config.provider === 'local') {
            const fs = await import('node:fs/promises')
            await fs.mkdir(newProvider.config.basePath, { recursive: true })
          }

          this._logger.info('Storage manager bootstrap completed')
          return
        } catch (bootstrapError) {
          this._logger.error(
            'Failed to bootstrap storage manager with new provider:',
            bootstrapError,
          )
          return
        }
      }

      this._logger.info(
        `Triggering storage provider switch to: ${newProvider.name} (ID: ${providerId})`,
      )

      await storageManager.registerProvider(
        newProvider.config,
        loggerModule.logger.dynamic('storage'),
      )
    } catch (error) {
      this._logger.error('Failed to switch storage provider:', error)
    }
  }

  async getNamespace(
    namespace: SettingNamespace,
  ): Promise<Record<string, SettingValue>> {
    const db = useDB()
    const settings = db
      .select()
      .from(tables.settings)
      .where(eq(tables.settings.namespace, namespace))
      .all()

    const result: Record<string, SettingValue> = {}

    for (const setting of settings) {
      result[setting.key] = decodeSettingValue(setting.type, setting.value)
    }
    return result
  }

  async getSchema(): Promise<SettingConfig[]> {
    const db = useDB()
    const settings = db.select().from(tables.settings).all()

    return settings.map((setting) => ({
      namespace: setting.namespace,
      key: setting.key,
      type: setting.type,
      value: decodeSettingValue(setting.type, setting.value),
      defaultValue:
        setting.defaultValue &&
        decodeSettingValue(setting.type, setting.defaultValue),
      label: setting.label,
      description: setting.description,
      isReadonly: setting.isReadonly,
      isSecret: setting.isSecret,
      // 包含枚举值，过滤掉 null
      ...(setting.enum ? { enum: setting.enum } : {}),
    }))
  }

  // Storage Providers Management
  public storage = {
    async getProviders(): Promise<SettingStorageProvider[]> {
      const db = useDB()
      const providers = db
        .select()
        .from(tables.settings_storage_providers)
        .all()
      return providers
    },

    async getProviderById(id: number): Promise<SettingStorageProvider | null> {
      const db = useDB()
      const provider = db
        .select()
        .from(tables.settings_storage_providers)
        .where(eq(tables.settings_storage_providers.id, id))
        .get()
      return provider || null
    },

    async getActiveProvider(): Promise<SettingStorageProvider | null> {
      const providerId = await settingsManager.get<number>(
        'storage',
        'provider',
      )
      if (!providerId) {
        return null
      }
      return this.getProviderById(providerId)
    },

    async addProvider(
      providerConfig: NewSettingStorageProvider,
    ): Promise<number> {
      const db = useDB()
      const result = db
        .insert(tables.settings_storage_providers)
        .values({
          name: providerConfig.name,
          provider: providerConfig.provider,
          config: providerConfig.config,
        })
        .run()

      // If no active provider and this is the only provider, set this as active
      const currentActiveProvider = await settingsManager.get<number>(
        'storage',
        'provider',
      )
      if (!currentActiveProvider && (await this.getProviders()).length === 1) {
        await settingsManager.set(
          'storage',
          'provider',
          result.lastInsertRowid as number,
        )
      }
      return result.lastInsertRowid as number
    },

    async updateProvider(
      id: number,
      providerConfig: Partial<NewSettingStorageProvider['config']>,
    ): Promise<void> {
      const db = useDB()
      db.update(tables.settings_storage_providers)
        .set({
          ...providerConfig,
          updatedAt: new Date(),
        })
        .where(eq(tables.settings_storage_providers.id, id))
        .run()

      const activeProviderId = await settingsManager.get<number>(
        'storage',
        'provider',
      )
      if (activeProviderId === id) {
        setImmediate(() => {
          settingsManager.triggerStorageProviderSwitch(id).catch((error) => {
            settingsManager._logger.error(
              'Failed to refresh active storage provider:',
              error,
            )
          })
        })
      }
    },

    async deleteProvider(id: number): Promise<void> {
      const db = useDB()
      db.delete(tables.settings_storage_providers)
        .where(eq(tables.settings_storage_providers.id, id))
        .run()
    },
  }
}

export const settingsManager = SettingsManager.getInstance()
