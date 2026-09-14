#!/usr/bin/env node

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

import { DUAL_BACKEND_COMPARE_FIXTURE } from './compare-backends.mjs'
import {
  FIXTURE_SESSION_TOKEN,
  resolveSQLitePath,
} from './seed-dual-backend-fixture.mjs'

const DEFAULT_BASE = process.env.CFRAME_DUAL_BASE ?? 'http://127.0.0.1:3010'
const DEFAULT_COOKIE =
  process.env.CFRAME_DUAL_COOKIE ?? `cf_session=${FIXTURE_SESSION_TOKEN}`
const DEFAULT_PREFIX =
  process.env.CFRAME_DUAL_LIVEPHOTO_PREFIX ?? 'dual-livephoto'
const DEFAULT_TIMEOUT_MS = Number(process.env.CFRAME_DUAL_TIMEOUT_MS ?? '10000')
const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const LIVEPHOTO_MANAGE_PATH = '/api/photos/livephoto/manage'
const PROVIDERS = new Set(['node', 'go'])
const LIVEPHOTO_BYTES = Buffer.from(
  'ChronoFrame dual-backend Live Photo parity fixture\n',
  'utf8',
)

export async function verifyDualLivePhoto(options = {}) {
  const normalized = normalizeOptions(options)
  const summary = {
    ok: false,
    base: normalized.base,
    databasePath: normalized.databasePath,
    checkCount: 0,
    cases: [],
    checks: [],
    cleanup: [],
  }
  const state = {
    fixtures: new Map(),
  }
  const api = createLivePhotoAPI(normalized, summary)
  const storage = readActiveLocalStorage(normalized.databasePath)
  const runID = `${normalized.prefix}-${randomUUID().slice(0, 8)}`
  const comparableBodies = new Map()

  try {
    await setProvider(api, 'node')
    const matrix = [
      { writer: 'node', action: 'process' },
      { writer: 'go', action: 'process' },
      { writer: 'node', action: 'update-photo' },
      { writer: 'go', action: 'update-photo' },
    ]

    for (const [index, testCase] of matrix.entries()) {
      const fixture = createLivePhotoFixture({
        databasePath: normalized.databasePath,
        storage,
        runID,
        index,
        ...testCase,
      })
      state.fixtures.set(fixture.id, fixture)
      const reader = otherProvider(testCase.writer)
      const caseSummary = {
        writer: testCase.writer,
        reader,
        action: testCase.action,
        photoId: fixture.id,
      }
      summary.cases.push(caseSummary)

      await setProvider(api, testCase.writer)
      const detect = await api.request({
        name: `${testCase.writer} detects ${testCase.action} Live Photo fixture`,
        method: 'POST',
        path: LIVEPHOTO_MANAGE_PATH,
        expectedBackend: testCase.writer,
        body: { action: 'detect', photoIds: [fixture.id] },
      })
      expectDetectResponse(detect.name, detect.body, fixture)
      compareProviderBody(
        comparableBodies,
        'detect',
        testCase.writer,
        detect.body,
        fixture,
      )

      const mutation = await api.request({
        name: `${testCase.writer} completes ${testCase.action} Live Photo write`,
        method: 'POST',
        path: LIVEPHOTO_MANAGE_PATH,
        expectedBackend: testCase.writer,
        body:
          testCase.action === 'process'
            ? { action: 'process', videoKey: fixture.videoKey }
            : { action: 'update-photo', photoId: fixture.id },
      })
      expectMutationResponse(
        mutation.name,
        mutation.body,
        fixture,
        testCase.action,
      )
      compareProviderBody(
        comparableBodies,
        testCase.action,
        testCase.writer,
        mutation.body,
        fixture,
      )
      expectPersistedLivePhoto(normalized.databasePath, fixture)

      await setProvider(api, reader)
      const read = await api.request({
        name: `${reader} reads ${testCase.writer} ${testCase.action} write`,
        method: 'GET',
        path: `/api/photos/${encodeURIComponent(fixture.id)}/livephoto`,
        expectedBackend: reader,
      })
      expectLivePhotoRead(read.name, read.body, fixture)

      const remove = await api.request({
        name: `${reader} deletes ${testCase.writer} ${testCase.action} fixture`,
        method: 'DELETE',
        path: `/api/photos/${encodeURIComponent(fixture.id)}`,
        expectedBackend: reader,
      })
      expectExactKeys(remove.name, remove.body, ['statusCode', 'statusMessage'])
      expectEqual(remove.name, remove.body.statusCode, 200, 'body.statusCode')
      expectEqual(
        remove.name,
        remove.body.statusMessage,
        'Photo deleted successfully',
        'body.statusMessage',
      )
      expectFixtureRemoved(normalized.databasePath, fixture)
      state.fixtures.delete(fixture.id)
      caseSummary.cleanedBy = reader
    }

    summary.ok = true
    return summary
  } finally {
    await cleanup(summary, 'restore backend provider to node', () =>
      setProvider(api, 'node'),
    )
    await cleanup(
      summary,
      `delete ${state.fixtures.size} remaining Live Photo fixtures`,
      () => cleanupLivePhotoFixtures(normalized.databasePath, state.fixtures),
    )
    if (summary.cleanup.some((item) => !item.ok)) {
      summary.ok = false
    }
  }
}

