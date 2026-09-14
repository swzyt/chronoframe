#!/usr/bin/env node

import crypto from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import Database from 'better-sqlite3'
import { createClient } from 'redis'

import { DUAL_BACKEND_COMPARE_FIXTURE } from './compare-backends.mjs'

export const SHARED_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
export const FIXTURE_TIMESTAMP_SECONDS = 1_798_761_600
export const FIXTURE_TIMESTAMP_ISO = '2027-01-01T00:00:00.000Z'
export const FIXTURE_SESSION_TOKEN = Buffer.alloc(32, 0x43).toString(
  'base64url',
)
export const FIXTURE_MEMBER_SESSION_TOKEN = Buffer.alloc(32, 0x44).toString(
  'base64url',
)
export const FIXTURE_ADMIN_NAME = 'dual-backend-fixture-admin'
export const FIXTURE_ADMIN_EMAIL =
  'dual-backend-fixture-admin@chronoframe.local'
export const FIXTURE_ADMIN_PASSWORD = 'DualBackendFixture123!'
export const FIXTURE_MEMBER_NAME = 'dual-backend-fixture-member'
export const FIXTURE_MEMBER_EMAIL =
  'dual-backend-fixture-member@chronoframe.local'
export const FIXTURE_MEMBER_PASSWORD = 'DualBackendMember123!'
export const FIXTURE_ACCESS_PASSWORD = 'DualBackendAccess123!'
export const FIXTURE_EDITABLE_PHOTO_STORAGE_KEY =
  'originals/dual-fixture-photo-editable.jpg'

const DEFAULT_REDIS_PASSWORD = 'chronoframe-development-only-change-me'
const REDIS_SESSION_ONLY_FLAG = '--redis-session-only'
const FIXTURE_ADMIN_PASSWORD_SALT = Buffer.from('dual-backendseed')
const FIXTURE_MEMBER_PASSWORD_SALT = Buffer.from('dual-member-seed')
const FIXTURE_ACCESS_PASSWORD_SALT = Buffer.from('dual-access-seed')
const FIXTURE_EDITABLE_PHOTO_IMAGE_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ar//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z'
const REQUIRED_TABLES = [
  'users',
  'photos',
  'albums',
  'album_photos',
  'photo_reactions',
  'pipeline_queue',
  'upload_shares',
  'settings',
  'settings_storage_providers',
]
const REQUIRED_SETTINGS = [
  ['system', 'firstLaunch'],
  ['system', 'backend.readProvider'],
  ['system', 'upload.maxFileSize'],
  ['app', 'access.enabled'],
  ['app', 'access.passwordHash'],
  ['app', 'access.version'],
  ['app', 'access.previewPhotoLimit'],
  ['app', 'access.previewAlbumLimit'],
  ['storage', 'provider'],
]

function defaultSQLitePath() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  if (process.env.CFRAME_DATA_DIR) {
    return path.join(process.env.CFRAME_DATA_DIR, 'app.sqlite3')
  }
  return './data/app.sqlite3'
}

export function resolveSQLitePath(
  rawValue = defaultSQLitePath(),
  baseDirectory = process.cwd(),
) {
  const value = String(rawValue || '').trim()
  if (!value) throw new Error('DATABASE_URL must not be empty')

  if (value.startsWith('file:')) {
    const url = new URL(value)
    if (url.host && url.host !== 'localhost') {
      throw new Error('DATABASE_URL must reference a local SQLite file')
    }
    return fileURLToPath(url)
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new Error('DATABASE_URL must reference a local SQLite file')
  }

  return path.resolve(baseDirectory, value)
}

export function digestOpaqueToken(token) {
  const decoded = Buffer.from(token, 'base64url')
  if (decoded.length !== 32 || decoded.toString('base64url') !== token) {
    throw new Error('Opaque token must be 32-byte base64url without padding')
  }
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function sharedStateKey(environment, purpose, token) {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(environment)) {
    throw new Error('CFRAME_ENV has an invalid shared-state namespace')
  }
  if (purpose !== 'session' && purpose !== 'access') {
    throw new Error('Shared-state purpose must be session or access')
  }
  return `cf:v1:${environment}:${purpose}:${digestOpaqueToken(token)}`
}

