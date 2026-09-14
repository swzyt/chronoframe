export const SETTINGS_CACHE_TTL_ENV = 'CFRAME_SETTINGS_CACHE_TTL_MS'
export const DEFAULT_SETTINGS_CACHE_TTL_MS = 5_000
export const SETTINGS_CACHE_VERSION_KEY_ENV =
  'CFRAME_SETTINGS_CACHE_VERSION_KEY'
export const DEFAULT_SETTINGS_CACHE_VERSION_KEY = 'chronoframe:settings:version'

export type CacheLookup<V> =
  | { hit: true; value: V }
  | { hit: false; value?: never }

type CacheEntry<V> = {
  value: V
  expiresAt: number
}

export function parseSettingsCacheTtlMs(rawValue: string | undefined): number {
  if (rawValue === undefined) return DEFAULT_SETTINGS_CACHE_TTL_MS

  if (!/^[1-9]\d*$/.test(rawValue)) {
    throw invalidSettingsCacheTtlError(rawValue)
  }

  const ttlMs = Number(rawValue)
  if (!Number.isSafeInteger(ttlMs)) {
    throw invalidSettingsCacheTtlError(rawValue)
  }

  return ttlMs
}

export function resolveSettingsCacheTtlMs(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return parseSettingsCacheTtlMs(environment[SETTINGS_CACHE_TTL_ENV])
}

export function parseSettingsCacheVersionKey(
  rawValue: string | undefined,
): string {
  if (rawValue === undefined) return DEFAULT_SETTINGS_CACHE_VERSION_KEY

  const value = rawValue.trim()
  if (!value) {
    throw new Error(
      `Invalid ${SETTINGS_CACHE_VERSION_KEY_ENV} value ${JSON.stringify(rawValue)}; expected a non-empty Redis key`,
    )
  }
  return value
}

export function resolveSettingsCacheVersionKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return parseSettingsCacheVersionKey(
    environment[SETTINGS_CACHE_VERSION_KEY_ENV],
  )
}

/** A process-local cache whose entries may be stale for at most one configured TTL. */
export class ExpiringCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('ExpiringCache ttlMs must be a positive safe integer')
    }
  }

  get(key: K): CacheLookup<V> {
    const entry = this.entries.get(key)
    if (!entry) return { hit: false }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return { hit: false }
    }

    return { hit: true, value: entry.value }
  }

  set(key: K, value: V): void {
    this.entries.set(key, {
      value,
      expiresAt: this.now() + this.ttlMs,
    })
  }

  clear(): void {
    this.entries.clear()
  }
}

function invalidSettingsCacheTtlError(rawValue: string): Error {
  return new Error(
    `Invalid ${SETTINGS_CACHE_TTL_ENV} value ${JSON.stringify(rawValue)}; expected a positive base-10 integer in milliseconds`,
  )
}
