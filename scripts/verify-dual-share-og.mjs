#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import Database from 'better-sqlite3'
import { createClient } from 'redis'
import sharp from 'sharp'

import { DUAL_BACKEND_COMPARE_FIXTURE } from './compare-backends.mjs'
import { FIXTURE_SESSION_TOKEN } from './seed-dual-backend-fixture.mjs'

export const SHARE_OG_ROUTE_IDS = Object.freeze(['media.share-og'])
export const SHARE_OG_CASES = Object.freeze([
  'real image media and metadata overlay',
  'video thumbnail candidate priority',
  'missing media fallback card',
  'preview access and administrator bypass',
  'missing photo and required PNG suffix',
  'live gateway switching between Node and Go',
  'pixel-level visual parity and exact response policy',
  'database, storage, settings cache, and provider cleanup',
])

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000'
const DEFAULT_DATABASE_PATH = './data/app.sqlite3'
const DEFAULT_REDIS_PASSWORD = 'chronoframe-development-only-change-me'
const DEFAULT_SETTINGS_VERSION_KEY = 'chronoframe:settings:version'
const DEFAULT_MAX_VISUAL_MAE = 8
const ADMIN_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
const TRACKED_SETTINGS = Object.freeze([
  ['system', 'backend.readProvider'],
  ['storage', 'provider'],
  ['app', 'title'],
  ['app', 'access.enabled'],
  ['app', 'access.previewPhotoLimit'],
  ['app', 'access.previewAlbumLimit'],
])

export function parseShareOGVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--') continue
    if (
      ![
        '--base',
        '--node',
        '--go',
        '--db',
        '--data-root',
        '--redis-url',
        '--redis-password',
        '--settings-version-key',
        '--timeout-ms',
        '--max-visual-mae',
        '--prefix',
      ].includes(option)
    ) {
      throw new Error(`Unknown option: ${option}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${option} requires a value`)
    }
    values.set(option, value)
    index += 1
  }

  const base = normalizeBaseURL(
    values.get('--base') ||
      environment.CFRAME_DUAL_BASE_URL ||
      (environment.CFRAME_DUAL_PORT
        ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
        : DEFAULT_BASE_URL),
  )
  const databasePath = path.resolve(
    values.get('--db') ||
      environment.CFRAME_DUAL_DATABASE_PATH ||
      DEFAULT_DATABASE_PATH,
  )
  const timeoutMs = boundedNumber(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 10_000,
    'timeout-ms',
    1,
    60_000,
  )
  const maxVisualMAE = boundedNumber(
    values.get('--max-visual-mae') ||
      environment.CFRAME_DUAL_SHARE_OG_MAX_VISUAL_MAE ||
      DEFAULT_MAX_VISUAL_MAE,
    'max-visual-mae',
    0,
    255,
  )
  const prefix = String(
    values.get('--prefix') ||
      environment.CFRAME_DUAL_SHARE_OG_PREFIX ||
      'dual-share-og',
  )
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(prefix)) {
    throw new Error('prefix must contain 1-48 safe characters')
  }

  return {
    base,
    nodeURL: normalizeBaseURL(
      values.get('--node') || environment.CFRAME_DUAL_NODE_URL || base,
    ),
    goURL: normalizeBaseURL(
      values.get('--go') ||
        environment.CFRAME_DUAL_GO_URL ||
        `${base}/__lab/go`,
    ),
    databasePath,
    dataRoot: path.resolve(
      values.get('--data-root') ||
        environment.CFRAME_DUAL_DATA_ROOT ||
        path.dirname(databasePath),
    ),
    redisURL:
      values.get('--redis-url') ||
      environment.CFRAME_DUAL_REDIS_URL ||
      environment.CFRAME_REDIS_URL ||
      `redis://127.0.0.1:${environment.CFRAME_DUAL_REDIS_PORT || 36379}/0`,
    redisPassword:
      values.get('--redis-password') ||
      environment.CFRAME_DUAL_REDIS_PASSWORD ||
      environment.CFRAME_REDIS_PASSWORD ||
      DEFAULT_REDIS_PASSWORD,
    settingsVersionKey:
      values.get('--settings-version-key') ||
      environment.CFRAME_SETTINGS_CACHE_VERSION_KEY ||
      DEFAULT_SETTINGS_VERSION_KEY,
    timeoutMs,
    maxVisualMAE,
    prefix,
  }
}