function normalizeOptions(options) {
  const rawDatabasePath =
    options.databasePath ?? process.env.CFRAME_DUAL_LIVEPHOTO_DB
  if (!rawDatabasePath) {
    throw new Error(
      'Live Photo verification requires --db <sqlite-path> or CFRAME_DUAL_LIVEPHOTO_DB',
    )
  }
  const prefix = String(options.prefix ?? DEFAULT_PREFIX).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(prefix)) {
    throw new Error(
      'Live Photo verifier prefix must use 1-64 letters, numbers, dots, underscores, or hyphens',
    )
  }
  return {
    base: String(options.base ?? DEFAULT_BASE).replace(/\/+$/, ''),
    cookie: String(options.cookie ?? DEFAULT_COOKIE),
    databasePath: resolveSQLitePath(String(rawDatabasePath)),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    prefix,
    timeoutMs: requirePositiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'timeoutMs',
    ),
  }
}

function createLivePhotoAPI(options, summary) {
  if (typeof options.fetchImpl !== 'function') {
    throw new Error('fetch implementation is required')
  }
  return {
    async request({ name, method, path: requestPath, body, expectedBackend }) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
      try {
        const response = await options.fetchImpl(
          `${options.base}${requestPath}`,
          {
            method,
            headers: {
              Accept: 'application/json',
              Cookie: options.cookie,
              ...(body === undefined
                ? {}
                : { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'manual',
            signal: controller.signal,
          },
        )
        const text = await response.text()
        const parsed = text.length === 0 ? null : JSON.parse(text)
        const result = {
          name,
          method,
          path: requestPath,
          status: response.status,
          backend: response.headers.get('x-chronoframe-backend') ?? '',
          contentType: response.headers.get('content-type') ?? '',
          body: parsed,
        }
        summary.checks.push(result)
        summary.checkCount = summary.checks.length
        if (result.status !== 200) {
          throw new Error(
            `${name}: expected HTTP 200, got ${result.status}: ${JSON.stringify(parsed)}`,
          )
        }
        if (!result.contentType.includes('application/json')) {
          throw new Error(
            `${name}: expected application/json, got ${result.contentType}`,
          )
        }
        if (result.backend !== expectedBackend) {
          throw new Error(
            `${name}: expected backend ${expectedBackend}, got ${result.backend}`,
          )
        }
        return result
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

async function setProvider(api, provider) {
  if (!PROVIDERS.has(provider)) {
    throw new Error(`Unknown backend provider ${provider}`)
  }
  const result = await api.request({
    name: `switch backend provider to ${provider}`,
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    expectedBackend: 'node',
    body: { value: provider },
  })
  expectEqual(result.name, result.body?.value, provider, 'body.value')
}

function readActiveLocalStorage(databasePath) {
  const database = openDatabase(databasePath)
  try {
    const setting = database
      .prepare(
        "SELECT value FROM settings WHERE namespace = 'storage' AND key = 'provider'",
      )
      .get()
    if (!setting) {
      throw new Error('Active storage provider setting is missing')
    }
    const providerID = parseStoredSettingValue(setting.value)
    const row = database
      .prepare(
        'SELECT id, provider, config FROM settings_storage_providers WHERE id = ?',
      )
      .get(providerID)
    if (!row || row.provider !== 'local') {
      throw new Error(
        `Live Photo verifier requires an active local storage provider, got ${row?.provider ?? 'missing'}`,
      )
    }
    const config = JSON.parse(row.config)
    const basePath = path.resolve(String(config.basePath || ''))
    if (!path.isAbsolute(basePath) || basePath === path.parse(basePath).root) {
      throw new Error(
        'Live Photo verifier requires a safe absolute local basePath',
      )
    }
    const prefix = normalizeStoragePath(config.prefix || '', true)
    return {
      basePath,
      prefix,
      baseURL: String(config.baseUrl || '/storage').replace(/\/+$/, ''),
    }
  } finally {
    database.close()
  }
}

function createLivePhotoFixture({
  databasePath,
  storage,
  runID,
  index,
  writer,
  action,
}) {
  const suffix = `${index + 1}-${writer}-${action}`
  const id = `${runID}-${suffix}`
  const baseName = `${runID}-${suffix}`
  const imageKey = `livephoto-fixtures/${baseName}.HEIC`
  const videoKey = `livephoto-fixtures/${baseName}.MOV`
  const title = `Dual Live Photo ${writer} ${action}`
  const videoPath = resolveStorageObjectPath(storage, videoKey)
  const publicVideoURL = `${storage.baseURL}/${[storage.prefix, videoKey]
    .filter(Boolean)
    .join('/')}`
  const fixture = {
    id,
    title,
    imageKey,
    videoKey,
    videoPath,
    videoSize: LIVEPHOTO_BYTES.length,
    publicVideoURL,
  }

  const database = openDatabase(databasePath)
  try {
    const existing = database
      .prepare('SELECT id FROM photos WHERE id = ?')
      .get(id)
    if (existing) {
      throw new Error(`Refusing to overwrite existing photo fixture ${id}`)
    }
    database
      .prepare(
        `INSERT INTO photos (
           id, title, media_type, storage_key, file_size, last_modified,
           tags, exif, is_live_photo, owner_user_id
         )
         VALUES (?, ?, 'image', ?, ?, ?, '[]', '{}', 0, ?)`,
      )
      .run(
        id,
        title,
        imageKey,
        1,
        new Date().toISOString(),
        DUAL_BACKEND_COMPARE_FIXTURE.userId,
      )
  } finally {
    database.close()
  }

  try {
    mkdirSync(path.dirname(videoPath), { recursive: true })
    if (existsSync(videoPath)) {
      throw new Error(
        `Refusing to overwrite existing media fixture ${videoPath}`,
      )
    }
    writeFileSync(videoPath, LIVEPHOTO_BYTES, { flag: 'wx' })
  } catch (error) {
    cleanupLivePhotoFixtures(databasePath, new Map([[id, fixture]]))
    throw error
  }
  return fixture
}

function expectDetectResponse(name, body, fixture) {
  expectExactKeys(name, body, ['message', 'results'])
  expectEqual(
    name,
    body.message,
    'Batch LivePhoto detection completed',
    'body.message',
  )
  expectExactKeys(name, body.results, [
    'found',
    'processed',
    'results',
    'total',
  ])
  expectEqual(name, body.results.total, 1, 'body.results.total')
  expectEqual(name, body.results.processed, 1, 'body.results.processed')
  expectEqual(name, body.results.found, 1, 'body.results.found')
  if (
    !Array.isArray(body.results.results) ||
    body.results.results.length !== 1
  ) {
    throw new Error(`${name}: expected one detected result`)
  }
  const detected = body.results.results[0]
  expectExactKeys(name, detected, [
    'found',
    'photoId',
    'storageKey',
    'videoKey',
    'videoSize',
  ])
  expectEqual(name, detected.found, true, 'body.results.results[0].found')
  expectEqual(
    name,
    detected.photoId,
    fixture.id,
    'body.results.results[0].photoId',
  )
  expectEqual(
    name,
    detected.storageKey,
    fixture.imageKey,
    'body.results.results[0].storageKey',
  )
  expectEqual(
    name,
    detected.videoKey,
    fixture.videoKey,
    'body.results.results[0].videoKey',
  )
  expectEqual(
    name,
    detected.videoSize,
    fixture.videoSize,
    'body.results.results[0].videoSize',
  )
}

function expectMutationResponse(name, body, fixture, action) {
  if (action === 'process') {
    expectExactKeys(name, body, ['message', 'success', 'videoKey'])
    expectEqual(
      name,
      body.message,
      'LivePhoto processed successfully',
      'body.message',
    )
  } else {
    expectExactKeys(name, body, ['message', 'photoId', 'success', 'videoKey'])
    expectEqual(
      name,
      body.message,
      'Photo updated to LivePhoto successfully',
      'body.message',
    )
    expectEqual(name, body.photoId, fixture.id, 'body.photoId')
  }
  expectEqual(name, body.success, true, 'body.success')
  expectEqual(name, body.videoKey, fixture.videoKey, 'body.videoKey')
}

function expectPersistedLivePhoto(databasePath, fixture) {
  const database = openDatabase(databasePath)
  try {
    const row = database
      .prepare(
        `SELECT is_live_photo, live_photo_video_url, live_photo_video_key
         FROM photos WHERE id = ?`,
      )
      .get(fixture.id)
    expectEqual(fixture.id, row?.is_live_photo, 1, 'photos.is_live_photo')
    expectEqual(
      fixture.id,
      row?.live_photo_video_url,
      fixture.publicVideoURL,
      'photos.live_photo_video_url',
    )
    expectEqual(
      fixture.id,
      row?.live_photo_video_key,
      fixture.videoKey,
      'photos.live_photo_video_key',
    )
  } finally {
    database.close()
  }
}

function expectLivePhotoRead(name, body, fixture) {
  expectExactKeys(name, body, [
    'id',
    'isLivePhoto',
    'livePhotoVideoUrl',
    'originalUrl',
    'thumbnailUrl',
    'title',
  ])
  expectEqual(name, body.id, fixture.id, 'body.id')
  expectEqual(name, body.title, fixture.title, 'body.title')
  expectEqual(name, body.isLivePhoto, true, 'body.isLivePhoto')
  expectEqual(
    name,
    body.livePhotoVideoUrl,
    fixture.publicVideoURL,
    'body.livePhotoVideoUrl',
  )
  expectEqual(name, body.originalUrl, null, 'body.originalUrl')
  expectEqual(name, body.thumbnailUrl, null, 'body.thumbnailUrl')
}

function compareProviderBody(
  comparableBodies,
  action,
  provider,
  body,
  fixture,
) {
  const normalized = replaceFixtureValues(body, fixture)
  const current = comparableBodies.get(action)
  if (!current) {
    comparableBodies.set(action, { provider, body: normalized })
    return
  }
  if (current.provider === provider) {
    return
  }
  const expected = JSON.stringify(current.body)
  const actual = JSON.stringify(normalized)
  if (actual !== expected) {
    throw new Error(
      `${action} response differs between ${current.provider} and ${provider}: expected ${expected}, got ${actual}`,
    )
  }
}

function replaceFixtureValues(value, fixture) {
  if (Array.isArray(value)) {
    return value.map((item) => replaceFixtureValues(item, fixture))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, replaceFixtureValues(item, fixture)]),
    )
  }
  const replacements = new Map([
    [fixture.id, '<photo-id>'],
    [fixture.title, '<title>'],
    [fixture.imageKey, '<image-key>'],
    [fixture.videoKey, '<video-key>'],
    [fixture.publicVideoURL, '<video-url>'],
  ])
  return replacements.get(value) ?? value
}

function expectFixtureRemoved(databasePath, fixture) {
  const database = openDatabase(databasePath)
  try {
    const row = database
      .prepare('SELECT id FROM photos WHERE id = ?')
      .get(fixture.id)
    if (row) {
      throw new Error(`${fixture.id}: photo row remained after API deletion`)
    }
  } finally {
    database.close()
  }
  if (existsSync(fixture.videoPath)) {
    throw new Error(`${fixture.id}: video object remained after API deletion`)
  }
}

function cleanupLivePhotoFixtures(databasePath, fixtures) {
  const values = [...fixtures.values()]
  const ids = values.map((fixture) => fixture.id)
  if (ids.length > 0) {
    const database = openDatabase(databasePath)
    try {
      const placeholders = ids.map(() => '?').join(', ')
      database
        .prepare(`DELETE FROM photos WHERE id IN (${placeholders})`)
        .run(...ids)
    } finally {
      database.close()
    }
  }
  for (const fixture of values) {
    rmSync(fixture.videoPath, { force: true })
  }
  for (const fixture of values) {
    expectFixtureRemoved(databasePath, fixture)
  }
}

function resolveStorageObjectPath(storage, key) {
  const safeKey = normalizeStoragePath(key, false)
  const relative = [storage.prefix, safeKey].filter(Boolean).join('/')
  const absolute = path.resolve(storage.basePath, relative)
  const relativeToBase = path.relative(storage.basePath, absolute)
  if (
    !relativeToBase ||
    relativeToBase === '..' ||
    relativeToBase.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToBase)
  ) {
    throw new Error('Live Photo fixture path escapes local storage basePath')
  }
  return absolute
}

function normalizeStoragePath(value, allowEmpty) {
  const text = String(value || '').replaceAll('\\', '/')
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) {
    throw new Error('Live Photo fixture storage path must be relative')
  }
  const segments = text.split('/').filter(Boolean)
  if (
    segments.some((segment) => segment === '.' || segment === '..') ||
    (!allowEmpty && segments.length === 0)
  ) {
    throw new Error('Live Photo fixture storage path is invalid')
  }
  return segments.join('/')
}

function parseStoredSettingValue(value) {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function openDatabase(databasePath) {
  const database = new Database(databasePath, { fileMustExist: true })
  database.pragma('busy_timeout = 5000')
  database.pragma('foreign_keys = ON')
  return database
}

function otherProvider(provider) {
  return provider === 'node' ? 'go' : 'node'
}

function expectExactKeys(name, value, expected) {
  const actual =
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).sort()
      : []
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(
      `${name}: expected keys ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`,
    )
  }
}

