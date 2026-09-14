import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const systemSettingsPage = readFileSync(
  new URL('../app/pages/dashboard/settings/system.vue', import.meta.url),
  'utf8',
)
const settingsFormComposable = readFileSync(
  new URL('../app/composables/useSettingsForm.ts', import.meta.url),
  'utf8',
)
const backendStatusAPI = readFileSync(
  new URL('../backend/nodejs/api/system/backend/status.get.ts', import.meta.url),
  'utf8',
)
const settingsConfig = readFileSync(
  new URL('../backend/nodejs/services/settings/contants.ts', import.meta.url),
  'utf8',
)
const uiConfig = readFileSync(
  new URL('../backend/nodejs/services/settings/ui-config.ts', import.meta.url),
  'utf8',
)
const backendDispatch = readFileSync(
  new URL('../backend/nodejs/middleware/01.backend-dispatch.ts', import.meta.url),
  'utf8',
)

test('admin system settings exposes the Node/Go backend provider switch', () => {
  assert.match(
    systemSettingsPage,
    /id:\s*['"]backend['"][\s\S]*keys:\s*\[\s*['"]backend\.readProvider['"]\s*\]/,
  )
  assert.match(settingsConfig, /key:\s*['"]backend\.readProvider['"]/)
  assert.match(
    settingsConfig,
    /enum:\s*\[\s*['"]node['"]\s*,\s*['"]go['"]\s*\]/,
  )
  assert.match(
    uiConfig,
    /['"]backend\.readProvider['"]:\s*\{[\s\S]*value:\s*['"]node['"]/,
  )
  assert.match(
    uiConfig,
    /['"]backend\.readProvider['"]:\s*\{[\s\S]*value:\s*['"]go['"]/,
  )
})

test('admin backend provider switch stays Node-owned so Go can always roll back', () => {
  assert.match(
    settingsFormComposable,
    /updates\[0\]\?\.key\s*===\s*['"]backend\.readProvider['"]/,
  )
  assert.match(
    settingsFormComposable,
    /\/api\/system\/settings\/system\/backend\.readProvider/,
  )
  assert.match(settingsFormComposable, /method:\s*['"]PUT['"]/)
})

test('admin backend section shows Node-owned Go readiness before switching', () => {
  assert.match(systemSettingsPage, /\/api\/system\/backend\/status/)
  assert.match(
    systemSettingsPage,
    /backendStatus\.value\.go\.status === 'ready'/,
  )
  assert.match(systemSettingsPage, /goBackendCheckEntries/)
  assert.match(backendStatusAPI, /await requireAdmin\(event\)/)
  assert.match(backendStatusAPI, /readBackendProviderForDispatch/)
  assert.match(
    backendStatusAPI,
    /joinGoUpstreamURL\(upstream, '\/health\/ready'\)/,
  )
  assert.doesNotMatch(
    backendStatusAPI,
    /resolveGoRoute|proxyRequest/,
    'status endpoint must stay Node-owned and must not depend on Go route dispatch',
  )
})

test('Go proxy preserves an unencoded upstream Content-Length', () => {
  assert.match(backendDispatch, /onResponse\(proxyEvent, response\)/)
  assert.match(backendDispatch, /headers\.get\('content-length'\)/)
  assert.match(backendDispatch, /!response\.headers\.has\('content-encoding'\)/)
  assert.match(backendDispatch, /setHeader\(proxyEvent, 'Content-Length'/)
})