export async function verifyDualShareOG(options = {}) {
  const normalized = {
    ...parseShareOGVerifierOptions([], {}),
    ...options,
  }
  normalized.base = normalizeBaseURL(normalized.base)
  normalized.nodeURL = normalizeBaseURL(normalized.nodeURL)
  normalized.goURL = normalizeBaseURL(normalized.goURL)
  normalized.databasePath = path.resolve(normalized.databasePath)
  normalized.dataRoot = path.resolve(normalized.dataRoot)
  if (!existsSync(normalized.databasePath)) {
    throw new Error(
      `SQLite database does not exist: ${normalized.databasePath}`,
    )
  }
  if (
    normalized.dataRoot === path.parse(normalized.dataRoot).root ||
    path.dirname(normalized.databasePath) !== normalized.dataRoot
  ) {
    throw new Error(
      'data-root must be the non-root directory containing SQLite',
    )
  }

  const database = new Database(normalized.databasePath, {
    timeout: normalized.timeoutMs,
  })
  database.pragma('foreign_keys = ON')
  database.pragma(`busy_timeout = ${normalized.timeoutMs}`)
  const redis = createClient({
    url: normalized.redisURL,
    password: normalized.redisPassword || undefined,
  })
  await redis.connect()

  const runID = `${normalized.prefix}-${randomUUID().slice(0, 8)}`
  const fixtureRoot = path.join(normalized.dataRoot, 'share-og-fixtures', runID)
  assertSafeFixtureRoot(normalized.dataRoot, fixtureRoot, runID)
  const summary = {
    ok: false,
    base: normalized.base,
    databasePath: normalized.databasePath,
    routeIds: [...SHARE_OG_ROUTE_IDS],
    cases: [...SHARE_OG_CASES],
    checks: [],
    comparisons: [],
    cleanup: [],
  }
  const baseline = captureBaseline(database)
  const runtime = {
    ...normalized,
    database,
    redis,
    runID,
    fixtureRoot,
    baseline,
    summary,
    fetchImpl: normalized.fetchImpl || globalThis.fetch,
  }

  try {
    assert.equal(
      baseline.settings.get('system.backend.readProvider').value,
      'node',
      'share-OG verification requires backend.readProvider=node',
    )
    runtime.fixture = await installFixture(runtime)
    await bumpSettings(runtime)

    const primary = await verifyPair(runtime, {
      caseID: 'image-media',
      requestPath: `/share-og/${runtime.fixture.primaryID}.png`,
      cookie: false,
      status: 200,
      image: true,
    })
    await verifyPair(runtime, {
      caseID: 'video-thumbnail',
      requestPath: `/share-og/${runtime.fixture.videoID}.png`,
      cookie: ADMIN_COOKIE,
      status: 200,
      image: true,
    })
    await verifyPair(runtime, {
      caseID: 'fallback-card',
      requestPath: `/share-og/${runtime.fixture.fallbackID}.png`,
      cookie: ADMIN_COOKIE,
      status: 200,
      image: true,
    })
    await verifyPair(runtime, {
      caseID: 'preview-denied',
      requestPath: `/share-og/${runtime.fixture.fallbackID}.png`,
      cookie: false,
      status: 401,
      statusMessage: 'Site access required to view more photos',
    })
    await verifyPair(runtime, {
      caseID: 'missing-photo',
      requestPath: `/share-og/${runID}-missing.png`,
      cookie: false,
      status: 404,
      statusMessage: 'Image not found',
    })
    await verifySuffixBoundary(runtime)
    await verifyGatewaySwitch(runtime, primary)
    summary.ok = true
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error)
  } finally {
    await cleanup(
      summary,
      'restore SQLite settings, provider, and photos',
      () => restoreBaseline(runtime),
    )
    await cleanup(summary, 'remove generated share-OG media', () => {
      assertSafeFixtureRoot(normalized.dataRoot, fixtureRoot, runID)
      rmSync(fixtureRoot, { recursive: true, force: true })
      const parent = path.dirname(fixtureRoot)
      try {
        if (
          existsSync(parent) &&
          readFileSystemDirectory(parent).length === 0
        ) {
          rmSync(parent)
        }
      } catch {
        // Another verifier may own a sibling directory.
      }
    })
    await cleanup(
      summary,
      'invalidate shared settings cache after restore',
      () => bumpSettings(runtime),
    )
    if (redis.isOpen) await redis.quit()
    database.close()
    summary.checkCount = summary.checks.length
    summary.comparisonCount = summary.comparisons.length
    if (!summary.cleanup.every((entry) => entry.ok)) summary.ok = false
  }

  return summary
}

