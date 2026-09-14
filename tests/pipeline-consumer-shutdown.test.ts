import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workerPoolSource = readFileSync(
  new URL('../backend/nodejs/services/pipeline-queue/worker-pool.ts', import.meta.url),
  'utf8',
)
const pluginSource = readFileSync(
  new URL('../backend/nodejs/plugins/4.pipeline-queue.ts', import.meta.url),
  'utf8',
)

test('Node pipeline handoff releases the runtime lease only after workers drain', () => {
  assert.match(workerPoolSource, /async stop\(\): Promise<boolean>/)
  assert.match(
    workerPoolSource,
    /const drained = drainResults\.every\(Boolean\)/,
  )
  assert.match(workerPoolSource, /runtime lease must remain held/)
  assert.match(pluginSource, /const drained = await workerPool\.stop\(\)/)
  assert.match(pluginSource, /if \(drained\) \{[\s\S]*?lease\?\.release\(\)/)
  assert.match(
    pluginSource,
    /Keeping the Node pipeline consumer lease until process exit/,
  )
})
