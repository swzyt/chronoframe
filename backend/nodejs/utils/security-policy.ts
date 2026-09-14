import type { SessionUser } from '../../shared/types/auth'
import type { User as DatabaseUser } from './db'

type WizardSchemaField = {
  value?: unknown
  defaultValue?: unknown
  isSecret?: boolean
  ui?: {
    type?: string
  }
}

/**
 * Session payloads use an allowlist so database-only fields (especially the
 * password hash) can never be copied into the sealed cookie by accident.
 */
export function toSessionUser(user: DatabaseUser): SessionUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    isAdmin: user.isAdmin,
    isActive: user.isActive,
  }
}

/**
 * Cookie security follows the request transport by default. This keeps the
 * documented direct-HTTP Docker deployment usable while retaining Secure on
 * HTTPS (including reverse proxies reported through X-Forwarded-Proto).
 * The compatibility flag can still explicitly force insecure cookies.
 */
export function getSessionCookieOptions(
  allowInsecureCookie: unknown,
  requestProtocol: string,
): {
  secure: boolean
} {
  const explicitlyAllowed =
    allowInsecureCookie === true ||
    (typeof allowInsecureCookie === 'string' &&
      allowInsecureCookie.trim().toLowerCase() === 'true')

  return {
    secure: requestProtocol === 'https' && !explicitlyAllowed,
  }
}

export function getSiteAccessCookieOptions(
  allowInsecureCookie: unknown,
  requestProtocol: string,
): {
  httpOnly: true
  sameSite: 'lax'
  secure: boolean
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    ...getSessionCookieOptions(allowInsecureCookie, requestProtocol),
  }
}

export function isSetupIncompleteValue(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1'
}

/**
 * Wizard schemas still describe password fields so the UI can render them,
 * but persisted/default secrets are always replaced with empty input values.
 */
export function redactWizardSecretField<T extends WizardSchemaField>(
  field: T,
): T {
  if (!field.isSecret && field.ui?.type !== 'password') {
    return field
  }

  return {
    ...field,
    value: '',
    defaultValue: '',
  }
}
