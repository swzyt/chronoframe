import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const photoDeleteSource = readFileSync(
  new URL('../backend/nodejs/api/photos/[photoId]/index.delete.ts', import.meta.url),
  'utf8',
)

test('Node photo deletion removes every generated media object', () => {
  for (const key of [
    'photo.storageKey',
    'photo.thumbnailKey',
    'photo.displayKey',
    'photo.livePhotoVideoKey',
    'photo.videoPlaybackKey',
  ]) {
    assert.ok(
      photoDeleteSource.includes(`storageProvider.delete(${key})`),
      `missing storage deletion for ${key}`,
    )
  }
})
