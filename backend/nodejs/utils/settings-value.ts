export const SETTING_TYPES = ['string', 'number', 'boolean', 'json'] as const

export type SettingValueType = (typeof SETTING_TYPES)[number]
export type CanonicalSettingValue =
  | string
  | number
  | boolean
  | Record<string, unknown>
  | null

export type EncodedSettingValue = {
  value: CanonicalSettingValue
  stored: string | null
}

// RFC 8259 JSON-number grammar. Matching the entire stored value intentionally
// excludes JavaScript-only forms such as hexadecimal and surrounding whitespace.
export const JSON_NUMBER_PATTERN =
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

export class InvalidSettingValueError extends Error {
  constructor(type: string) {
    super(`Expected ${expectedTypeDescription(type)}`)
    this.name = 'InvalidSettingValueError'
  }
}

/**
 * Validate an API/runtime value against the declared setting type and return
 * the canonical SQLite TEXT representation used by every Node write path.
 */
export function encodeSettingValue(
  type: SettingValueType,
  input: unknown,
): EncodedSettingValue {
  if (input === null) return { value: null, stored: null }

  switch (type) {
    case 'string':
      if (typeof input !== 'string') throw new InvalidSettingValueError(type)
      return { value: input, stored: input }

    case 'number': {
      if (typeof input !== 'number' || !Number.isFinite(input)) {
        throw new InvalidSettingValueError(type)
      }

      // JSON.stringify follows the RFC 8785/ECMAScript finite-number form and
      // normalizes negative zero to the single canonical representation "0".
      const value = Object.is(input, -0) ? 0 : input
      const stored = JSON.stringify(value)
      if (!JSON_NUMBER_PATTERN.test(stored)) {
        throw new InvalidSettingValueError(type)
      }
      return { value, stored }
    }

    case 'boolean':
      if (typeof input !== 'boolean') throw new InvalidSettingValueError(type)
      return { value: input, stored: input ? 'true' : 'false' }

    case 'json': {
      if (!isJsonObject(input)) throw new InvalidSettingValueError(type)
      assertJsonCompatible(input, new Set())
      const stored = JSON.stringify(input)
      return {
        value: JSON.parse(stored) as Record<string, unknown>,
        stored,
      }
    }
  }

  throw new InvalidSettingValueError(type)
}

/** Decode persisted values without JavaScript's permissive numeric coercion. */
export function decodeSettingValue(
  type: SettingValueType,
  stored: string | null,
): CanonicalSettingValue {
  if (stored === null) return null

  switch (type) {
    case 'string':
      return stored

    case 'number': {
      if (!JSON_NUMBER_PATTERN.test(stored)) return null
      const value = Number(stored)
      if (!Number.isFinite(value)) return null
      return Object.is(value, -0) ? 0 : value
    }

    case 'boolean':
      if (stored === 'true') return true
      if (stored === 'false') return false
      return null

    case 'json':
      try {
        const value: unknown = JSON.parse(stored)
        return isJsonObject(value) ? value : null
      } catch {
        return null
      }
  }

  return null
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertJsonCompatible(value: unknown, ancestors: Set<object>): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InvalidSettingValueError('json')
    return
  }
  if (typeof value !== 'object') throw new InvalidSettingValueError('json')

  if (ancestors.has(value)) throw new InvalidSettingValueError('json')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertJsonCompatible(item, ancestors)
      return
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidSettingValueError('json')
    }
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) {
      throw new InvalidSettingValueError('json')
    }
    for (const item of Object.values(value)) {
      assertJsonCompatible(item, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function expectedTypeDescription(type: string): string {
  switch (type) {
    case 'string':
      return 'a JSON string or null'
    case 'number':
      return 'a finite JSON number or null'
    case 'boolean':
      return 'a JSON boolean or null'
    case 'json':
      return 'a JSON-compatible object or null'
    default:
      return `a value for supported setting type ${JSON.stringify(type)}`
  }
}
