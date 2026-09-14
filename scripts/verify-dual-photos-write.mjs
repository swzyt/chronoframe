#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import Database from 'better-sqlite3'

import { DUAL_BACKEND_COMPARE_FIXTURE } from './compare-backends.mjs'
import {
  FIXTURE_EDITABLE_PHOTO_STORAGE_KEY,
  FIXTURE_SESSION_TOKEN,
  resolveSQLitePath,
} from './seed-dual-backend-fixture.mjs'
import { verifyDualLivePhoto } from './verify-dual-livephoto.mjs'

const DEFAULT_BASE = process.env.CFRAME_DUAL_BASE ?? 'http://127.0.0.1:3010'
const DEFAULT_COOKIE =
  process.env.CFRAME_DUAL_COOKIE ?? `cf_session=${FIXTURE_SESSION_TOKEN}`
const DEFAULT_PREFIX =
  process.env.CFRAME_DUAL_PHOTOS_WRITE_PREFIX ?? 'dual-photos-write'
const DEFAULT_TIMEOUT_MS = Number(process.env.CFRAME_DUAL_TIMEOUT_MS ?? '15000')
const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const PROVIDERS = ['node', 'go']
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const UPDATE_PAYLOAD = Object.freeze({
  title: '  Same Title  ',
  description: ' Same Description ',
  tags: [' One ', 'TWO', 'one', ''],
  location: { latitude: -31.2, longitude: 121.5 },
  rating: 4,
})

export async function verifyDualPhotosWrite(options = {}) {
  const normalized = normalizeOptions(options)
  const summary = {
    ok: false,
    base: normalized.base,
    databasePath: normalized.databasePath,
    checkCount: 0,
    checks: [],
    cases: [],
    cleanup: [],
  }
  const api = createAPI(normalized, summary)
  const database = openDatabase(normalized.databasePath)
  const storage = readActiveLocalStorage(database)
  const runID = `${normalized.prefix}-${randomUUID().slice(0, 8)}`
  const runStorageRoot = resolveStorageObjectPath(storage, runID)
  const fixtureIDs = new Set()

  try {
    await verifyCreateContract(api, runID, summary)
    await verifyUploadContract(api, storage, runID, summary)

    const updateFixtures = PROVIDERS.map((provider) =>
      createPhotoFixture({
        database,
        storage,
        fixtureIDs,
        id: `${runID}-update-${provider}`,
        key: `${runID}/update/${provider}/editable.jpg`,
      }),
    )
    await verifyUpdateContract(api, database, updateFixtures, summary)

    const reindexFixtures = PROVIDERS.map((provider) =>
      createPhotoFixture({
        database,
        storage,
        fixtureIDs,
        id: `${runID}-reindex-${provider}`,
        key: `${runID}/reindex/${provider}/2024-02-03_trip-123views.jpg`,
      }),
    )
    await verifyReindexContract(api, database, reindexFixtures, summary)

    const deleteFixtures = PROVIDERS.map((provider) =>
      createDeleteFixture({
        database,
        storage,
        fixtureIDs,
        runID,
        provider,
      }),
    )
    await verifyDeleteContract(api, database, deleteFixtures, summary)

    const livePhoto = await verifyDualLivePhoto({
      base: normalized.base,
      cookie: normalized.cookie,
      databasePath: normalized.databasePath,
      fetchImpl: normalized.fetchImpl,
      prefix: `${normalized.prefix.slice(0, 55)}-live`,
      timeoutMs: normalized.timeoutMs,
    })
    if (!livePhoto.ok) {
      throw new Error(
        `Live Photo sub-gate failed: ${JSON.stringify(livePhoto.cleanup)}`,
      )
    }
    summary.livePhoto = {
      ok: true,
      checkCount: livePhoto.checkCount,
      cases: livePhoto.cases,
    }
    summary.ok = true
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error)
  } finally {
    await cleanup(summary, 'restore backend provider to node', () =>
      setProvider(api, 'node'),
    )
    await cleanup(summary, 'remove photos-write database fixtures', () =>
      cleanupDatabaseFixtures(database, fixtureIDs),
    )
    await cleanup(summary, 'remove photos-write storage fixtures', () => {
      if (existsSync(runStorageRoot)) {
        rmSync(runStorageRoot, { recursive: true, force: true })
      }
    })
    database.close()
    if (summary.cleanup.some((item) => !item.ok)) summary.ok = false
  }
  return summary
}