export function hashUploadShareToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function hashFixturePassword(password, salt) {
  const derived = crypto.scryptSync(password, salt, 64, {
    cost: 16_384,
    blockSize: 8,
    parallelization: 1,
    maxmem: 64 * 1024 * 1024,
  })
  const encode = (value) => value.toString('base64').replace(/=+$/g, '')
  return `$scrypt$n=16384,r=8,p=1$${encode(salt)}$${encode(derived)}`
}

export function hashFixtureAdminPassword() {
  return hashFixturePassword(
    FIXTURE_ADMIN_PASSWORD,
    FIXTURE_ADMIN_PASSWORD_SALT,
  )
}

export function hashFixtureMemberPassword() {
  return hashFixturePassword(
    FIXTURE_MEMBER_PASSWORD,
    FIXTURE_MEMBER_PASSWORD_SALT,
  )
}

export function hashFixtureAccessPassword() {
  return hashFixturePassword(
    FIXTURE_ACCESS_PASSWORD,
    FIXTURE_ACCESS_PASSWORD_SALT,
  )
}

function encodeSettingValue(type, value) {
  if (value === null) return null
  switch (type) {
    case 'string':
      if (typeof value !== 'string') throw new Error('Expected string setting')
      return value
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('Expected finite number setting')
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value)
    case 'boolean':
      if (typeof value !== 'boolean')
        throw new Error('Expected boolean setting')
      return value ? 'true' : 'false'
    case 'json':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Expected object setting')
      }
      return JSON.stringify(value)
    default:
      throw new Error(`Unsupported setting type ${type}`)
  }
}

function assertRequiredTables(sqlite) {
  const tableExists = sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  )
  for (const table of REQUIRED_TABLES) {
    if (!tableExists.get(table)) {
      throw new Error(
        `Missing table ${table}; start the dual stack once so Node can run migrations before seeding`,
      )
    }
  }
}

function assertRequiredSettings(sqlite) {
  const settingExists = sqlite.prepare(
    'SELECT 1 FROM settings WHERE namespace = ? AND key = ?',
  )
  for (const [namespace, key] of REQUIRED_SETTINGS) {
    if (!settingExists.get(namespace, key)) {
      throw new Error(
        `Missing setting ${namespace}:${key}; start the dual stack once so Node can initialize DEFAULT_SETTINGS before seeding`,
      )
    }
  }
}

function updateSetting(sqlite, namespace, key, expectedType, value) {
  const current = sqlite
    .prepare('SELECT id, type FROM settings WHERE namespace = ? AND key = ?')
    .get(namespace, key)
  if (!current) {
    throw new Error(`Missing setting ${namespace}:${key}`)
  }
  if (current.type !== expectedType) {
    throw new Error(
      `Setting ${namespace}:${key} has type ${current.type}, expected ${expectedType}`,
    )
  }
  sqlite
    .prepare(
      `UPDATE settings
       SET value = ?, updated_at = ?, updated_by = ?
       WHERE id = ?`,
    )
    .run(
      encodeSettingValue(expectedType, value),
      FIXTURE_TIMESTAMP_SECONDS,
      DUAL_BACKEND_COMPARE_FIXTURE.userId,
      current.id,
    )
}