async function installFixture(runtime) {
  const { database, fixtureRoot, runID } = runtime
  mkdirSync(path.join(fixtureRoot, 'objects'), { recursive: true })
  const primaryBytes = await renderSourceFixture('#e11d48', '#0284c7')
  const videoStorageBytes = await renderSourceFixture('#991b1b', '#7f1d1d')
  const videoThumbnailBytes = await renderSourceFixture('#16a34a', '#14532d')
  writeFileSync(
    path.join(fixtureRoot, 'objects', 'primary.png'),
    primaryBytes,
    {
      flag: 'wx',
    },
  )
  writeFileSync(
    path.join(fixtureRoot, 'objects', 'video-original.png'),
    videoStorageBytes,
    { flag: 'wx' },
  )
  writeFileSync(
    path.join(fixtureRoot, 'objects', 'video-thumbnail.png'),
    videoThumbnailBytes,
    { flag: 'wx' },
  )

  const primaryID = `${runID}-image`
  const videoID = `${runID}-video`
  const fallbackID = `${runID}-fallback`
  const transaction = database.transaction(() => {
    for (const id of [primaryID, videoID, fallbackID]) {
      assert.equal(
        database.prepare('SELECT id FROM photos WHERE id = ?').get(id),
        undefined,
        `refusing to overwrite photo ${id}`,
      )
    }
    const provider = database
      .prepare(
        `INSERT INTO settings_storage_providers (name, provider, config)
         VALUES (?, 'local', ?)`,
      )
      .run(
        `Share OG fixture ${runID}`,
        JSON.stringify({
          provider: 'local',
          basePath: fixtureRoot,
          baseUrl: '/storage',
          prefix: 'objects/',
        }),
      )
    const providerID = Number(provider.lastInsertRowid)
    updateSetting(database, 'storage', 'provider', String(providerID))
    updateSetting(database, 'app', 'title', 'ChronoFrame 分享预览')
    updateSetting(database, 'app', 'access.enabled', 'true')
    updateSetting(database, 'app', 'access.previewPhotoLimit', '1')
    updateSetting(database, 'app', 'access.previewAlbumLimit', '1')

    const insert = database.prepare(
      `INSERT INTO photos (
         id, title, description, media_type, storage_key, thumbnail_key,
         display_key, file_size, last_modified, date_taken, tags, exif,
         city, location_name, is_live_photo, owner_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 0, ?)`,
    )
    insert.run(
      primaryID,
      'Chrono 😀Frame 1234567890',
      '  保留  内部空格的描述  ',
      'image',
      'missing-original.png',
      null,
      'primary.png',
      primaryBytes.length,
      '9999-12-31T23:59:59.000Z',
      '9999-12-31T23:59:59.000Z',
      JSON.stringify({
        Make: 'ChronoFrame',
        Model: 'ParityCam',
        FocalLengthIn35mmFormat: 35,
        FNumber: 2.8,
        ExposureTime: '1/125',
        ISO: 200,
      }),
      '上海',
      '外滩',
      DUAL_BACKEND_COMPARE_FIXTURE.userId,
    )
    insert.run(
      videoID,
      'Video candidate priority',
      '{"ARInfo":{"scene":"machine-generated"}}',
      'video',
      'video-original.png',
      'video-thumbnail.png',
      null,
      videoThumbnailBytes.length,
      '1000-01-02T00:00:00.000Z',
      '1000-01-02T00:00:00.000Z',
      JSON.stringify({ Make: 'Video', Model: 'Thumbnail' }),
      null,
      'Video City',
      DUAL_BACKEND_COMPARE_FIXTURE.userId,
    )
    insert.run(
      fallbackID,
      '   ',
      null,
      'image',
      'missing-fallback.png',
      null,
      null,
      0,
      '1000-01-01T00:00:00.000Z',
      '1000-01-01T00:00:00.000Z',
      '{}',
      null,
      null,
      DUAL_BACKEND_COMPARE_FIXTURE.userId,
    )
    return { providerID }
  })
  const { providerID } = transaction()
  return { primaryID, videoID, fallbackID, providerID }
}

