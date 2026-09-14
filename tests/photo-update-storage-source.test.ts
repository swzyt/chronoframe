import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../backend/nodejs/api/photos/[photoId]/index.put.ts', import.meta.url),
  'utf8',
)

test('photo metadata update preserves storage keys containing prefix text', () => {
  assert.match(
    source,
    /storageProvider\.create\(photo\.storageKey, updatedBuffer\)/,
  )
  assert.doesNotMatch(source, /storageKey\.replace\(prefix/)
})