async function verifyCreateContract(api, runID, summary) {
  const cases = [
    { name: 'missing body', rawBody: undefined, status: 400 },
    { name: 'null body', rawBody: 'null', status: 400 },
    { name: 'primitive body', rawBody: '1', status: 400 },
    { name: 'array body', rawBody: '[]', status: 400 },
    { name: 'numeric filename', rawBody: '{"fileName":1}', status: 500 },
    {
      name: 'numeric content type',
      rawBody: '{"fileName":"x.jpg","contentType":1}',
      status: 500,
    },
    {
      name: 'numeric content hash',
      rawBody: '{"fileName":"x.jpg","contentHash":1}',
      status: 500,
    },
  ]
  for (const testCase of cases) {
    const results = []
    for (const provider of PROVIDERS) {
      await setProvider(api, provider)
      results.push(
        await api.request({
          name: `${provider} create ${testCase.name}`,
          method: 'POST',
          path: '/api/photos',
          rawBody: testCase.rawBody,
          rawJSON: testCase.rawBody !== undefined,
          expectedBackend: provider,
          expectedStatus: testCase.status,
        }),
      )
    }
    compareHTTPResults(`photos.create ${testCase.name}`, results)
  }

  const fileName = `${runID}-prepare.jpg`
  const contentHash =
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
  const results = []
  for (const provider of PROVIDERS) {
    await setProvider(api, provider)
    results.push(
      await api.request({
        name: `${provider} prepares a photo upload`,
        method: 'POST',
        path: '/api/photos',
        body: {
          fileName,
          contentType: 'image/jpeg',
          contentHash: ` ${contentHash.toUpperCase()} `,
          skipDuplicateCheck: [],
        },
        expectedBackend: provider,
      }),
    )
  }
  compareHTTPResults('photos.create valid request', results)
  const body = results[0].body
  expectEqual('photos.create', body.contentHash, contentHash, 'contentHash')
  expectEqual('photos.create', body.expiresIn, 3600, 'expiresIn')
  if (!String(body.fileKey).endsWith(`/users/910001/${fileName}`)) {
    throw new Error(`photos.create returned unexpected fileKey ${body.fileKey}`)
  }
  summary.cases.push({ route: 'photos.create', cases: cases.length + 1 })
}

async function verifyUploadContract(api, storage, runID, summary) {
  const hashes = []
  for (const provider of PROVIDERS) {
    const key = `${runID}/upload/${provider}/object.jpg`
    const bytes = Buffer.from(`photos-write-object-${provider}\n`, 'utf8')
    await setProvider(api, provider)
    const result = await api.request({
      name: `${provider} uploads raw photo bytes`,
      method: 'PUT',
      path: `/api/photos/upload?key=${encodeURIComponent(`/${key}`)}`,
      binaryBody: bytes,
      contentType: 'image/jpeg',
      expectedBackend: provider,
    })
    expectEqual(result.name, result.body.ok, true, 'body.ok')
    expectEqual(result.name, result.body.key, key, 'body.key')
    const stored = readFileSync(resolveStorageObjectPath(storage, key))
    if (!stored.equals(bytes)) {
      throw new Error(`${result.name}: persisted bytes differ`)
    }
    hashes.push(sha256(stored))
  }
  if (hashes[0] === hashes[1]) {
    throw new Error('photos.upload fixtures must prove distinct writes')
  }
  summary.cases.push({ route: 'photos.upload', cases: PROVIDERS.length })
}

