import type { BackendProvider } from './backend-routing'
import type { SettingValueType } from './settings-value'
import { normalizeBackendProvider } from './backend-routing'
import { and, eq, tables, useDB } from './db'
import { decodeSettingValue } from './settings-value'

type BackendProviderSettingRow = {
  type: SettingValueType
  value: string | null
}

type BackendProviderDatabase = ReturnType<typeof useDB>

/**
 * The backend switch is gateway control-plane state. Unlike ordinary settings,
 * dispatch must observe it immediately, otherwise a just-completed switch can
 * still route the next request through the previous backend until the local TTL
 * expires.
 */
export function readBackendProviderForDispatch(
  database: BackendProviderDatabase = useDB(),
): BackendProvider {
  const setting = database
    .select({
      type: tables.settings.type,
      value: tables.settings.value,
    })
    .from(tables.settings)
    .where(
      and(
        eq(tables.settings.namespace, 'system'),
        eq(tables.settings.key, 'backend.readProvider'),
      ),
    )
    .get()

  return decodeBackendProviderSetting(setting)
}

export function decodeBackendProviderSetting(
  setting: BackendProviderSettingRow | undefined,
): BackendProvider {
  if (!setting) return 'node'
  return normalizeBackendProvider(decodeSettingValue(setting.type, setting.value))
}