function expectEqual(name, actual, expected, field) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${name}: expected ${field}=${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

function requirePositiveInteger(value, label) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0 || number > 60_000) {
    throw new Error(`${label} must be a positive integer up to 60000`)
  }
  return number
}

async function cleanup(summary, name, action) {
  try {
    await action()
    summary.cleanup.push({ name, ok: true })
  } catch (error) {
    summary.cleanup.push({
      name,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export function parseLivePhotoVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      throw new Error(`Unknown argument ${argument}`)
    }
    const [name, inlineValue] = argument.split('=', 2)
    if (
      !['--base', '--cookie', '--db', '--prefix', '--timeout-ms'].includes(name)
    ) {
      throw new Error(`Unknown argument ${name}`)
    }
    if (inlineValue !== undefined) {
      values.set(name, inlineValue)
      continue
    }
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for ${name}`)
    }
    values.set(name, next)
    index += 1
  }
  const databasePath =
    values.get('--db') ?? environment.CFRAME_DUAL_LIVEPHOTO_DB
  if (!databasePath) {
    throw new Error(
      'Live Photo verification requires --db <sqlite-path> or CFRAME_DUAL_LIVEPHOTO_DB',
    )
  }
  return normalizeOptions({
    base: values.get('--base') ?? environment.CFRAME_DUAL_BASE ?? DEFAULT_BASE,
    cookie:
      values.get('--cookie') ??
      environment.CFRAME_DUAL_COOKIE ??
      DEFAULT_COOKIE,
    databasePath,
    prefix:
      values.get('--prefix') ??
      environment.CFRAME_DUAL_LIVEPHOTO_PREFIX ??
      DEFAULT_PREFIX,
    timeoutMs:
      values.get('--timeout-ms') ??
      environment.CFRAME_DUAL_TIMEOUT_MS ??
      DEFAULT_TIMEOUT_MS,
  })
}

async function main() {
  const summary = await verifyDualLivePhoto(parseLivePhotoVerifierOptions())
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.ok) {
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
