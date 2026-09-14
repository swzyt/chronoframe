import path from 'node:path'

const WINDOWS_DRIVE_PATTERN = /^[a-z]:/i

const containsControlCharacter = (input: string) =>
  Array.from(input).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })

const invalidStoragePath = (label: string) =>
  new Error(`Invalid ${label}: expected a safe relative path`)

export function normalizeStorageRelativePath(
  input: string,
  label: string,
  allowEmpty = false,
): string {
  if (
    containsControlCharacter(input) ||
    input.includes('\\') ||
    path.posix.isAbsolute(input) ||
    path.win32.isAbsolute(input) ||
    WINDOWS_DRIVE_PATTERN.test(input)
  ) {
    throw invalidStoragePath(label)
  }

  const segments = input.split('/').filter(Boolean)
  if (
    segments.some((segment) => segment === '.' || segment === '..') ||
    (!allowEmpty && segments.length === 0)
  ) {
    throw invalidStoragePath(label)
  }

  return segments.join('/')
}

export function isPathContained(basePath: string, candidatePath: string) {
  const relative = path.relative(basePath, candidatePath)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

export function resolveLocalStorageObjectPath(
  basePath: string,
  prefix: string | undefined,
  key: string,
): { absFile: string; relKey: string } {
  const absoluteBase = path.resolve(basePath)
  const cleanPrefix = normalizeStorageRelativePath(
    prefix || '',
    'storage prefix',
    true,
  )
  const cleanKey = normalizeStorageRelativePath(key, 'storage key')
  const relKey =
    !cleanPrefix ||
    cleanKey === cleanPrefix ||
    cleanKey.startsWith(`${cleanPrefix}/`)
      ? cleanKey
      : `${cleanPrefix}/${cleanKey}`
  const absFile = path.resolve(absoluteBase, relKey)

  if (!isPathContained(absoluteBase, absFile) || absFile === absoluteBase) {
    throw invalidStoragePath('storage key')
  }

  return { absFile, relKey }
}

export function resolveLocalStoragePrefixPath(
  basePath: string,
  prefix: string | undefined,
): { absDirectory: string; relPrefix: string } {
  const absoluteBase = path.resolve(basePath)
  const relPrefix = normalizeStorageRelativePath(
    prefix || '',
    'storage prefix',
    true,
  )
  const absDirectory = path.resolve(absoluteBase, relPrefix)

  if (!isPathContained(absoluteBase, absDirectory)) {
    throw invalidStoragePath('storage prefix')
  }

  return { absDirectory, relPrefix }
}