export function seedSQLiteFixture(sqlite) {
  assertRequiredTables(sqlite)
  assertRequiredSettings(sqlite)
  sqlite.pragma('foreign_keys = ON')

  const transaction = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO users (
           id, name, email, password, avatar, created_at, is_admin, is_active,
           auth_version
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           email = excluded.email,
           password = excluded.password,
           avatar = excluded.avatar,
           created_at = excluded.created_at,
           is_admin = excluded.is_admin,
           is_active = excluded.is_active,
           auth_version = excluded.auth_version`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.userId,
        FIXTURE_ADMIN_NAME,
        FIXTURE_ADMIN_EMAIL,
        hashFixtureAdminPassword(),
        null,
        FIXTURE_TIMESTAMP_SECONDS,
        1,
        1,
        1,
      )

    sqlite
      .prepare(
        `INSERT INTO users (
           id, name, email, password, avatar, created_at, is_admin, is_active,
           auth_version
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           email = excluded.email,
           password = excluded.password,
           avatar = excluded.avatar,
           created_at = excluded.created_at,
           is_admin = excluded.is_admin,
           is_active = excluded.is_active,
           auth_version = excluded.auth_version`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.memberUserId,
        FIXTURE_MEMBER_NAME,
        FIXTURE_MEMBER_EMAIL,
        hashFixtureMemberPassword(),
        null,
        FIXTURE_TIMESTAMP_SECONDS,
        0,
        1,
        1,
      )

    const storageKey = 'originals/dual-fixture-photo-1.jpg'
    const thumbnailKey = 'thumbnails/dual-fixture-photo-1.jpg'
    const livePhotoVideoKey = 'live/dual-fixture-photo-1.mov'
    const mutableStorageKey = FIXTURE_EDITABLE_PHOTO_STORAGE_KEY
    const mutableThumbnailKey = 'thumbnails/dual-fixture-photo-editable.jpg'
    sqlite
      .prepare(
        `INSERT INTO photos (
           id, title, description, width, height, aspect_ratio, media_type,
           duration, video_codec, audio_codec, video_playback_key, date_taken,
           storage_key, content_hash, thumbnail_key, display_key, file_size,
           last_modified, original_url, thumbnail_url, thumbnail_hash, tags,
           exif, latitude, longitude, country, city, location_name,
           is_live_photo, live_photo_video_url, live_photo_video_key,
           owner_user_id
         )
         VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           width = excluded.width,
           height = excluded.height,
           aspect_ratio = excluded.aspect_ratio,
           media_type = excluded.media_type,
           duration = excluded.duration,
           video_codec = excluded.video_codec,
           audio_codec = excluded.audio_codec,
           video_playback_key = excluded.video_playback_key,
           date_taken = excluded.date_taken,
           storage_key = excluded.storage_key,
           content_hash = excluded.content_hash,
           thumbnail_key = excluded.thumbnail_key,
           display_key = excluded.display_key,
           file_size = excluded.file_size,
           last_modified = excluded.last_modified,
           original_url = excluded.original_url,
           thumbnail_url = excluded.thumbnail_url,
           thumbnail_hash = excluded.thumbnail_hash,
           tags = excluded.tags,
           exif = excluded.exif,
           latitude = excluded.latitude,
           longitude = excluded.longitude,
           country = excluded.country,
           city = excluded.city,
           location_name = excluded.location_name,
           is_live_photo = excluded.is_live_photo,
           live_photo_video_url = excluded.live_photo_video_url,
           live_photo_video_key = excluded.live_photo_video_key,
           owner_user_id = excluded.owner_user_id`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.photoId,
        'Dual Backend Fixture Photo',
        'Fixture row for Node/Go response parity checks',
        1600,
        1000,
        1.6,
        'image',
        null,
        null,
        null,
        null,
        '2026-09-11T09:00:00.000Z',
        storageKey,
        'dual-fixture-content-hash',
        thumbnailKey,
        'display/dual-fixture-photo-1.jpg',
        123456,
        '2026-09-11T09:00:00.000Z',
        null,
        null,
        '00112233445566778899aabbccddeeff',
        JSON.stringify(['dual-backend', 'go-learning']),
        JSON.stringify({
          DateTimeOriginal: '2026:09:11 09:00:00',
          Make: 'ChronoFrame',
          Model: 'DualFixture',
          FocalLength: 35,
          FocalLengthIn35mmFormat: 35,
          ExposureTime: '1/125',
          GPSLatitude: 31.2304,
          GPSLatitudeRef: 'N',
          GPSLongitude: 121.4737,
          GPSLongitudeRef: 'E',
          GPSAltitude: 4,
          GPSAltitudeRef: 0,
        }),
        31.2304,
        121.4737,
        'China',
        'Shanghai',
        'People Square',
        1,
        null,
        livePhotoVideoKey,
        DUAL_BACKEND_COMPARE_FIXTURE.userId,
      )

    sqlite
      .prepare(
        `INSERT INTO photos (
           id, title, description, width, height, aspect_ratio, media_type,
           duration, video_codec, audio_codec, video_playback_key, date_taken,
           storage_key, content_hash, thumbnail_key, display_key, file_size,
           last_modified, original_url, thumbnail_url, thumbnail_hash, tags,
           exif, latitude, longitude, country, city, location_name,
           is_live_photo, live_photo_video_url, live_photo_video_key,
           owner_user_id
         )
         VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           width = excluded.width,
           height = excluded.height,
           aspect_ratio = excluded.aspect_ratio,
           media_type = excluded.media_type,
           duration = excluded.duration,
           video_codec = excluded.video_codec,
           audio_codec = excluded.audio_codec,
           video_playback_key = excluded.video_playback_key,
           date_taken = excluded.date_taken,
           storage_key = excluded.storage_key,
           content_hash = excluded.content_hash,
           thumbnail_key = excluded.thumbnail_key,
           display_key = excluded.display_key,
           file_size = excluded.file_size,
           last_modified = excluded.last_modified,
           original_url = excluded.original_url,
           thumbnail_url = excluded.thumbnail_url,
           thumbnail_hash = excluded.thumbnail_hash,
           tags = excluded.tags,
           exif = excluded.exif,
           latitude = excluded.latitude,
           longitude = excluded.longitude,
           country = excluded.country,
           city = excluded.city,
           location_name = excluded.location_name,
           is_live_photo = excluded.is_live_photo,
           live_photo_video_url = excluded.live_photo_video_url,
           live_photo_video_key = excluded.live_photo_video_key,
           owner_user_id = excluded.owner_user_id`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId,
        'Dual Backend Editable Photo',
        'Fixture row with a real local object for metadata update parity checks',
        1,
        1,
        1,
        'image',
        null,
        null,
        null,
        null,
        '2026-09-11T10:00:00.000Z',
        mutableStorageKey,
        'dual-fixture-editable-content-hash',
        mutableThumbnailKey,
        null,
        516,
        '2026-09-11T10:00:00.000Z',
        null,
        null,
        null,
        JSON.stringify(['dual-backend', 'editable']),
        JSON.stringify({
          DateTimeOriginal: '2026:09:11 10:00:00',
          ImageWidth: 1,
          ImageHeight: 1,
          Make: 'ChronoFrame',
          Model: 'DualEditableFixture',
          Rating: 1,
        }),
        null,
        null,
        null,
        null,
        null,
        0,
        null,
        null,
        DUAL_BACKEND_COMPARE_FIXTURE.userId,
      )

    sqlite
      .prepare(
        `INSERT INTO photos (
           id, title, description, media_type, storage_key, thumbnail_key,
           display_key, file_size, last_modified, tags, exif, is_live_photo,
           owner_user_id
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           media_type = excluded.media_type,
           storage_key = excluded.storage_key,
           thumbnail_key = excluded.thumbnail_key,
           display_key = excluded.display_key,
           file_size = excluded.file_size,
           last_modified = excluded.last_modified,
           tags = excluded.tags,
           exif = excluded.exif,
           is_live_photo = excluded.is_live_photo,
           owner_user_id = excluded.owner_user_id`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.hiddenPhotoId,
        'Dual Backend Hidden Photo',
        'Hidden fixture row for media authorization parity checks',
        'image',
        'hidden/dual-fixture-hidden-photo.jpg',
        null,
        null,
        1024,
        '2026-09-11T11:00:00.000Z',
        JSON.stringify(['dual-backend', 'hidden']),
        JSON.stringify({
          DateTimeOriginal: '2026:09:11 11:00:00',
          Make: 'ChronoFrame',
          Model: 'HiddenFixture',
        }),
        0,
        DUAL_BACKEND_COMPARE_FIXTURE.userId,
      )

    sqlite
      .prepare(
        `INSERT INTO albums (
           id, title, description, cover_photo_id, is_hidden, created_at,
           updated_at, owner_user_id
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           cover_photo_id = excluded.cover_photo_id,
           is_hidden = excluded.is_hidden,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           owner_user_id = excluded.owner_user_id`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.albumId,
        'Dual Backend Fixture Album',
        'Visible album for Node/Go compare fixtures',
        DUAL_BACKEND_COMPARE_FIXTURE.photoId,
        0,
        FIXTURE_TIMESTAMP_SECONDS,
        FIXTURE_TIMESTAMP_SECONDS,
        DUAL_BACKEND_COMPARE_FIXTURE.userId,
      )

    sqlite
      .prepare(
        `INSERT INTO albums (
           id, title, description, cover_photo_id, is_hidden, created_at,
           updated_at, owner_user_id
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           cover_photo_id = excluded.cover_photo_id,
           is_hidden = excluded.is_hidden,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           owner_user_id = excluded.owner_user_id`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.restrictedAlbumId,
        'Dual Backend Preview-Locked Album',
        'Public album intentionally outside the anonymous preview limit',
        null,
        0,
        FIXTURE_TIMESTAMP_SECONDS - 1,
        FIXTURE_TIMESTAMP_SECONDS - 1,
        DUAL_BACKEND_COMPARE_FIXTURE.userId,
      )

    sqlite
      .prepare(
        `INSERT INTO albums (
           id, title, description, cover_photo_id, is_hidden, created_at,
           updated_at, owner_user_id
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           cover_photo_id = excluded.cover_photo_id,
           is_hidden = excluded.is_hidden,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           owner_user_id = excluded.owner_user_id`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.hiddenAlbumId,
        'Dual Backend Hidden Album',
        'Hidden album for media authorization parity checks',
        DUAL_BACKEND_COMPARE_FIXTURE.hiddenPhotoId,
        1,
        FIXTURE_TIMESTAMP_SECONDS - 2,
        FIXTURE_TIMESTAMP_SECONDS - 2,
        DUAL_BACKEND_COMPARE_FIXTURE.userId,
      )

    sqlite
      .prepare('DELETE FROM album_photos WHERE album_id = ? AND photo_id = ?')
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.albumId,
        DUAL_BACKEND_COMPARE_FIXTURE.photoId,
      )
    sqlite
      .prepare('DELETE FROM album_photos WHERE album_id = ?')
      .run(DUAL_BACKEND_COMPARE_FIXTURE.restrictedAlbumId)
    sqlite
      .prepare('DELETE FROM album_photos WHERE album_id = ?')
      .run(DUAL_BACKEND_COMPARE_FIXTURE.hiddenAlbumId)
    sqlite
      .prepare(
        `INSERT INTO album_photos (album_id, photo_id, position, added_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.albumId,
        DUAL_BACKEND_COMPARE_FIXTURE.photoId,
        1,
        FIXTURE_TIMESTAMP_SECONDS,
      )
    sqlite
      .prepare(
        `INSERT INTO album_photos (album_id, photo_id, position, added_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.hiddenAlbumId,
        DUAL_BACKEND_COMPARE_FIXTURE.hiddenPhotoId,
        1,
        FIXTURE_TIMESTAMP_SECONDS - 2,
      )

    sqlite
      .prepare(
        `DELETE FROM photo_reactions
         WHERE photo_id = ? AND fingerprint IN (?, ?)`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.photoId,
        'dual-fixture-fingerprint-a',
        'dual-fixture-fingerprint-b',
      )
    sqlite
      .prepare(
        `INSERT INTO photo_reactions (
           photo_id, reaction_type, fingerprint, ip_address, user_agent,
           created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.photoId,
        'like',
        'dual-fixture-fingerprint-a',
        '127.0.0.1',
        'dual-backend-fixture',
        FIXTURE_TIMESTAMP_SECONDS,
        FIXTURE_TIMESTAMP_SECONDS,
        DUAL_BACKEND_COMPARE_FIXTURE.photoId,
        'love',
        'dual-fixture-fingerprint-b',
        '127.0.0.1',
        'dual-backend-fixture',
        FIXTURE_TIMESTAMP_SECONDS,
        FIXTURE_TIMESTAMP_SECONDS,
      )

    sqlite
      .prepare(
        `INSERT INTO pipeline_queue (
           id, payload, priority, attempts, max_attempts, status,
           status_stage, error_message, created_at, available_at, claimed_by,
           claim_token, claim_expires_at, completed_at, owner_user_id
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload = excluded.payload,
           priority = excluded.priority,
           attempts = excluded.attempts,
           max_attempts = excluded.max_attempts,
           status = excluded.status,
           status_stage = excluded.status_stage,
           error_message = excluded.error_message,
           created_at = excluded.created_at,
           available_at = excluded.available_at,
           claimed_by = excluded.claimed_by,
           claim_token = excluded.claim_token,
           claim_expires_at = excluded.claim_expires_at,
           completed_at = excluded.completed_at,
           owner_user_id = excluded.owner_user_id`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.queueTaskId,
        JSON.stringify({
          type: 'photo',
          storageKey,
          contentHash: 'dual-fixture-content-hash',
          eraseLocation: false,
        }),
        10,
        1,
        3,
        'completed',
        'thumbnail',
        null,
        FIXTURE_TIMESTAMP_SECONDS,
        FIXTURE_TIMESTAMP_SECONDS,
        null,
        null,
        null,
        FIXTURE_TIMESTAMP_SECONDS,
        DUAL_BACKEND_COMPARE_FIXTURE.userId,
      )

    sqlite
      .prepare(
        `INSERT INTO settings_storage_providers (
           id, name, provider, config, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           provider = excluded.provider,
           config = excluded.config,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.storageProviderId,
        'Dual Backend Local Fixture',
        'local',
        JSON.stringify({
          provider: 'local',
          basePath: '/app/data/storage',
          prefix: 'dual-fixture',
        }),
        FIXTURE_TIMESTAMP_SECONDS,
        FIXTURE_TIMESTAMP_SECONDS,
      )

    sqlite
      .prepare(
        `INSERT INTO upload_shares (
           id, token_hash, token, owner_user_id, created_by_user_id, label,
           is_active, upload_count, max_uploads, expires_at, last_used_at,
           created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           token_hash = excluded.token_hash,
           token = excluded.token,
           owner_user_id = excluded.owner_user_id,
           created_by_user_id = excluded.created_by_user_id,
           label = excluded.label,
           is_active = excluded.is_active,
           upload_count = excluded.upload_count,
           max_uploads = excluded.max_uploads,
           expires_at = excluded.expires_at,
           last_used_at = excluded.last_used_at,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        DUAL_BACKEND_COMPARE_FIXTURE.uploadShareId,
        hashUploadShareToken(DUAL_BACKEND_COMPARE_FIXTURE.uploadShareToken),
        DUAL_BACKEND_COMPARE_FIXTURE.uploadShareToken,
        DUAL_BACKEND_COMPARE_FIXTURE.userId,
        DUAL_BACKEND_COMPARE_FIXTURE.userId,
        'Dual backend fixture upload share',
        1,
        1,
        5,
        4_102_444_800,
        FIXTURE_TIMESTAMP_SECONDS,
        FIXTURE_TIMESTAMP_SECONDS,
        FIXTURE_TIMESTAMP_SECONDS,
      )

    updateSetting(sqlite, 'system', 'firstLaunch', 'boolean', false)
    updateSetting(sqlite, 'system', 'backend.readProvider', 'string', 'node')
    updateSetting(sqlite, 'system', 'upload.maxFileSize', 'number', 256)
    updateSetting(sqlite, 'app', 'access.enabled', 'boolean', true)
    updateSetting(
      sqlite,
      'app',
      'access.passwordHash',
      'string',
      hashFixtureAccessPassword(),
    )
    updateSetting(sqlite, 'app', 'access.version', 'number', 1)
    updateSetting(sqlite, 'app', 'access.previewPhotoLimit', 'number', 500)
    updateSetting(sqlite, 'app', 'access.previewAlbumLimit', 'number', 1)
    updateSetting(
      sqlite,
      'storage',
      'provider',
      'number',
      DUAL_BACKEND_COMPARE_FIXTURE.storageProviderId,
    )
  })

  transaction()
}

export function writeStorageFixture({
  basePath = '/app/data/storage',
  prefix = 'dual-fixture',
} = {}) {
  const objectBuffer = Buffer.from(
    FIXTURE_EDITABLE_PHOTO_IMAGE_BASE64,
    'base64',
  )
  const objectPath = path.join(
    path.resolve(basePath),
    normalizeStoragePrefix(prefix),
    FIXTURE_EDITABLE_PHOTO_STORAGE_KEY,
  )
  mkdirSync(path.dirname(objectPath), { recursive: true })
  writeFileSync(objectPath, objectBuffer)
  return objectPath
}

function normalizeStoragePrefix(rawValue) {
  const value = String(rawValue || '')
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/g, '')
  if (
    value
      .split('/')
      .filter(Boolean)
      .some((part) => part === '.' || part === '..')
  ) {
    throw new Error('Storage fixture prefix must stay within basePath')
  }
  return value
}

export function buildSharedSessionFixture({
  environment = 'development',
  nowSeconds = Math.floor(Date.now() / 1_000),
  token = FIXTURE_SESSION_TOKEN,
  userId = DUAL_BACKEND_COMPARE_FIXTURE.userId,
  authVersion = 1,
} = {}) {
  const record = {
    schemaVersion: 1,
    userId,
    authVersion,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + SHARED_SESSION_TTL_SECONDS,
  }
  return {
    cookie: `cf_session=${token}`,
    token,
    key: sharedStateKey(environment, 'session', token),
    record,
    value: JSON.stringify(record),
  }
}

export async function writeRedisSessionFixture({
  redisURL,
  username,
  password,
  environment = 'development',
  token = FIXTURE_SESSION_TOKEN,
  userId = DUAL_BACKEND_COMPARE_FIXTURE.userId,
  authVersion = 1,
  nowSeconds = Math.floor(Date.now() / 1_000),
}) {
  const session = buildSharedSessionFixture({
    environment,
    token,
    userId,
    authVersion,
    nowSeconds,
  })
  const client = createClient({
    url: redisURL,
    username,
    password,
    socket: { connectTimeout: 5_000 },
  })
  client.on('error', () => {})
  await client.connect()
  try {
    await client.sendCommand([
      'SET',
      session.key,
      session.value,
      'EXAT',
      String(session.record.expiresAt),
    ])
  } finally {
    await client.close()
  }
  return session
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function flag(name) {
  return process.argv.includes(name)
}

async function main() {
  if (
    !flag('--confirm-fixture-write') &&
    process.env.CFRAME_CONFIRM_FIXTURE_WRITE !== 'true'
  ) {
    throw new Error(
      'Refusing to seed without --confirm-fixture-write; use a temporary CFRAME_DATA_DIR for dual-backend comparison fixtures',
    )
  }

  const sqliteSeeded = !flag(REDIS_SESSION_ONLY_FLAG)
  const databasePath = resolveSQLitePath(option('--db'))
  let storageObjectPath = null
  if (sqliteSeeded) {
    if (!existsSync(databasePath)) {
      throw new Error(
        `SQLite database does not exist at ${databasePath}; start pnpm dual:up first or run migrations before seeding`,
      )
    }

    const sqlite = new Database(databasePath, { fileMustExist: true })
    try {
      sqlite.pragma('busy_timeout = 5000')
      seedSQLiteFixture(sqlite)
    } finally {
      sqlite.close()
    }
    storageObjectPath = writeStorageFixture({
      basePath:
        option('--storage-base') ||
        process.env.CFRAME_FIXTURE_STORAGE_BASE_PATH ||
        '/app/data/storage',
      prefix: option('--storage-prefix') || 'dual-fixture',
    })
  }

  const environment = option('--env') || process.env.CFRAME_ENV || 'development'
  let session = buildSharedSessionFixture({ environment })
  let memberSession = buildSharedSessionFixture({
    environment,
    token: FIXTURE_MEMBER_SESSION_TOKEN,
    userId: DUAL_BACKEND_COMPARE_FIXTURE.memberUserId,
  })
  if (!flag('--no-redis')) {
    const redisURL =
      option('--redis') ||
      process.env.CFRAME_REDIS_URL ||
      `redis://127.0.0.1:${process.env.CFRAME_DUAL_REDIS_PORT || '36379'}/0`
    session = await writeRedisSessionFixture({
      redisURL,
      username: option('--redis-username') || process.env.CFRAME_REDIS_USERNAME,
      password:
        option('--redis-password') ||
        process.env.CFRAME_REDIS_PASSWORD ||
        DEFAULT_REDIS_PASSWORD,
      environment,
    })
    memberSession = await writeRedisSessionFixture({
      redisURL,
      username: option('--redis-username') || process.env.CFRAME_REDIS_USERNAME,
      password:
        option('--redis-password') ||
        process.env.CFRAME_REDIS_PASSWORD ||
        DEFAULT_REDIS_PASSWORD,
      environment,
      token: FIXTURE_MEMBER_SESSION_TOKEN,
      userId: DUAL_BACKEND_COMPARE_FIXTURE.memberUserId,
    })
  }

  const result = {
    databasePath,
    sqliteSeeded,
    storageSeeded: Boolean(storageObjectPath),
    storageObjectPath,
    fixture: DUAL_BACKEND_COMPARE_FIXTURE,
    redisSeeded: !flag('--no-redis'),
    fixtureAdmin: {
      email: FIXTURE_ADMIN_EMAIL,
      password: FIXTURE_ADMIN_PASSWORD,
    },
    fixtureMember: {
      email: FIXTURE_MEMBER_EMAIL,
      password: FIXTURE_MEMBER_PASSWORD,
    },
    sessionCookie: session.cookie,
    memberSessionCookie: memberSession.cookie,
    compareAllCommand: 'pnpm dual:compare',
  }
  console.log(JSON.stringify(result, null, 2))
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
