import { randomUUID } from 'node:crypto'

const safeRequestId = /^[A-Za-z0-9_.:/-]{1,128}$/

export function resolveRequestId(value: string | undefined) {
  const candidate = value?.trim()
  return candidate && safeRequestId.test(candidate) ? candidate : randomUUID()
}

export function resolveBackendMode(value: string | undefined) {
  return ['normal', 'compare', 'shadow', 'sandbox'].includes(value || '')
    ? value!
    : 'normal'
}

export function resolveNodeMaturity(value: string | undefined) {
  return ['experimental', 'verified', 'stable'].includes(value || '')
    ? value!
    : 'stable'
}