async function verifyUpdateContract(api, database, fixtures, summary) {
  const results = []
  const hashes = []
  for (const [index, provider] of PROVIDERS.entries()) {
    const fixture = fixtures[index]
    await setProvider(api, provider)
    const result = await api.request({
      name: `${provider} updates complete photo metadata`,
      method: 'PUT',
      path: `/api/photos/${encodeURIComponent(fixture.id)}`,
      body: UPDATE_PAYLOAD,
      expectedBackend: provider,
    })
    if (!ISO_MILLISECONDS.test(result.body?.photo?.lastModified ?? '')) {
      throw new Error(`${result.name}: lastModified is not millisecond ISO UTC`)
    }
    assertUpdatedExif(result.name, result.body.photo.exif)
    results.push({
      ...result,
      body: normalizePhotoUpdateResponse(result.body, fixture),
    })
    const stored = readFileSync(fixture.path)
    hashes.push(sha256(stored))
    const row = database
      .prepare(
        'SELECT title, description, tags, exif, file_size, latitude, longitude FROM photos WHERE id = ?',
      )
      .get(fixture.id)
    expectEqual(result.name, row.title, 'Same Title', 'photos.title')
    expectEqual(
      result.name,
      row.description,
      'Same Description',
      'photos.description',
    )
    expectDeepEqual(
      result.name,
      JSON.parse(row.tags),
      ['One', 'TWO'],
      'photos.tags',
    )
    expectDeepEqual(
      result.name,
      JSON.parse(row.exif),
      result.body.photo.exif,
      'photos.exif',
    )
    expectEqual(result.name, row.file_size, stored.length, 'photos.file_size')
    expectEqual(result.name, row.latitude, -31.2, 'photos.latitude')
    expectEqual(result.name, row.longitude, 121.5, 'photos.longitude')
  }
  compareHTTPResults('photos.update complete metadata', results)
  expectEqual('photos.update', hashes[0], hashes[1], 'rewritten object SHA-256')
  summary.cases.push({ route: 'photos.update', cases: PROVIDERS.length })
}

function assertUpdatedExif(name, exif) {
  const expected = {
    ColorSpace: 'sRGB',
    Description: 'Same Description',
    GPSLatitude: 31.2,
    GPSLatitudeRef: 'N',
    GPSLongitude: 121.5,
    GPSLongitudeRef: 'E',
    ImageDescription: 'Same Description',
    ImageHeight: 1,
    ImageWidth: 1,
    Keywords: ['One', 'TWO', 'One', 'TWO'],
    Rating: 4,
    Subject: ['One', 'TWO', 'One', 'TWO'],
    Title: 'Same Title',
    UserComment: 'Same Description',
    XPComment: 'Same Description',
    XPKeywords: 'One; TWO',
    XPTitle: 'Same Title',
    tz: 'Asia/Shanghai',
    tzSource: 'GPSLatitude/GPSLongitude',
  }
  expectDeepEqual(name, sortValue(exif), sortValue(expected), 'photo.exif')
}

export function normalizePhotoUpdateResponse(body, fixture) {
  const normalized = structuredClone(body)
  if (
    normalized.photo.id !== fixture.id ||
    normalized.photo.storageKey !== fixture.key
  ) {
    throw new Error(
      'Photo update response does not reference the requested fixture',
    )
  }
  normalized.photo.id = '<photo-id>'
  normalized.photo.storageKey = '<storage-key>'
  normalized.photo.lastModified = '<iso-milliseconds>'
  return sortValue(normalized)
}

async function verifyReindexContract(api, database, fixtures, summary) {
  const results = []
  const rows = []
  for (const [index, provider] of PROVIDERS.entries()) {
    const fixture = fixtures[index]
    await setProvider(api, provider)
    const result = await api.request({
      name: `${provider} reindexes one photo`,
      method: 'POST',
      path: '/api/photos/exif/reindex',
      body: { action: 'single-reindex', photoId: fixture.id },
      expectedBackend: provider,
    })
    result.body.photoId = '<photo-id>'
    results.push({ ...result, body: sortValue(result.body) })
    const row = database
      .prepare(
        `SELECT title, date_taken, tags, exif, latitude, longitude,
                country, city, location_name, last_modified
         FROM photos WHERE id = ?`,
      )
      .get(fixture.id)
    if (!ISO_MILLISECONDS.test(row.last_modified)) {
      throw new Error(
        `${result.name}: persisted last_modified is not millisecond ISO UTC`,
      )
    }
    row.tags = JSON.parse(row.tags)
    row.exif = JSON.parse(row.exif)
    row.last_modified = '<iso-milliseconds>'
    rows.push(sortValue(row))
  }
  compareHTTPResults('photos.exif.reindex single', results)
  expectDeepEqual(
    'photos.exif.reindex',
    rows[0],
    rows[1],
    'persisted photo fields',
  )
  expectEqual(
    'photos.exif.reindex',
    rows[0].title,
    'trip',
    'cleaned filename title',
  )
  expectEqual(
    'photos.exif.reindex',
    rows[0].date_taken,
    '2024-02-03T00:00:00.000Z',
    'filename date',
  )

  const batch = []
  for (const provider of PROVIDERS) {
    await setProvider(api, provider)
    batch.push(
      await api.request({
        name: `${provider} accepts numeric batch photo IDs`,
        method: 'POST',
        path: '/api/photos/exif/reindex',
        body: { action: 'batch-reindex', photoIds: [999999] },
        expectedBackend: provider,
      }),
    )
  }
  compareHTTPResults('photos.exif.reindex empty batch', batch)
  summary.cases.push({ route: 'photos.exif.reindex', cases: 2 })
}

