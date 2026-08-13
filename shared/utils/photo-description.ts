const MACHINE_METADATA_KEYS = new Set([
  'ARInfo',
  'BeautyInfo',
  'FaceliftInfo',
  'FilterInfo',
  'HandlerInfo',
  'MakeupInfo',
])

const hasMachineMetadataShape = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.some((key) => MACHINE_METADATA_KEYS.has(key))) {
    return true
  }

  return keys.length > 0 && keys.every((key) => {
    const item = (value as Record<string, unknown>)[key]
    return (
      key.endsWith('Info') &&
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item)
    )
  })
}

export const isMachineGeneratedDescription = (value: unknown): boolean => {
  if (typeof value !== 'string') return false

  const text = value.trim()
  if (!text) return false
  if (!/^[{[]/.test(text)) return false

  try {
    const parsed = JSON.parse(text)
    return hasMachineMetadataShape(parsed)
  } catch {
    return false
  }
}

export const normalizePhotoDescription = (value: unknown): string => {
  if (value === null || value === undefined) return ''

  const text = String(value).trim()
  if (!text || isMachineGeneratedDescription(text)) return ''

  return text
}
