import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertNoDuplicateJsonObjectKeys,
  findDuplicateJsonObjectKeys,
} from '../scripts/verify-route-contract.mjs'

test('route contract JSON reader rejects duplicate object keys', () => {
  const duplicates = findDuplicateJsonObjectKeys(`{
    "routes": [
      { "id": "first", "id": "second" },
      { "nested": { "key": 1, "key": 2 } }
    ]
  }`)

  assert.deepEqual(
    duplicates.map(({ path, key }) => ({ path, key })),
    [
      { path: '$.routes[0]', key: 'id' },
      { path: '$.routes[1].nested', key: 'key' },
    ],
  )
  assert.throws(
    () =>
      assertNoDuplicateJsonObjectKeys(
        '{ "route": { "id": "a", "id": "b" } }',
        'routes.yaml',
      ),
    /routes\.yaml contains duplicate object keys:[\s\S]*"id"/,
  )
})

test('route contract JSON reader allows the same key in sibling objects', () => {
  assert.deepEqual(
    findDuplicateJsonObjectKeys(
      '{ "a": 1, "items": [{ "id": 1 }, { "id": 2 }], "nested": { "a": 2 } }',
    ),
    [],
  )
  assert.doesNotThrow(() =>
    assertNoDuplicateJsonObjectKeys('{ "route": { "id": "a" } }', 'ok.json'),
  )
})