async function renderSourceFixture(left, right) {
  return sharp(
    Buffer.from(`<svg width="640" height="960" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="960" fill="${left}"/>
      <circle cx="480" cy="180" r="150" fill="${right}"/>
      <path d="M0 760 L240 460 L390 650 L520 510 L640 700 V960 H0 Z" fill="#f8fafc" opacity="0.72"/>
    </svg>`),
  )
    .png()
    .toBuffer()
}

async function verifyPair(runtime, expectation) {
  await setBackendProvider(runtime, 'node')
  const node = await request(runtime, 'node', expectation)
  const go = await request(runtime, 'go', expectation)
  assert.equal(
    node.status,
    expectation.status,
    `${expectation.caseID} node status`,
  )
  assert.equal(go.status, expectation.status, `${expectation.caseID} go status`)
  assert.equal(node.backend, 'node', `${expectation.caseID} node backend`)
  assert.equal(go.backend, 'go', `${expectation.caseID} go backend`)

  if (expectation.image) {
    assertImagePolicy(node, expectation.caseID)
    assertImagePolicy(go, expectation.caseID)
    const visual = await compareRenderedPNGs(node.bytes, go.bytes)
    assert.ok(
      visual.mae <= runtime.maxVisualMAE,
      `${expectation.caseID} visual MAE ${visual.mae.toFixed(4)} exceeds ${runtime.maxVisualMAE}`,
    )
    runtime.summary.comparisons.push({
      caseId: expectation.caseID,
      kind: 'rendered-pixels',
      ok: true,
      ...visual,
    })
  } else {
    assert.equal(node.contentType, 'application/json')
    assert.equal(go.contentType, 'application/json')
    assert.deepEqual(normalizeError(go.body), normalizeError(node.body))
    if (expectation.statusMessage) {
      assert.equal(node.body?.statusMessage, expectation.statusMessage)
    }
    runtime.summary.comparisons.push({
      caseId: expectation.caseID,
      kind: 'error-envelope',
      ok: true,
    })
  }
  return { node, go }
}

async function verifySuffixBoundary(runtime) {
  await setBackendProvider(runtime, 'node')
  for (const provider of ['node', 'go']) {
    const result = await request(runtime, provider, {
      caseID: 'png-suffix-required',
      requestPath: `/share-og/${runtime.fixture.primaryID}`,
      cookie: ADMIN_COOKIE,
    })
    assert.equal(
      result.status,
      404,
      `${provider} must reject a missing .png suffix`,
    )
  }
  runtime.summary.comparisons.push({
    caseId: 'png-suffix-required',
    kind: 'route-boundary',
    ok: true,
  })
}

