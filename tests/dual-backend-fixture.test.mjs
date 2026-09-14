import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import Database from 'better-sqlite3'

import { DUAL_BACKEND_COMPARE_FIXTURE } from '../scripts/compare-backends.mjs'
import {
  FIXTURE_ADMIN_EMAIL,
  FIXTURE_ADMIN_NAME,
  FIXTURE_ADMIN_PASSWORD,
  FIXTURE_ACCESS_PASSWORD,
  FIXTURE_MEMBER_EMAIL,
  FIXTURE_MEMBER_NAME,
  FIXTURE_MEMBER_PASSWORD,
  FIXTURE_MEMBER_SESSION_TOKEN,
  FIXTURE_EDITABLE_PHOTO_STORAGE_KEY,
  FIXTURE_SESSION_TOKEN,
  buildSharedSessionFixture,
  hashFixtureAccessPassword,
  hashFixtureAdminPassword,
  hashFixtureMemberPassword,
  hashUploadShareToken,
  resolveSQLitePath,
  seedSQLiteFixture,
  writeStorageFixture,
} from '../scripts/seed-dual-backend-fixture.mjs'

const SCRIPT_PATH = fileURLToPath(
  new URL('../scripts/seed-dual-backend-fixture.mjs', import.meta.url),
)

function createFixtureDatabase() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password TEXT,
      avatar TEXT,
      created_at INTEGER NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      auth_version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      width INTEGER,
      height INTEGER,
      aspect_ratio REAL,
      media_type TEXT NOT NULL DEFAULT 'image',
      duration REAL,
      video_codec TEXT,
      audio_codec TEXT,
      video_playback_key TEXT,
      date_taken TEXT,
      storage_key TEXT,
      content_hash TEXT,
      thumbnail_key TEXT,
      display_key TEXT,
      file_size INTEGER,
      last_modified TEXT,
      original_url TEXT,
      thumbnail_url TEXT,
      thumbnail_hash TEXT,
      tags TEXT,
      exif TEXT,
      latitude REAL,
      longitude REAL,
      country TEXT,
      city TEXT,
      location_name TEXT,
      is_live_photo INTEGER NOT NULL DEFAULT 0,
      live_photo_video_url TEXT,
      live_photo_video_key TEXT,
      owner_user_id INTEGER NOT NULL
    );

    CREATE TABLE albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      cover_photo_id TEXT,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL
    );

    CREATE TABLE album_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album_id INTEGER NOT NULL,
      photo_id TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 1000000,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE photo_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_id TEXT NOT NULL,
      reaction_type TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE pipeline_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'pending',
      status_stage TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      available_at INTEGER NOT NULL,
      claimed_by TEXT,
      claim_token TEXT,
      claim_expires_at INTEGER,
      completed_at INTEGER,
      owner_user_id INTEGER NOT NULL
    );

    CREATE TABLE upload_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      token TEXT,
      owner_user_id INTEGER NOT NULL,
      created_by_user_id INTEGER NOT NULL,
      label TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      upload_count INTEGER NOT NULL DEFAULT 0,
      max_uploads INTEGER,
      expires_at INTEGER,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT,
      default_value TEXT,
      label TEXT,
      description TEXT,
      is_public INTEGER NOT NULL DEFAULT 0,
      is_readonly INTEGER NOT NULL DEFAULT 0,
      is_secret INTEGER NOT NULL DEFAULT 0,
      enum TEXT,
      updated_at INTEGER NOT NULL,
      updated_by INTEGER
    );

    CREATE TABLE settings_storage_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  const insertSetting = sqlite.prepare(
    `INSERT INTO settings (
       namespace, key, type, value, default_value, updated_at
     )
     VALUES (?, ?, ?, ?, ?, 1)`,
  )
  for (const [namespace, key, type, value] of [
    ['system', 'firstLaunch', 'boolean', 'true'],
    ['system', 'backend.readProvider', 'string', 'node'],
    ['system', 'upload.maxFileSize', 'number', '256'],
    ['app', 'access.enabled', 'boolean', 'false'],
    ['app', 'access.passwordHash', 'string', ''],
    ['app', 'access.version', 'number', '1'],
    ['app', 'access.previewPhotoLimit', 'number', '10'],
    ['app', 'access.previewAlbumLimit', 'number', '1'],
    ['storage', 'provider', 'number', '1'],
  ]) {
    insertSetting.run(namespace, key, type, value, value)
  }
  return sqlite
}

