import assert from 'node:assert/strict'
import test from 'node:test'

import { pipelineWorkerTelemetryKey } from '../backend/nodejs/utils/pipeline-telemetry'

test('pipeline worker telemetry key is shared-state namespaced', () => {
  assert.equal(
    pipelineWorkerTelemetryKey('development'),
    'cf:v1:development:pipeline:worker_pool:stats',
  )
  assert.equal(
    pipelineWorkerTelemetryKey('production'),
    'cf:v1:production:pipeline:worker_pool:stats',
  )
})