async function verifyGatewaySwitch(runtime, direct) {
  for (const provider of ['node', 'go']) {
    await setBackendProvider(runtime, provider)
    const result = await request(runtime, 'gateway', {
      caseID: `gateway-switch-${provider}`,
      requestPath: `/share-og/${runtime.fixture.primaryID}.png`,
      cookie: false,
    })
    assert.equal(result.status, 200)
    assert.equal(result.backend, provider)
    assertImagePolicy(result, `gateway-switch-${provider}`)
    const expected = direct[provider]
    const visual = await compareRenderedPNGs(expected.bytes, result.bytes)
    assert.equal(
      visual.mae,
      0,
      `${provider} gateway output changed from direct output`,
    )
    runtime.summary.comparisons.push({
      caseId: `gateway-switch-${provider}`,
      kind: 'gateway-rendered-pixels',
      ok: true,
      ...visual,
    })
  }
}

async function request(runtime, provider, expectation) {
  const requestID = `dual-share-og-${randomUUID()}`
  const origin =
    provider === 'go'
      ? runtime.goURL
      : provider === 'node'
        ? runtime.nodeURL
        : runtime.base
  const response = await runtime.fetchImpl(
    `${origin}${expectation.requestPath}`,
    {
      method: 'GET',
      headers: {
        Accept: '*/*',
        'X-Request-Id': requestID,
        ...(expectation.cookie === false
          ? {}
          : { Cookie: expectation.cookie || ADMIN_COOKIE }),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(runtime.timeoutMs),
    },
  )
  const bytes = Buffer.from(await response.arrayBuffer())
  const contentType = normalizeContentType(response.headers.get('content-type'))
  const result = {
    name: `${expectation.caseID} via ${provider}`,
    provider,
    path: expectation.requestPath,
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend') || '',
    requestID: response.headers.get('x-request-id') || '',
    contentType,
    contentLength: response.headers.get('content-length'),
    cacheControl: response.headers.get('cache-control'),
    vary: response.headers.get('vary'),
    setCookie: response.headers.get('set-cookie'),
    body: contentType === 'application/json' ? parseJSON(bytes) : null,
    bytes,
  }
  assert.equal(result.requestID, requestID, `${result.name} request ID`)
  runtime.summary.checks.push({ ...result, bytes: undefined })
  return result
}

function assertImagePolicy(result, caseID) {
  assert.equal(result.contentType, 'image/png', `${caseID} content type`)
  assert.equal(
    result.cacheControl,
    'private, max-age=86400',
    `${caseID} cache policy`,
  )
  assert.match(result.vary || '', /(?:^|,\s*)Cookie(?:,|$)/i, `${caseID} Vary`)
  assert.equal(result.setCookie, null, `${caseID} must not mutate cookies`)
  assert.equal(Number(result.contentLength), result.bytes.length)
  assert.ok(
    result.bytes.length > 1_000,
    `${caseID} image is unexpectedly small`,
  )
}

export async function compareRenderedPNGs(left, right) {
  const [leftImage, rightImage] = await Promise.all([
    decodeForVisualComparison(left),
    decodeForVisualComparison(right),
  ])
  assert.deepEqual(leftImage.info, rightImage.info)
  let absoluteDifference = 0
  let maximumDifference = 0
  for (let index = 0; index < leftImage.data.length; index += 1) {
    const difference = Math.abs(leftImage.data[index] - rightImage.data[index])
    absoluteDifference += difference
    maximumDifference = Math.max(maximumDifference, difference)
  }
  return {
    width: leftImage.info.width,
    height: leftImage.info.height,
    channels: leftImage.info.channels,
    mae: absoluteDifference / leftImage.data.length,
    maximumDifference,
  }
}

async function decodeForVisualComparison(bytes) {
  const metadata = await sharp(bytes).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.width, 1200)
  assert.equal(metadata.height, 600)
  const { data, info } = await sharp(bytes)
    .flatten({ background: '#09090b' })
    .resize(300, 150, { fit: 'fill' })
    .blur(0.5)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return {
    data,
    info: { width: info.width, height: info.height, channels: info.channels },
  }
}

