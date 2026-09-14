import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

import {
  parseLivePhotoVerifierOptions,
  verifyDualLivePhoto,
} from '../scripts/verify-dual-livephoto.mjs'

function createFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cframe-livephoto-'))
  const databasePath = path.join(directory, 'app.sqlite3')
  const storagePath = path.join(directory, 'storage')
  const database = new Database(databasePath)
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY,
      title TEXT,
      media_type TEXT NOT NULL,
      storage_key TEXT,
      file_size INTEGER,
      last_modified TEXT,
      tags TEXT,
      exif TEXT,
      is_live_photo INTEGER NOT NULL DEFAULT 0,
      live_photo_video_url TEXT,
      live_photo_video_key TEXT,
      owner_user_id INTEGER REFERENCES users(id)
    );
    CREATE TABLE settings (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY(namespace, key)
    );
    CREATE TABLE settings_storage_providers (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      config TEXT NOT NULL
    );
    INSERT INTO users(id) VALUES (910001);
    INSERT INTO settings(namespace, key, value)
    VALUES ('storage', 'provider', '1');
  `)
  database
    .prepare(
      `INSERT INTO settings_storage_providers(id, provider, config)
       VALUES (1, 'local', ?)`,
    )
    .run(
      JSON.stringify({
        basePath: storagePath,
        baseUrl: '/storage',
        prefix: 'unit-fixture',
      }),
    )
  database.close()
  return {
    databasePath,
    directory,
    storagePath,
    cleanup() {
      rmSync(directory, { force: true, recursive: true })
    },
  }
}

function createGateway(fixture, { breakGoProcess = false } = {}) {
  const state = { provider: 'node' }
  const open = () => {
    const database = new Database(fixture.databasePath)
    database.pragma('foreign_keys = ON')
    return database
  }
  const objectPath = (key) =>
    path.join(fixture.storagePath, 'unit-fixture', key)
  const publicURL = (key) => `/storage/unit-fixture/${key}`
  const json = (body, backend = state.provider, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'X-ChronoFrame-Backend': backend,
      },
    })

  return {
    state,
    async fetchImpl(input, init) {
      const url = new URL(input)
      const body = init.body ? JSON.parse(init.body) : undefined
      if (
        url.pathname === '/api/system/settings/system/backend.readProvider' &&
        init.method === 'PUT'
      ) {
        state.provider = body.value
        return json({ value: body.value }, 'node')
      }

      if (
        url.pathname === '/api/photos/livephoto/manage' &&
        init.method === 'POST'
      ) {
        const database = open()
        try {
          if (body.action === 'detect') {
            const rows = database
              .prepare(
                `SELECT id, storage_key
                 FROM photos
                 WHERE is_live_photo = 0 AND id IN (${body.photoIds
                   .map(() => '?')
                   .join(', ')})`,
              )
              .all(...body.photoIds)
            const results = rows.flatMap((row) => {
              const videoKey = row.storage_key.replace(/\.[^.]+$/, '.MOV')
              const file = objectPath(videoKey)
              if (!existsSync(file)) return []
              return [
                {
                  photoId: row.id,
                  storageKey: row.storage_key,
                  found: true,
                  videoKey,
                  videoSize: readFileSync(file).length,
                },
              ]
            })
            return json({
              message: 'Batch LivePhoto detection completed',
              results: {
                total: rows.length,
                processed: rows.length,
                found: results.length,
                results,
              },
            })
          }

          if (body.action === 'process') {
            if (breakGoProcess && state.provider === 'go') {
              return json({
                message: 'Failed to process LivePhoto',
                success: false,
                videoKey: body.videoKey,
              })
            }
            const imageKey = body.videoKey.replace(/\.[^.]+$/, '.HEIC')
            database
              .prepare(
                `UPDATE photos
                 SET is_live_photo = 1,
                     live_photo_video_url = ?,
                     live_photo_video_key = ?
                 WHERE storage_key = ?`,
              )
              .run(publicURL(body.videoKey), body.videoKey, imageKey)
            return json({
              message: 'LivePhoto processed successfully',
              success: true,
              videoKey: body.videoKey,
            })
          }

          if (body.action === 'update-photo') {
            const row = database
              .prepare('SELECT storage_key FROM photos WHERE id = ?')
              .get(body.photoId)
            const videoKey = row.storage_key.replace(/\.[^.]+$/, '.MOV')
            database
              .prepare(
                `UPDATE photos
                 SET is_live_photo = 1,
                     live_photo_video_url = ?,
                     live_photo_video_key = ?
                 WHERE id = ?`,
              )
              .run(publicURL(videoKey), videoKey, body.photoId)
            return json({
              message: 'Photo updated to LivePhoto successfully',
              success: true,
              photoId: body.photoId,
              videoKey,
            })
          }
        } finally {
          database.close()
        }
      }

      const livePhotoMatch = url.pathname.match(
        /^\/api\/photos\/([^/]+)\/livephoto$/,
      )
      if (livePhotoMatch && init.method === 'GET') {
        const id = decodeURIComponent(livePhotoMatch[1])
        const database = open()
        try {
          const row = database
            .prepare(
              `SELECT id, title, is_live_photo, live_photo_video_url
               FROM photos WHERE id = ?`,
            )
            .get(id)
          return json({
            id: row.id,
            title: row.title,
            isLivePhoto: Boolean(row.is_live_photo),
            livePhotoVideoUrl: row.live_photo_video_url,
            originalUrl: null,
            thumbnailUrl: null,
          })
        } finally {
          database.close()
        }
      }

      const deleteMatch = url.pathname.match(/^\/api\/photos\/([^/]+)$/)
      if (deleteMatch && init.method === 'DELETE') {
        const id = decodeURIComponent(deleteMatch[1])
        const database = open()
        try {
          const row = database
            .prepare('SELECT live_photo_video_key FROM photos WHERE id = ?')
            .get(id)
          if (row?.live_photo_video_key) {
            try {
              unlinkSync(objectPath(row.live_photo_video_key))
            } catch (error) {
              if (error.code !== 'ENOENT') throw error
            }
          }
          database.prepare('DELETE FROM photos WHERE id = ?').run(id)
          return json({
            statusCode: 200,
            statusMessage: 'Photo deleted successfully',
          })
        } finally {
          database.close()
        }
      }

      return json({ message: 'not found' }, state.provider, 404)
    },
  }
}

function countTemporaryRows(databasePath) {
  const database = new Database(databasePath)
  try {
    return database
      .prepare(
        "SELECT COUNT(*) AS count FROM photos WHERE id LIKE 'unit-livephoto-%'",
      )
      .get().count
  } finally {
    database.close()
  }
}

test('Live Photo verifier proves cross-backend writes, reads, and deletion cleanup', async () => {
  const fixture = createFixture()
  try {
    const gateway = createGateway(fixture)
    const summary = await verifyDualLivePhoto({
      base: 'http://dual.test',
      databasePath: fixture.databasePath,
      fetchImpl: gateway.fetchImpl,
      prefix: 'unit-livephoto',
    })

    assert.equal(summary.ok, true)
    assert.equal(summary.checkCount, 26)
    assert.equal(summary.cases.length, 4)
    assert.deepEqual(
      summary.cases.map(({ writer, reader, action, cleanedBy }) => ({
        writer,
        reader,
        action,
        cleanedBy,
      })),
      [
        { writer: 'node', reader: 'go', action: 'process', cleanedBy: 'go' },
        { writer: 'go', reader: 'node', action: 'process', cleanedBy: 'node' },
        {
          writer: 'node',
          reader: 'go',
          action: 'update-photo',
          cleanedBy: 'go',
        },
        {
          writer: 'go',
          reader: 'node',
          action: 'update-photo',
          cleanedBy: 'node',
        },
      ],
    )
    assert.deepEqual(
      summary.cleanup.map(({ name, ok }) => ({ name, ok })),
      [
        { name: 'restore backend provider to node', ok: true },
        { name: 'delete 0 remaining Live Photo fixtures', ok: true },
      ],
    )
    assert.equal(gateway.state.provider, 'node')
    assert.equal(countTemporaryRows(fixture.databasePath), 0)
  } finally {
    fixture.cleanup()
  }
})

test('Live Photo verifier rejects Go response drift and still cleans fixtures', async () => {
  const fixture = createFixture()
  try {
    const gateway = createGateway(fixture, { breakGoProcess: true })
    await assert.rejects(
      () =>
        verifyDualLivePhoto({
          base: 'http://dual.test',
          databasePath: fixture.databasePath,
          fetchImpl: gateway.fetchImpl,
          prefix: 'unit-livephoto',
        }),
      /expected body.message="LivePhoto processed successfully"/,
    )
    assert.equal(gateway.state.provider, 'node')
    assert.equal(countTemporaryRows(fixture.databasePath), 0)
  } finally {
    fixture.cleanup()
  }
})

test('Live Photo verifier parser requires SQLite and accepts explicit values', () => {
  assert.throws(
    () => parseLivePhotoVerifierOptions([], {}),
    /requires --db <sqlite-path>/,
  )
  const options = parseLivePhotoVerifierOptions(
    [
      '--base=http://dual.local/',
      '--cookie',
      'cf_session=test',
      '--db',
      './data/livephoto.sqlite3',
      '--prefix',
      'livephoto-check',
      '--timeout-ms',
      '4321',
    ],
    {},
  )
  assert.equal(options.base, 'http://dual.local')
  assert.equal(options.cookie, 'cf_session=test')
  assert.equal(options.databasePath, path.resolve('./data/livephoto.sqlite3'))
  assert.equal(options.prefix, 'livephoto-check')
  assert.equal(options.timeoutMs, 4321)
})