async function verifyDeleteContract(api, database, fixtures, summary) {
  const results = []
  for (const [index, provider] of PROVIDERS.entries()) {
    const fixture = fixtures[index]
    await setProvider(api, provider)
    const result = await api.request({
      name: `${provider} deletes all generated photo objects`,
      method: 'DELETE',
      path: `/api/photos/${encodeURIComponent(fixture.id)}`,
      expectedBackend: provider,
    })
    results.push(result)
    const row = database
      .prepare('SELECT id FROM photos WHERE id = ?')
      .get(fixture.id)
    if (row) throw new Error(`${result.name}: photo row remains`)
    const relation = database
      .prepare('SELECT 1 FROM album_photos WHERE photo_id = ?')
      .get(fixture.id)
    if (relation) throw new Error(`${result.name}: album relation remains`)
    for (const objectPath of fixture.paths) {
      if (existsSync(objectPath)) {
        throw new Error(
          `${result.name}: generated object remains at ${objectPath}`,
        )
      }
    }
    fixture.deleted = true
  }
  compareHTTPResults('photos.delete', results)
  summary.cases.push({ route: 'photos.delete', cases: PROVIDERS.length })
}

function createPhotoFixture({ database, storage, fixtureIDs, id, key }) {
  if (database.prepare('SELECT 1 FROM photos WHERE id = ?').get(id)) {
    throw new Error(`Refusing to overwrite existing photo fixture ${id}`)
  }
  const columns = database
    .prepare('PRAGMA table_info(photos)')
    .all()
    .map((column) => column.name)
  const source = database
    .prepare('SELECT * FROM photos WHERE id = ?')
    .get(DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId)
  if (!source) throw new Error('Editable seed photo is missing')
  const row = {
    ...source,
    id,
    storage_key: key,
    content_hash: null,
    thumbnail_key: null,
    display_key: null,
    video_playback_key: null,
    live_photo_video_key: null,
    live_photo_video_url: null,
    is_live_photo: 0,
    tags: '[]',
    exif: '{}',
  }
  database
    .prepare(
      `INSERT INTO photos (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...columns.map((column) => row[column]))
  fixtureIDs.add(id)

  const sourcePath = resolveStorageObjectPath(
    storage,
    FIXTURE_EDITABLE_PHOTO_STORAGE_KEY,
  )
  const destination = resolveStorageObjectPath(storage, key)
  mkdirSync(path.dirname(destination), { recursive: true })
  copyFileSync(sourcePath, destination)
  return { id, key, path: destination }
}

function createDeleteFixture({
  database,
  storage,
  fixtureIDs,
  runID,
  provider,
}) {
  const base = `${runID}/delete/${provider}`
  const fixture = createPhotoFixture({
    database,
    storage,
    fixtureIDs,
    id: `${runID}-delete-${provider}`,
    key: `${base}/photo.heic`,
  })
  const keys = {
    storage_key: fixture.key,
    thumbnail_key: `${base}/thumbnail.webp`,
    display_key: `${base}/display.jpg`,
    live_photo_video_key: `${base}/live.mov`,
    video_playback_key: `${base}/playback.mp4`,
  }
  database
    .prepare(
      `UPDATE photos
       SET storage_key = ?, thumbnail_key = ?, display_key = ?,
           live_photo_video_key = ?, video_playback_key = ?
       WHERE id = ?`,
    )
    .run(...Object.values(keys), fixture.id)
  database
    .prepare('INSERT INTO album_photos (album_id, photo_id) VALUES (?, ?)')
    .run(DUAL_BACKEND_COMPARE_FIXTURE.albumId, fixture.id)

  const allKeys = [...Object.values(keys), `${base}/photo.jpeg`]
  const source = readFileSync(
    resolveStorageObjectPath(storage, FIXTURE_EDITABLE_PHOTO_STORAGE_KEY),
  )
  const paths = allKeys.map((objectKey) => {
    const objectPath = resolveStorageObjectPath(storage, objectKey)
    mkdirSync(path.dirname(objectPath), { recursive: true })
    writeFileSync(objectPath, source)
    return objectPath
  })
  return { ...fixture, paths, deleted: false }
}

function cleanupDatabaseFixtures(database, fixtureIDs) {
  const ids = [...fixtureIDs]
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(', ')
  database
    .prepare(
      `DELETE FROM pipeline_queue
       WHERE json_extract(payload, '$.photoId') IN (${placeholders})`,
    )
    .run(...ids)
  database
    .prepare(`DELETE FROM photos WHERE id IN (${placeholders})`)
    .run(...ids)
}

function createAPI(options, summary) {
  return {
    async request({
      name,
      method,
      path: requestPath,
      body,
      rawBody,
      rawJSON = false,
      binaryBody,
      contentType,
      expectedBackend,
      expectedStatus = 200,
    }) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
      try {
        const requestBody =
          binaryBody ??
          (rawBody !== undefined
            ? rawBody
            : body === undefined
              ? undefined
              : JSON.stringify(body))
        const response = await options.fetchImpl(
          `${options.base}${requestPath}`,
          {
            method,
            headers: {
              Accept: 'application/json',
              Cookie: options.cookie,
              ...(requestBody === undefined
                ? {}
                : {
                    'Content-Type':
                      contentType ??
                      (rawJSON || body !== undefined
                        ? 'application/json'
                        : 'application/octet-stream'),
                  }),
            },
            body: requestBody,
            redirect: 'manual',
            signal: controller.signal,
          },
        )
        const text = await response.text()
        const result = {
          name,
          status: response.status,
          backend: response.headers.get('x-chronoframe-backend') ?? '',
          contentType: (response.headers.get('content-type') ?? '')
            .split(';')[0]
            .trim()
            .toLowerCase(),
          body: text === '' ? null : JSON.parse(text),
        }
        summary.checks.push(result)
        summary.checkCount = summary.checks.length
        if (result.status !== expectedStatus) {
          throw new Error(
            `${name}: expected HTTP ${expectedStatus}, got ${result.status}: ${text}`,
          )
        }
        if (!result.contentType.includes('application/json')) {
          throw new Error(`${name}: expected JSON response`)
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
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown backend provider ${provider}`)
  }
  const result = await api.request({
    name: `switch backend provider to ${provider}`,
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    body: { value: provider },
    expectedBackend: 'node',
  })
  expectEqual(result.name, result.body?.value, provider, 'body.value')
}

