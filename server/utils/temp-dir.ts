import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const fallbackTempRoot = path.resolve('data/tmp')

async function ensureTempRoot(root: string) {
  await mkdir(root, { recursive: true })
  return root
}

export async function createTempDir(prefix: string) {
  const safePrefix = prefix.endsWith('-') ? prefix : `${prefix}-`
  const roots = [tmpdir(), fallbackTempRoot]

  let lastError: unknown
  for (const root of roots) {
    try {
      const tempRoot = await ensureTempRoot(root)
      return await mkdtemp(path.join(tempRoot, safePrefix))
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to create temporary directory')
}
