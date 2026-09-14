import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isNodeOwner,
  parseRuntimeOwner,
  resolveRuntimeOwnership,
  RUNTIME_OWNERS,
} from '../backend/nodejs/utils/runtime-ownership'
import {
  runtimeLeaseKey,
  runtimeLeaseValue,
} from '../backend/nodejs/utils/runtime-lease'

test('runtime ownership defaults every role to node only when unset', () => {
  assert.deepEqual(resolveRuntimeOwnership({}), {
    dbMigrator: 'node',
    pipelineConsumer: 'node',
    backupScheduler: 'node',
  })
})

test('runtime ownership accepts each explicit owner for every role', () => {
  for (const owner of RUNTIME_OWNERS) {
    assert.deepEqual(
      resolveRuntimeOwnership({
        CFRAME_DB_MIGRATOR: owner,
        CFRAME_PIPELINE_CONSUMER: owner,
        CFRAME_BACKUP_SCHEDULER: owner,
      }),
      {
        dbMigrator: owner,
        pipelineConsumer: owner,
        backupScheduler: owner,
      },
    )
  }
})

test('runtime ownership rejects empty, normalized-looking, and unknown values', () => {
  for (const value of ['', 'NODE', ' node', 'node ', 'true', 'disabled']) {
    assert.throws(
      () => parseRuntimeOwner('CFRAME_PIPELINE_CONSUMER', value),
      /Invalid CFRAME_PIPELINE_CONSUMER value/,
    )
  }
})

test('runtime ownership reports which environment variable is invalid', () => {
  assert.throws(
    () =>
      resolveRuntimeOwnership({
        CFRAME_DB_MIGRATOR: 'node',
        CFRAME_PIPELINE_CONSUMER: 'none',
        CFRAME_BACKUP_SCHEDULER: 'cron',
      }),
    /CFRAME_BACKUP_SCHEDULER/,
  )
})

test('node ownership predicate enables only the node owner', () => {
  assert.equal(isNodeOwner('node'), true)
  assert.equal(isNodeOwner('go'), false)
  assert.equal(isNodeOwner('none'), false)
})

test('runtime lease key is shared-state namespaced', () => {
  assert.equal(
    runtimeLeaseKey('pipeline-consumer', 'development'),
    'cf:v1:development:lease:pipeline-consumer',
  )
  assert.throws(
    () => runtimeLeaseKey('pipeline-consumer', 'Prod'),
    /invalid shared-state namespace/,
  )
  assert.throws(
    () => runtimeLeaseKey('migrator' as never, 'development'),
    /Unsupported runtime lease actor/,
  )
})

test('runtime lease value records owner and instance identity', () => {
  const value = JSON.parse(runtimeLeaseValue('go', 'go-test-instance'))
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.owner, 'go')
  assert.equal(value.instance, 'go-test-instance')
  assert.equal(typeof value.acquiredAt, 'number')
  assert.throws(
    () => runtimeLeaseValue('python' as never, 'test-instance'),
    /Unsupported runtime lease owner/,
  )
})
