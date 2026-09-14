import { createError } from 'h3'
import { and, eq, tables, useDB } from './db'
import { isSetupIncompleteValue } from './security-policy'

/**
 * Wizard APIs are available only while the database explicitly says setup is
 * incomplete. A missing/malformed setting is treated as setup being closed.
 */
export function assertWizardAvailable(): void {
  const setting = useDB()
    .select({ value: tables.settings.value })
    .from(tables.settings)
    .where(
      and(
        eq(tables.settings.namespace, 'system'),
        eq(tables.settings.key, 'firstLaunch'),
      ),
    )
    .get()

  if (!isSetupIncompleteValue(setting?.value)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Setup is already complete',
    })
  }
}
