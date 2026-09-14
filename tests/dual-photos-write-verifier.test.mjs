import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  normalizePhotoUpdateResponse,
  parsePhotosWriteVerifierOptions,
} from '../scripts/verify-dual-photos-write.mjs'

test('photos-write verifier parser accepts explicit isolated settings', () => {
  const options = parsePhotosWriteVerifierOptions(
    [
      '--base',
      'http://gateway/',
      '--cookie',
      'cf_session=test',
      '--db',
      './data/test.sqlite3',
      '--prefix',
      'photos-write-test',
      '--timeout-ms',
      '12345',
    ],
    {},
  )

  assert.equal(options.base, 'http://gateway')
  assert.equal(options.cookie, 'cf_session=test')
  assert.equal(
    options.databasePath,
    path.resolve(process.cwd(), 'data/test.sqlite3'),
  )
  assert.equal(options.prefix, 'photos-write-test')
  assert.equal(options.timeoutMs, 12345)
  assert.equal(typeof options.fetchImpl, 'function')
})

test('photos-write verifier rejects missing database scope', () => {
  assert.throws(
    () => parsePhotosWriteVerifierOptions([], {}),
    /requires --db <sqlite-path>/,
  )
})

test('photo update comparison normalizes only fixture-specific fields', () => {
  const body = {
    success: true,
    photo: {
      id: 'node-id',
      storageKey: 'fixtures/node.jpg',
      lastModified: '2026-03-08T01:02:03.456Z',
      title: 'Same Title',
      exif: { Rating: 4, Subject: ['One', 'TWO'] },
    },
  }
  const normalized = normalizePhotoUpdateResponse(body, {
    id: 'node-id',
    key: 'fixtures/node.jpg',
  })

  assert.deepEqual(normalized, {
    photo: {
      exif: { Rating: 4, Subject: ['One', 'TWO'] },
      id: '<photo-id>',
      lastModified: '<iso-milliseconds>',
      storageKey: '<storage-key>',
      title: 'Same Title',
    },
    success: true,
  })
  assert.equal(body.photo.id, 'node-id', 'input must not be mutated')
})
