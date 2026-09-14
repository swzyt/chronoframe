import { promises as fs } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'

type LocalStorageConfig = {
  provider: 'local'
  basePath: string
  prefix?: string
}

const sanitizeKey = (key: string) =>
  key.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')

const normalizePrefix = (prefix?: string) =>
  sanitizeKey(prefix || '').replace(/\/+$/, '')

const isLocalConfig = (config: unknown): config is LocalStorageConfig => {
  if (!config || typeof config !== 'object') return false
  const value = config as Record<string, unknown>
  return value.provider === 'local' && typeof value.basePath === 'string'
}

const resolveInsideBase = (basePath: string, relativeKey: string) => {
  const base = path.resolve(basePath)
  const absolute = path.resolve(base, relativeKey)
  if (absolute !== base && !absolute.startsWith(base + path.sep)) return null
  return absolute
}

const localCandidateKeys = (key: string, prefix?: string) => {
  const cleanKey = sanitizeKey(key)
  const cleanPrefix = normalizePrefix(prefix)
  const candidates = [cleanKey]

  if (cleanPrefix && !cleanKey.startsWith(`${cleanPrefix}/`)) {
    candidates.push(`${cleanPrefix}/${cleanKey}`)
  }

  return [...new Set(candidates)]
}

export async function getLegacyLocalMedia(key: string): Promise<Buffer | null> {
  const defaultLocalBase = path.resolve(process.cwd(), 'data/storage')
  for (const candidate of localCandidateKeys(key)) {
    const absolute = resolveInsideBase(defaultLocalBase, candidate)
    if (!absolute) continue

    try {
      const stat = await fs.stat(absolute)
      if (!stat.isFile()) continue
      return await fs.readFile(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  const localProviders = useDB()
    .select({ config: tables.settings_storage_providers.config })
    .from(tables.settings_storage_providers)
    .where(eq(tables.settings_storage_providers.provider, 'local'))
    .all()

  for (const provider of localProviders) {
    let config: unknown
    try {
      config = JSON.parse(provider.config)
    } catch {
      continue
    }

    if (!isLocalConfig(config)) continue

    for (const candidate of localCandidateKeys(key, config.prefix)) {
      const absolute = resolveInsideBase(config.basePath, candidate)
      if (!absolute) continue

      try {
        const stat = await fs.stat(absolute)
        if (!stat.isFile()) continue
        return await fs.readFile(absolute)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
  }

  return null
}