function compareHTTPResults(name, results) {
  if (results.length !== 2) throw new Error(`${name}: expected two results`)
  for (const field of ['status', 'contentType']) {
    expectEqual(name, results[1][field], results[0][field], field)
  }
  expectDeepEqual(
    name,
    sortValue(results[1].body),
    sortValue(results[0].body),
    'body',
  )
}

function readActiveLocalStorage(database) {
  const setting = database
    .prepare(
      "SELECT value FROM settings WHERE namespace = 'storage' AND key = 'provider'",
    )
    .get()
  if (!setting) throw new Error('Active storage provider setting is missing')
  const providerID = parseStoredSettingValue(setting.value)
  const row = database
    .prepare(
      'SELECT provider, config FROM settings_storage_providers WHERE id = ?',
    )
    .get(providerID)
  if (!row || row.provider !== 'local') {
    throw new Error(
      `Photos-write verifier requires local storage, got ${row?.provider ?? 'missing'}`,
    )
  }
  const config = JSON.parse(row.config)
  const basePath = path.resolve(String(config.basePath || ''))
  if (!path.isAbsolute(basePath) || basePath === path.parse(basePath).root) {
    throw new Error('Photos-write verifier requires a safe absolute basePath')
  }
  return {
    basePath,
    prefix: normalizeStoragePath(config.prefix || '', true),
  }
}