function captureBaseline(database) {
  const settings = new Map()
  for (const [namespace, key] of TRACKED_SETTINGS) {
    const row = database
      .prepare(
        'SELECT id, namespace, key, value, updated_at, updated_by FROM settings WHERE namespace = ? AND key = ?',
      )
      .get(namespace, key)
    assert.ok(row, `required setting ${namespace}.${key} is missing`)
    settings.set(`${namespace}.${key}`, row)
  }
  const sequence = database
    .prepare(
      "SELECT seq FROM sqlite_sequence WHERE name = 'settings_storage_providers'",
    )
    .get()
  return { settings, sequence: sequence?.seq ?? null }
}

async function restoreBaseline(runtime) {
  const { database, baseline, fixture } = runtime
  const restore = database.transaction(() => {
    for (const row of baseline.settings.values()) {
      database
        .prepare(
          `UPDATE settings SET value = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
        )
        .run(row.value, row.updated_at, row.updated_by, row.id)
    }
    if (fixture) {
      database
        .prepare('DELETE FROM photos WHERE id IN (?, ?, ?)')
        .run(fixture.primaryID, fixture.videoID, fixture.fallbackID)
      database
        .prepare('DELETE FROM settings_storage_providers WHERE id = ?')
        .run(fixture.providerID)
    }
    if (baseline.sequence === null) {
      database
        .prepare(
          "DELETE FROM sqlite_sequence WHERE name = 'settings_storage_providers'",
        )
        .run()
    } else {
      database
        .prepare(
          "UPDATE sqlite_sequence SET seq = ? WHERE name = 'settings_storage_providers'",
        )
        .run(baseline.sequence)
    }
  })
  restore()
  const current = captureBaseline(database)
  assert.deepEqual([...current.settings], [...baseline.settings])
  assert.equal(current.sequence, baseline.sequence)
}

async function setBackendProvider(runtime, provider) {
  updateSetting(runtime.database, 'system', 'backend.readProvider', provider)
  await bumpSettings(runtime)
}

function updateSetting(database, namespace, key, value) {
  const result = database
    .prepare(
      `UPDATE settings SET value = ?, updated_at = unixepoch()
       WHERE namespace = ? AND key = ?`,
    )
    .run(value, namespace, key)
  assert.equal(result.changes, 1, `missing setting ${namespace}.${key}`)
}

async function bumpSettings(runtime) {
  await runtime.redis.incr(runtime.settingsVersionKey)
}

function normalizeError(body) {
  if (!body || typeof body !== 'object') return body
  const { url: _url, ...stable } = body
  return stable
}

function normalizeContentType(value) {
  return String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
}

function parseJSON(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return bytes.toString('utf8')
  }
}

function normalizeBaseURL(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`)
  }
  return url.toString().replace(/\/$/, '')
}

function boundedNumber(value, label, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`)
  }
  return parsed
}

function assertSafeFixtureRoot(dataRoot, fixtureRoot, runID) {
  assert.equal(path.basename(fixtureRoot), runID)
  assert.equal(path.basename(path.dirname(fixtureRoot)), 'share-og-fixtures')
  assert.ok(fixtureRoot.startsWith(`${dataRoot}${path.sep}`))
}

function readFileSystemDirectory(directory) {
  return existsSync(directory) ? readdirSync(directory) : []
}

async function cleanup(summary, name, action) {
  try {
    await action()
    summary.cleanup.push({ name, ok: true })
  } catch (error) {
    summary.cleanup.push({
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  verifyDualShareOG(parseShareOGVerifierOptions())
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exitCode = 1
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
