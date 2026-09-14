import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decodeBackendProviderSetting,
  readBackendProviderForDispatch,
} from '../backend/nodejs/utils/backend-provider-setting'

test('backend provider setting decodes stored values and fails closed to Node', () => {
  assert.equal(
    decodeBackendProviderSetting({ type: 'string', value: 'go' }),
    'go',
  )
  assert.equal(
    decodeBackendProviderSetting({ type: 'string', value: 'node' }),
    'node',
  )
  assert.equal(
    decodeBackendProviderSetting({ type: 'string', value: 'unexpected' }),
    'node',
  )
  assert.equal(
    decodeBackendProviderSetting({ type: 'boolean', value: 'true' }),
    'node',
  )
  assert.equal(decodeBackendProviderSetting(undefined), 'node')
})

test('dispatch backend provider reads the database on every request', () => {
  const database = createBackendProviderDatabase([
    { type: 'string', value: 'go' },
    { type: 'string', value: 'node' },
  ])

  assert.equal(readBackendProviderForDispatch(database.instance), 'go')
  assert.equal(readBackendProviderForDispatch(database.instance), 'node')
  assert.equal(database.getCalls(), 2)
})

function createBackendProviderDatabase(
  rows: Array<Parameters<typeof decodeBackendProviderSetting>[0]>,
) {
  let calls = 0

  return {
    instance: {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  get() {
                    const row = rows[Math.min(calls, rows.length - 1)]
                    calls += 1
                    return row
                  },
                }
              },
            }
          },
        }
      },
    } as unknown as Parameters<typeof readBackendProviderForDispatch>[0],
    getCalls() {
      return calls
    },
  }
}