function resolveStorageObjectPath(storage, key) {
  const safeKey = normalizeStoragePath(key, false)
  const prefixed =
    !storage.prefix ||
    safeKey === storage.prefix ||
    safeKey.startsWith(`${storage.prefix}/`)
      ? safeKey
      : `${storage.prefix}/${safeKey}`
  const absolute = path.resolve(storage.basePath, prefixed)
  const relative = path.relative(storage.basePath, absolute)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Photos-write fixture path escapes storage basePath')
  }
  return absolute
}

function normalizeStoragePath(value, allowEmpty) {
  const text = String(value || '').replaceAll('\\', '/')
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) {
    throw new Error('Photos-write fixture storage path must be relative')
  }
  const segments = text.split('/').filter(Boolean)
  if (
    segments.some((segment) => segment === '.' || segment === '..') ||
    (!allowEmpty && segments.length === 0)
  ) {
    throw new Error('Photos-write fixture storage path is invalid')
  }
  return segments.join('/')
}

function openDatabase(databasePath) {
  const database = new Database(databasePath, { fileMustExist: true })
  database.pragma('busy_timeout = 5000')
  database.pragma('foreign_keys = ON')
  return database
}

function parseStoredSettingValue(value) {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    )
  }
  return value
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function expectEqual(name, actual, expected, field) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${name}: expected ${field}=${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

function expectDeepEqual(name, actual, expected, field) {
  const actualJSON = JSON.stringify(actual)
  const expectedJSON = JSON.stringify(expected)
  if (actualJSON !== expectedJSON) {
    throw new Error(
      `${name}: expected ${field}=${expectedJSON}, got ${actualJSON}`,
    )
  }
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

function normalizeOptions(options) {
  const databasePath =
    options.databasePath ?? process.env.CFRAME_DUAL_PHOTOS_WRITE_DB
  if (!databasePath) {
    throw new Error(
      'Photos-write verification requires --db <sqlite-path> or CFRAME_DUAL_PHOTOS_WRITE_DB',
    )
  }
  const prefix = String(options.prefix ?? DEFAULT_PREFIX).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(prefix)) {
    throw new Error('Photos-write prefix must use 1-64 safe characters')
  }
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) {
    throw new Error('Photos-write timeout must be 1-60000 milliseconds')
  }
  if (typeof (options.fetchImpl ?? globalThis.fetch) !== 'function') {
    throw new Error('Photos-write verifier requires fetch')
  }
  return {
    base: String(options.base ?? DEFAULT_BASE).replace(/\/+$/, ''),
    cookie: String(options.cookie ?? DEFAULT_COOKIE),
    databasePath: resolveSQLitePath(String(databasePath)),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    prefix,
    timeoutMs,
  }
}

export function parsePhotosWriteVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
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
    if (!next || next.startsWith('--'))
      throw new Error(`Missing value for ${name}`)
    values.set(name, next)
    index += 1
  }
  return normalizeOptions({
    base: values.get('--base') ?? environment.CFRAME_DUAL_BASE ?? DEFAULT_BASE,
    cookie:
      values.get('--cookie') ??
      environment.CFRAME_DUAL_COOKIE ??
      DEFAULT_COOKIE,
    databasePath: values.get('--db') ?? environment.CFRAME_DUAL_PHOTOS_WRITE_DB,
    prefix:
      values.get('--prefix') ??
      environment.CFRAME_DUAL_PHOTOS_WRITE_PREFIX ??
      DEFAULT_PREFIX,
    timeoutMs:
      values.get('--timeout-ms') ??
      environment.CFRAME_DUAL_TIMEOUT_MS ??
      DEFAULT_TIMEOUT_MS,
  })
}

async function main() {
  const summary = await verifyDualPhotosWrite(parsePhotosWriteVerifierOptions())
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.ok) process.exitCode = 1
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