test('dual backend fixture seeds stable SQLite rows idempotently', () => {
  const sqlite = createFixtureDatabase()
  try {
    seedSQLiteFixture(sqlite)
    seedSQLiteFixture(sqlite)

    const user = sqlite
      .prepare(
        'SELECT name, email, password, is_admin, is_active FROM users WHERE id = ?',
      )
      .get(DUAL_BACKEND_COMPARE_FIXTURE.userId)
    assert.equal(user.name, FIXTURE_ADMIN_NAME)
    assert.equal(user.email, FIXTURE_ADMIN_EMAIL)
    assert.equal(user.password, hashFixtureAdminPassword())
    assert.match(
      user.password,
      /^\$scrypt\$n=16384,r=8,p=1\$[A-Za-z0-9+/]+\/?\$[A-Za-z0-9+/]+\/?$/,
    )
    assert.equal(user.is_admin, 1)
    assert.equal(user.is_active, 1)
    assert.equal(FIXTURE_ADMIN_PASSWORD.length >= 6, true)

    const member = sqlite
      .prepare(
        'SELECT name, email, password, is_admin, is_active FROM users WHERE id = ?',
      )
      .get(DUAL_BACKEND_COMPARE_FIXTURE.memberUserId)
    assert.equal(member.name, FIXTURE_MEMBER_NAME)
    assert.equal(member.email, FIXTURE_MEMBER_EMAIL)
    assert.equal(member.password, hashFixtureMemberPassword())
    assert.equal(member.is_admin, 0)
    assert.equal(member.is_active, 1)
    assert.equal(FIXTURE_MEMBER_PASSWORD.length >= 6, true)

    const task = sqlite
      .prepare(
        `SELECT payload, status, claim_token, completed_at
         FROM pipeline_queue WHERE id = ?`,
      )
      .get(DUAL_BACKEND_COMPARE_FIXTURE.queueTaskId)
    assert.equal(task.status, 'completed')
    assert.equal(task.claim_token, null)
    assert.equal(
      JSON.parse(task.payload).storageKey,
      'originals/dual-fixture-photo-1.jpg',
    )
    assert.ok(task.completed_at)

    assert.equal(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM album_photos
           WHERE album_id = ? AND photo_id = ?`,
        )
        .get(
          DUAL_BACKEND_COMPARE_FIXTURE.albumId,
          DUAL_BACKEND_COMPARE_FIXTURE.photoId,
        ).count,
      1,
    )
    const restrictedAlbum = sqlite
      .prepare(
        `SELECT title, is_hidden, created_at
         FROM albums WHERE id = ?`,
      )
      .get(DUAL_BACKEND_COMPARE_FIXTURE.restrictedAlbumId)
    assert.equal(restrictedAlbum.title, 'Dual Backend Preview-Locked Album')
    assert.equal(restrictedAlbum.is_hidden, 0)
    assert.equal(restrictedAlbum.created_at < 1_798_761_600, true)
    assert.equal(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM album_photos
           WHERE album_id = ?`,
        )
        .get(DUAL_BACKEND_COMPARE_FIXTURE.restrictedAlbumId).count,
      0,
    )
    assert.equal(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM photo_reactions
           WHERE photo_id = ? AND fingerprint LIKE 'dual-fixture-%'`,
        )
        .get(DUAL_BACKEND_COMPARE_FIXTURE.photoId).count,
      2,
    )
    const mutablePhoto = sqlite
      .prepare('SELECT title, storage_key, file_size FROM photos WHERE id = ?')
      .get(DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId)
    assert.equal(mutablePhoto.title, 'Dual Backend Editable Photo')
    assert.equal(mutablePhoto.storage_key, FIXTURE_EDITABLE_PHOTO_STORAGE_KEY)
    assert.equal(mutablePhoto.file_size, 516)

    const uploadShare = sqlite
      .prepare('SELECT token_hash, token FROM upload_shares WHERE id = ?')
      .get(DUAL_BACKEND_COMPARE_FIXTURE.uploadShareId)
    assert.equal(
      uploadShare.token,
      DUAL_BACKEND_COMPARE_FIXTURE.uploadShareToken,
    )
    assert.equal(
      uploadShare.token_hash,
      hashUploadShareToken(DUAL_BACKEND_COMPARE_FIXTURE.uploadShareToken),
    )
    assert.equal(
      sqlite
        .prepare(
          `SELECT value FROM settings
           WHERE namespace = 'system' AND key = 'backend.readProvider'`,
        )
        .get().value,
      'node',
    )
    assert.equal(
      sqlite
        .prepare(
          `SELECT value FROM settings
           WHERE namespace = 'app' AND key = 'access.enabled'`,
        )
        .get().value,
      'true',
    )
    assert.equal(
      sqlite
        .prepare(
          `SELECT value FROM settings
           WHERE namespace = 'app' AND key = 'access.previewAlbumLimit'`,
        )
        .get().value,
      '1',
    )
    assert.equal(
      sqlite
        .prepare(
          `SELECT value FROM settings
           WHERE namespace = 'app' AND key = 'access.passwordHash'`,
        )
        .get().value,
      hashFixtureAccessPassword(),
    )
    assert.equal(FIXTURE_ACCESS_PASSWORD.length >= 8, true)
  } finally {
    sqlite.close()
  }
})

test('dual backend fixture writes editable local storage object', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chronoframe-fixture-'))
  try {
    const written = writeStorageFixture({
      basePath: directory,
      prefix: 'dual-fixture',
    })
    assert.equal(
      written,
      path.join(directory, 'dual-fixture', FIXTURE_EDITABLE_PHOTO_STORAGE_KEY),
    )
    const buffer = readFileSync(written)
    assert.equal(buffer[0], 0xff)
    assert.equal(buffer[1], 0xd8)
    assert.equal(buffer.byteLength, 516)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('dual backend fixture builds a shared Redis session understood by both runtimes', () => {
  const session = buildSharedSessionFixture({
    environment: 'development',
    nowSeconds: 1_800_000_000,
  })

  assert.equal(session.token, FIXTURE_SESSION_TOKEN)
  assert.equal(session.cookie, `cf_session=${FIXTURE_SESSION_TOKEN}`)
  assert.match(session.key, /^cf:v1:development:session:[a-f0-9]{64}$/)
  assert.deepEqual(JSON.parse(session.value), session.record)
  assert.equal(session.record.userId, DUAL_BACKEND_COMPARE_FIXTURE.userId)
  assert.equal(session.record.authVersion, 1)
  assert.equal(session.record.issuedAt, 1_800_000_000)
  assert.equal(session.record.expiresAt, 1_802_592_000)
})

test('dual backend fixture builds a non-admin shared Redis session', () => {
  const session = buildSharedSessionFixture({
    environment: 'development',
    token: FIXTURE_MEMBER_SESSION_TOKEN,
    userId: DUAL_BACKEND_COMPARE_FIXTURE.memberUserId,
    nowSeconds: 1_800_000_000,
  })

  assert.equal(session.token, FIXTURE_MEMBER_SESSION_TOKEN)
  assert.equal(session.cookie, `cf_session=${FIXTURE_MEMBER_SESSION_TOKEN}`)
  assert.match(session.key, /^cf:v1:development:session:[a-f0-9]{64}$/)
  assert.equal(session.record.userId, DUAL_BACKEND_COMPARE_FIXTURE.memberUserId)
  assert.equal(session.record.authVersion, 1)
})

test('dual backend fixture resolves only local SQLite database paths', () => {
  assert.equal(
    resolveSQLitePath('./data/app.sqlite3', '/tmp/chronoframe'),
    path.join('/tmp/chronoframe', 'data/app.sqlite3'),
  )
  assert.equal(resolveSQLitePath('file:///tmp/app.sqlite3'), '/tmp/app.sqlite3')
  assert.throws(
    () => resolveSQLitePath('postgres://localhost/app'),
    /local SQLite file/,
  )
})

test('dual backend fixture follows CFRAME_DATA_DIR by default', () => {
  const originalDatabaseURL = process.env.DATABASE_URL
  const originalDataDir = process.env.CFRAME_DATA_DIR
  try {
    delete process.env.DATABASE_URL
    process.env.CFRAME_DATA_DIR = './.data/dual-lab'
    assert.equal(
      resolveSQLitePath(undefined, '/tmp/chronoframe'),
      path.join('/tmp/chronoframe', '.data/dual-lab/app.sqlite3'),
    )
  } finally {
    if (originalDatabaseURL === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = originalDatabaseURL
    }
    if (originalDataDir === undefined) {
      delete process.env.CFRAME_DATA_DIR
    } else {
      process.env.CFRAME_DATA_DIR = originalDataDir
    }
  }
})

test('redis-session-only fixture mode skips SQLite writes and existence checks', () => {
  const missingDatabasePath = path.join(
    '/tmp',
    'chronoframe-missing-dual-fixture.sqlite3',
  )
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      '--confirm-fixture-write',
      '--redis-session-only',
      '--no-redis',
      '--db',
      missingDatabasePath,
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: '',
        CFRAME_DATA_DIR: '',
      },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.databasePath, missingDatabasePath)
  assert.equal(output.sqliteSeeded, false)
  assert.equal(output.redisSeeded, false)
  assert.equal(output.sessionCookie, `cf_session=${FIXTURE_SESSION_TOKEN}`)
  assert.equal(
    output.memberSessionCookie,
    `cf_session=${FIXTURE_MEMBER_SESSION_TOKEN}`,
  )
})
