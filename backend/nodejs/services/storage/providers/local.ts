import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LocalStorageConfig } from '../../../../shared/types/storage'
import type { Logger } from '../../../utils/logger'
import type {
  StorageObject,
  StorageProvider,
  StorageReadOptions,
} from '../interfaces'
import {
  isPathContained,
  normalizeStorageRelativePath,
  resolveLocalStorageObjectPath,
  resolveLocalStoragePrefixPath,
} from '../../../utils/local-storage-path'

const ensureDir = async (dirPath: string) => {
  await fs.mkdir(dirPath, { recursive: true })
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (!signal?.aborted) return
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  throw error
}

export class LocalStorageProvider implements StorageProvider {
  config: LocalStorageConfig
  private logger?: Logger['storage']

  constructor(config: LocalStorageConfig, logger?: Logger['storage']) {
    // Validate the configured prefix before the provider can serve requests.
    resolveLocalStoragePrefixPath(config.basePath, config.prefix)
    this.config = config
    this.logger = logger
  }

  private resolveAbsoluteKey(key: string): { absFile: string; relKey: string } {
    return resolveLocalStorageObjectPath(
      this.config.basePath,
      this.config.prefix,
      key,
    )
  }

  private async assertExistingPathContained(absPath: string): Promise<void> {
    const absoluteBase = path.resolve(this.config.basePath)
    const [realBase, realPath] = await Promise.all([
      fs.realpath(absoluteBase),
      fs.realpath(absPath),
    ])

    if (!isPathContained(realBase, realPath)) {
      throw new Error('Resolved local storage path escapes basePath')
    }
  }

  private async prepareParentDirectory(absFile: string): Promise<void> {
    const absoluteBase = path.resolve(this.config.basePath)
    await ensureDir(absoluteBase)
    const realBase = await fs.realpath(absoluteBase)
    let existingAncestor = path.dirname(absFile)

    while (isPathContained(absoluteBase, existingAncestor)) {
      try {
        const realAncestor = await fs.realpath(existingAncestor)
        if (!isPathContained(realBase, realAncestor)) {
          throw new Error('Resolved local storage path escapes basePath')
        }
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }

        const parent = path.dirname(existingAncestor)
        if (parent === existingAncestor) {
          throw error
        }
        existingAncestor = parent
      }
    }

    await ensureDir(path.dirname(absFile))
    await this.assertExistingPathContained(path.dirname(absFile))
  }

  async create(key: string, fileBuffer: Buffer): Promise<StorageObject> {
    const { absFile, relKey } = this.resolveAbsoluteKey(key)
    await this.prepareParentDirectory(absFile)
    // 原子写入：写到临时文件再重命名
    const tempFile = `${absFile}.tmp-${Date.now()}`
    await fs.writeFile(tempFile, fileBuffer)
    await fs.rename(tempFile, absFile)
    const stat = await fs.stat(absFile)
    this.logger?.success?.(`Saved file: ${absFile}`)
    return {
      key: relKey,
      size: stat.size,
      lastModified: stat.mtime,
    }
  }

  async delete(key: string): Promise<void> {
    const { absFile } = this.resolveAbsoluteKey(key)
    try {
      await this.assertExistingPathContained(absFile)
      await fs.unlink(absFile)
      this.logger?.success?.(`Deleted file: ${absFile}`)
    } catch (err) {
      // ignore if not exists
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  async get(
    key: string,
    options: StorageReadOptions = {},
  ): Promise<Buffer | null> {
    const { absFile } = this.resolveAbsoluteKey(key)
    try {
      throwIfAborted(options.signal)
      await this.assertExistingPathContained(absFile)
      const data = await fs.readFile(absFile, { signal: options.signal })
      throwIfAborted(options.signal)
      return data
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async getStream(
    key: string,
    options: StorageReadOptions = {},
  ): Promise<NodeJS.ReadableStream | null> {
    const { absFile } = this.resolveAbsoluteKey(key)
    try {
      throwIfAborted(options.signal)
      await this.assertExistingPathContained(absFile)
      return createReadStream(absFile, { signal: options.signal })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async getRange(
    key: string,
    start: number,
    end: number,
    options: StorageReadOptions = {},
  ): Promise<Buffer | null> {
    const { absFile } = this.resolveAbsoluteKey(key)
    const length = end - start + 1
    const buffer = Buffer.alloc(length)
    let handle: fs.FileHandle | undefined

    try {
      throwIfAborted(options.signal)
      await this.assertExistingPathContained(absFile)
      throwIfAborted(options.signal)
      handle = await fs.open(absFile, 'r')
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      throwIfAborted(options.signal)
      return buffer.subarray(0, bytesRead)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    } finally {
      await handle?.close()
    }
  }

  async getRangeStream(
    key: string,
    start: number,
    end: number,
    options: StorageReadOptions = {},
  ): Promise<NodeJS.ReadableStream | null> {
    const { absFile } = this.resolveAbsoluteKey(key)
    try {
      throwIfAborted(options.signal)
      await this.assertExistingPathContained(absFile)
      return createReadStream(absFile, { start, end, signal: options.signal })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  getPublicUrl(key: string): string {
    const { relKey } = this.resolveAbsoluteKey(key)
    const base = (this.config.baseUrl || '/storage').replace(/\/+$/, '')
    return `${base}/${relKey}`
  }

  async listAll(): Promise<StorageObject[]> {
    const results: StorageObject[] = []
    const { absDirectory: baseDir, relPrefix } = resolveLocalStoragePrefixPath(
      this.config.basePath,
      this.config.prefix,
    )

    const walk = async (dir: string, relBase: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const abs = path.join(dir, entry.name)
        const rel = normalizeStorageRelativePath(
          [relBase, entry.name].filter(Boolean).join('/'),
          'storage key',
        )
        if (entry.isDirectory()) {
          await walk(abs, rel)
        } else if (entry.isFile()) {
          const stat = await fs.stat(abs)
          results.push({ key: rel, size: stat.size, lastModified: stat.mtime })
        }
      }
    }

    // Validate the deepest existing ancestor before creating a configured
    // prefix. Otherwise a prefix that traverses a symlink could make mkdir
    // write outside basePath.
    await this.prepareParentDirectory(path.join(baseDir, '.list-anchor'))
    await this.assertExistingPathContained(baseDir)
    await walk(baseDir, relPrefix)
    return results
  }

  async listImages(): Promise<StorageObject[]> {
    const all = await this.listAll()
    return all.filter((o) => /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(o.key))
  }

  async getFileMeta(
    key: string,
    options: StorageReadOptions = {},
  ): Promise<StorageObject | null> {
    // First try with combined prefix
    const { absFile, relKey } = this.resolveAbsoluteKey(key)
    try {
      throwIfAborted(options.signal)
      await this.assertExistingPathContained(absFile)
      throwIfAborted(options.signal)
      const stat = await fs.stat(absFile)
      if (!stat.isFile()) return null
      return { key: relKey, size: stat.size, lastModified: stat.mtime }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    // Fallback: try without adding prefix (in case key already contains it or was stored raw)
    const { absFile: rawAbs, relKey: rawRel } = resolveLocalStorageObjectPath(
      this.config.basePath,
      undefined,
      key,
    )
    try {
      throwIfAborted(options.signal)
      await this.assertExistingPathContained(rawAbs)
      throwIfAborted(options.signal)
      const stat = await fs.stat(rawAbs)
      if (!stat.isFile()) return null
      return { key: rawRel, size: stat.size, lastModified: stat.mtime }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }
}
