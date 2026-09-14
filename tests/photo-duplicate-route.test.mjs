import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('photo duplicate API reads content hashes from the validated body', () => {
  const source = readFileSync(
    resolve(__dirname, '../backend/nodejs/api/photos/check-duplicate.post.ts'),
    'utf8',
  )

  assert.match(
    source,
    /const\s*\{\s*fileNames,\s*storageKeys,\s*contentHashes\s*\}\s*=\s*await readValidatedBody/,
  )
})
