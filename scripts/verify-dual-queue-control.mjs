#!/usr/bin/env node
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import {
  FIXTURE_MEMBER_SESSION_TOKEN,
  FIXTURE_SESSION_TOKEN,
  resolveSQLitePath,
} from './seed-dual-backend-fixture.mjs'
import {
  canonicalize,
  DUAL_BACKEND_COMPARE_FIXTURE,
  joinBackendURL,
} from './compare-backends.mjs'

const DEFAULT_BASE = process.env.CFRAME_DUAL_BASE ?? 'http://127.0.0.1:3010'
const DEFAULT_TIMEOUT_MS = Number(process.env.CFRAME_DUAL_TIMEOUT_MS ?? '10000')
const DEFAULT_COOKIE =
  process.env.CFRAME_DUAL_COOKIE ?? `cf_session=${FIXTURE_SESSION_TOKEN}`
const DEFAULT_MEMBER_COOKIE = `cf_session=${FIXTURE_MEMBER_SESSION_TOKEN}`
const DEFAULT_PREFIX =
  process.env.CFRAME_DUAL_QUEUE_PREFIX ?? 'dual-queue-control'

export const QUEUE_CONTROL_ROUTE_IDS = Object.freeze([
  'queue.add-task',
  'queue.add-tasks',
  'queue.task-stats',
  'queue.stats',
  'queue.clear',
  'queue.tasks.list',
  'queue.retry-batch',
  'queue.retry',
])

const FIXTURE_TASK_ID = DUAL_BACKEND_COMPARE_FIXTURE.queueTaskId
const VALID_TASK_BODY = Object.freeze({
  payload: Object.freeze({
    type: 'photo',
    storageKey: 'originals/dual-fixture-photo-1.jpg',
  }),
})
const VALID_BATCH_BODY = Object.freeze({
  tasks: Object.freeze([Object.freeze({ payload: VALID_TASK_BODY.payload })]),
})

export const QUEUE_CONTROL_READ_CASES = Object.freeze([
  pairCase(
    'queue task stats match',
    'GET',
    `/api/queue/stats/${FIXTURE_TASK_ID}`,
    'admin',
    200,
  ),
  pairCase(
    'queue task stats accept decimal integer notation',
    'GET',
    `/api/queue/stats/${FIXTURE_TASK_ID}.0`,
    'admin',
    200,
  ),
  pairCase(
    'queue task stats accept exponent notation',
    'GET',
    '/api/queue/stats/9.10001e5',
    'admin',
    200,
  ),
  pairCase(
    'queue task stats accept hexadecimal notation',
    'GET',
    '/api/queue/stats/0xde2b1',
    'admin',
    200,
  ),
  pairCase(
    'queue task stats accept ECMAScript whitespace',
    'GET',
    `/api/queue/stats/%20${FIXTURE_TASK_ID}%20`,
    'admin',
    200,
  ),
  pairCase(
    'queue global stats match shared telemetry',
    'GET',
    '/api/queue/stats',
    'admin',
    200,
    {
      normalizers: ['/timestamp', '/pool/workers/*/uptime'],
    },
  ),
  pairCase(
    'queue task list matches',
    'GET',
    '/api/queue/task/list',
    'admin',
    200,
  ),
  pairCase(
    'queue task list filters match',
    'GET',
    '/api/queue/task/list?status=completed&type=photo',
    'admin',
    200,
  ),
])

export const QUEUE_CONTROL_BOUNDARY_CASES = Object.freeze([
  pairCase(
    'anonymous cannot add a queue task',
    'POST',
    '/api/queue/add-task',
    'anonymous',
    401,
    { body: VALID_TASK_BODY },
  ),
  pairCase(
    'anonymous cannot batch add queue tasks',
    'POST',
    '/api/queue/add-tasks',
    'anonymous',
    401,
    { body: VALID_BATCH_BODY },
  ),
  pairCase(
    'anonymous cannot read queue task stats',
    'GET',
    `/api/queue/stats/${FIXTURE_TASK_ID}`,
    'anonymous',
    401,
  ),
  pairCase(
    'anonymous cannot read global queue stats',
    'GET',
    '/api/queue/stats',
    'anonymous',
    401,
  ),
  pairCase(
    'anonymous cannot clear queue tasks',
    'DELETE',
    '/api/queue/task/clear?includeCompleted=false&includeFailed=false',
    'anonymous',
    401,
  ),
  pairCase(
    'anonymous cannot list queue tasks',
    'GET',
    '/api/queue/task/list',
    'anonymous',
    401,
  ),
  pairCase(
    'anonymous cannot batch retry queue tasks',
    'POST',
    '/api/queue/task/retry-batch',
    'anonymous',
    401,
    { body: { taskIds: [FIXTURE_TASK_ID] } },
  ),
  pairCase(
    'anonymous cannot retry a queue task',
    'POST',
    '/api/queue/task/retry',
    'anonymous',
    401,
    { body: { taskId: FIXTURE_TASK_ID } },
  ),
  pairCase(
    'member cannot read global queue stats',
    'GET',
    '/api/queue/stats',
    'member',
    403,
  ),
  pairCase(
    'member cannot clear queue tasks',
    'DELETE',
    '/api/queue/task/clear?includeCompleted=false&includeFailed=false',
    'member',
    403,
  ),
  pairCase(
    'member cannot list queue tasks',
    'GET',
    '/api/queue/task/list',
    'member',
    403,
  ),
  pairCase(
    'member cannot batch retry queue tasks',
    'POST',
    '/api/queue/task/retry-batch',
    'member',
    403,
    { body: { taskIds: [FIXTURE_TASK_ID] } },
  ),
  pairCase(
    'member cannot retry a queue task',
    'POST',
    '/api/queue/task/retry',
    'member',
    403,
    { body: { taskId: FIXTURE_TASK_ID } },
  ),
  pairCase(
    'member cannot read another owner queue task',
    'GET',
    `/api/queue/stats/${FIXTURE_TASK_ID}`,
    'member',
    404,
  ),
  pairCase(
    'member cannot enqueue another owner storage object',
    'POST',
    '/api/queue/add-task',
    'member',
    404,
    { body: VALID_TASK_BODY },
  ),
  pairCase(
    'member batch add reports inaccessible storage object',
    'POST',
    '/api/queue/add-tasks',
    'member',
    200,
    { body: VALID_BATCH_BODY },
  ),
  ...[
    ['without a body', undefined, 400],
    ['with an empty body', '', 400],
    ['with malformed JSON', '{', 400],
    ['with a trailing JSON value', '{} {}', 400],
    ['with null body', 'null', 400],
    ['with number body', '1', 400],
    ['without payload', '{}', 400],
    ['with null payload', '{"payload":null}', 400],
    [
      'with invalid discriminator',
      '{"payload":{"type":"unknown","storageKey":"x"}}',
      400,
    ],
    [
      'with empty storage key',
      '{"payload":{"type":"photo","storageKey":""}}',
      400,
    ],
    [
      'with invalid content hash',
      '{"payload":{"type":"photo","storageKey":"x","contentHash":"bad"}}',
      400,
    ],
    [
      'with invalid erase location',
      '{"payload":{"type":"photo","storageKey":"x","eraseLocation":"true"}}',
      400,
    ],
    [
      'with priority below range',
      '{"payload":{"type":"photo","storageKey":"x"},"priority":-1}',
      400,
    ],
    [
      'with priority above range',
      '{"payload":{"type":"photo","storageKey":"x"},"priority":10}',
      400,
    ],
    [
      'with max attempts below range',
      '{"payload":{"type":"photo","storageKey":"x"},"maxAttempts":0}',
      400,
    ],
    [
      'with max attempts above range',
      '{"payload":{"type":"photo","storageKey":"x"},"maxAttempts":6}',
      400,
    ],
  ].map(([name, rawBody, status]) =>
    pairCase(
      `queue add rejects ${name}`,
      'POST',
      '/api/queue/add-task',
      'admin',
      status,
      { rawBody },
    ),
  ),
  ...[
    ['without a body', undefined],
    ['with an empty body', ''],
    ['with malformed JSON', '{'],
    ['with a trailing JSON value', '{} {}'],
    ['with null body', 'null'],
    ['without tasks', '{}'],
    ['with empty tasks', '{"tasks":[]}'],
    ['with null task', '{"tasks":[null]}'],
    [
      'with video task',
      '{"tasks":[{"payload":{"type":"video","storageKey":"x"}}]}',
    ],
    [
      'with invalid nested options',
      '{"tasks":[{"payload":{"type":"photo","storageKey":"x"},"priority":10,"maxAttempts":0}]}',
    ],
    [
      'with invalid default options',
      '{"tasks":[{"payload":{"type":"photo","storageKey":"x"}}],"defaultPriority":10,"defaultMaxAttempts":0}',
    ],
  ].map(([name, rawBody]) =>
    pairCase(
      `queue batch add rejects ${name}`,
      'POST',
      '/api/queue/add-tasks',
      'admin',
      400,
      { rawBody },
    ),
  ),
  pairCase(
    'queue task stats reject missing numeric task',
    'GET',
    '/api/queue/stats/999999999',
    'admin',
    404,
  ),
  pairCase(
    'queue task stats reject fractional task id',
    'GET',
    '/api/queue/stats/910001.5',
    'admin',
    404,
  ),
  pairCase(
    'queue task stats reject non-numeric task id',
    'GET',
    '/api/queue/stats/not-a-number',
    'admin',
    404,
  ),
  pairCase(
    'queue list rejects invalid status',
    'GET',
    '/api/queue/task/list?status=unknown',
    'admin',
    500,
  ),
  pairCase(
    'queue list rejects invalid type',
    'GET',
    '/api/queue/task/list?type=unknown',
    'admin',
    500,
  ),
  pairCase(
    'queue list rejects repeated status',
    'GET',
    '/api/queue/task/list?status=completed&status=failed',
    'admin',
    500,
  ),
  pairCase(
    'queue list rejects repeated type',
    'GET',
    '/api/queue/task/list?type=photo&type=video',
    'admin',
    500,
  ),
  ...[
    ['without a body', undefined],
    ['with an empty body', ''],
    ['with malformed JSON', '{'],
    ['with null body', 'null'],
    ['without task id', '{}'],
    ['with null task id', '{"taskId":null}'],
    ['with fractional task id', '{"taskId":1.5}'],
    ['with non-positive task id', '{"taskId":0}'],
  ].map(([name, rawBody]) =>
    pairCase(
      `queue retry rejects ${name}`,
      'POST',
      '/api/queue/task/retry',
      'admin',
      400,
      { rawBody },
    ),
  ),
  pairCase(
    'queue retry reports missing task',
    'POST',
    '/api/queue/task/retry',
    'admin',
    404,
    { body: { taskId: 999999999 } },
  ),
  pairCase(
    'queue retry rejects non-failed task',
    'POST',
    '/api/queue/task/retry',
    'admin',
    400,
    { body: { taskId: FIXTURE_TASK_ID } },
  ),
  ...[
    ['without a body', undefined, 400],
    ['with an empty body', '', 400],
    ['with malformed JSON', '{', 400],
    ['with null body', 'null', 400],
    ['without selection', '{}', 400],
    ['with empty task ids', '{"taskIds":[]}', 400],
    ['with null task ids', '{"taskIds":null}', 400],
    ['with invalid task id', '{"taskIds":[1.5]}', 400],
    ['with invalid retry all', '{"retryAll":"true"}', 400],
  ].map(([name, rawBody, status]) =>
    pairCase(
      `queue batch retry rejects ${name}`,
      'POST',
      '/api/queue/task/retry-batch',
      'admin',
      status,
      { rawBody },
    ),
  ),
  pairCase(
    'queue batch retry reports non-failed task',
    'POST',
    '/api/queue/task/retry-batch',
    'admin',
    200,
    { body: { taskIds: [FIXTURE_TASK_ID, FIXTURE_TASK_ID] } },
  ),
  pairCase(
    'queue clear requires at least one selected status',
    'DELETE',
    '/api/queue/task/clear?includeCompleted=false&includeFailed=false',
    'admin',
    400,
  ),
  pairCase(
    'queue clear rejects negative age',
    'DELETE',
    '/api/queue/task/clear?includeCompleted=true&includeFailed=true&olderThanDays=-1',
    'admin',
    400,
  ),
  pairCase(
    'queue clear rejects nonnumeric age',
    'DELETE',
    '/api/queue/task/clear?includeCompleted=true&includeFailed=true&olderThanDays=never',
    'admin',
    400,
  ),
  pairCase(
    'queue clear accepts decimal numeric prefix',
    'DELETE',
    '/api/queue/task/clear?includeCompleted=true&includeFailed=true&olderThanDays=200000.5',
    'admin',
    200,
  ),
  pairCase(
    'queue clear accepts trailing numeric prefix',
    'DELETE',
    '/api/queue/task/clear?includeCompleted=true&includeFailed=true&olderThanDays=200000x',
    'admin',
    200,
  ),
  pairCase(
    'queue clear accepts hexadecimal prefix',
    'DELETE',
    '/api/queue/task/clear?includeCompleted=true&includeFailed=true&olderThanDays=0x30d40',
    'admin',
    200,
  ),
  pairCase(
    'queue clear rejects repeated status selector',
    'DELETE',
    '/api/queue/task/clear?includeCompleted=true&includeCompleted=true&includeFailed=true&olderThanDays=200000',
    'admin',
    500,
  ),
  pairCase(
    'queue clear rejects repeated age',
    'DELETE',
    '/api/queue/task/clear?includeCompleted=true&includeFailed=true&olderThanDays=200000&olderThanDays=200001',
    'admin',
    500,
  ),
])

function pairCase(name, method, path, cookie, expectedStatus, options = {}) {
  return Object.freeze({
    name,
    method,
    path,
    cookie,
    expectedStatus,
    ...options,
  })
}

export async function verifyDualQueueControl(options = {}) {
  const normalized = normalizeOptions(options)
  const summary = {
    ok: false,
    base: normalized.base,
    nodeURL: normalized.nodeURL,
    goURL: normalized.goURL,
    databasePath: normalized.databasePath,
    routeIds: [...QUEUE_CONTROL_ROUTE_IDS],
    checks: [],
    cleanup: [],
    temporaryTaskIds: [],
  }
  const state = {
    nextQueueTaskId: null,
    queueTaskIds: new Set(),
  }
  const api = createQueueControlAPI(normalized, summary)

  try {
    await setProvider(api, 'node')
    await verifyQueuePairCases(
      normalized,
      summary,
      normalized.readCases,
      'read',
    )
    await verifyQueuePairCases(
      normalized,
      summary,
      normalized.boundaryCases,
      'boundary',
    )

    const nodeFractionalPayload = {
      type: 'photo',
      storageKey: `${normalized.prefix}/fractional-node.jpg`,
    }
    const nodeFractionalAdd = await api.request({
      name: 'queue control: node adds fractional queue numbers',
      method: 'POST',
      path: '/api/queue/add-task',
      expectedBackend: 'node',
      body: {
        payload: nodeFractionalPayload,
        priority: 1.5,
        maxAttempts: 2.5,
      },
    })
    const nodeFractionalTaskId = expectQueueAddResponse(
      nodeFractionalAdd.name,
      nodeFractionalAdd.body,
      nodeFractionalPayload,
    )
    state.queueTaskIds.add(nodeFractionalTaskId)
    summary.temporaryTaskIds.push(nodeFractionalTaskId)

    await setProvider(api, 'go')
    const goReadNodeFractional = await api.request({
      name: 'queue control: go reads node fractional queue numbers',
      method: 'GET',
      path: `/api/queue/stats/${nodeFractionalTaskId}`,
      expectedBackend: 'go',
    })
    expectQueueNumbers(
      goReadNodeFractional.name,
      goReadNodeFractional.body,
      1.5,
      2.5,
    )

    const goFractionalPayload = {
      type: 'photo',
      storageKey: `${normalized.prefix}/fractional-go.jpg`,
    }
    const goFractionalAdd = await api.request({
      name: 'queue control: go adds fractional queue numbers',
      method: 'POST',
      path: '/api/queue/add-task',
      expectedBackend: 'go',
      body: {
        payload: goFractionalPayload,
        priority: 8.5,
        maxAttempts: 4.5,
      },
    })
    const goFractionalTaskId = expectQueueAddResponse(
      goFractionalAdd.name,
      goFractionalAdd.body,
      goFractionalPayload,
    )
    state.queueTaskIds.add(goFractionalTaskId)
    summary.temporaryTaskIds.push(goFractionalTaskId)

    await setProvider(api, 'node')
    const nodeReadGoFractional = await api.request({
      name: 'queue control: node reads go fractional queue numbers',
      method: 'GET',
      path: `/api/queue/stats/${goFractionalTaskId}`,
      expectedBackend: 'node',
    })
    expectQueueNumbers(
      nodeReadGoFractional.name,
      nodeReadGoFractional.body,
      8.5,
      4.5,
    )

    const nodeBatchPayloads = [
      {
        type: 'photo',
        storageKey: `${normalized.prefix}/fractional-node-batch-default.jpg`,
      },
      {
        type: 'photo-erase-location',
        photoId: `${normalized.prefix}-missing-node-photo`,
      },
    ]
    const nodeFractionalBatch = await api.request({
      name: 'queue control: node batch adds fractional queue numbers',
      method: 'POST',
      path: '/api/queue/add-tasks',
      expectedBackend: 'node',
      body: {
        tasks: [
          { payload: nodeBatchPayloads[0] },
          {
            payload: nodeBatchPayloads[1],
            priority: 7.5,
            maxAttempts: 1.5,
          },
        ],
        defaultPriority: 2.5,
        defaultMaxAttempts: 3.5,
      },
    })
    const nodeBatchTaskIds = expectQueueBatchAddResponse(
      nodeFractionalBatch.name,
      nodeFractionalBatch.body,
      nodeBatchPayloads,
    )
    for (const taskId of nodeBatchTaskIds) {
      state.queueTaskIds.add(taskId)
      summary.temporaryTaskIds.push(taskId)
    }

    await setProvider(api, 'go')
    const goReadNodeBatchDefault = await api.request({
      name: 'queue control: go reads node batch fractional defaults',
      method: 'GET',
      path: `/api/queue/stats/${nodeBatchTaskIds[0]}`,
      expectedBackend: 'go',
    })
    expectQueueNumbers(
      goReadNodeBatchDefault.name,
      goReadNodeBatchDefault.body,
      2.5,
      3.5,
    )
    const goReadNodeBatchOverride = await api.request({
      name: 'queue control: go reads node batch fractional overrides',
      method: 'GET',
      path: `/api/queue/stats/${nodeBatchTaskIds[1]}`,
      expectedBackend: 'go',
    })
    expectQueueNumbers(
      goReadNodeBatchOverride.name,
      goReadNodeBatchOverride.body,
      7.5,
      1.5,
    )

    const goBatchPayloads = [
      {
        type: 'photo',
        storageKey: `${normalized.prefix}/fractional-go-batch-default.jpg`,
      },
      {
        type: 'photo-reverse-geocoding',
        photoId: `${normalized.prefix}-missing-go-photo`,
        latitude: 31.25,
        longitude: 121.5,
      },
    ]
    const goFractionalBatch = await api.request({
      name: 'queue control: go batch adds fractional queue numbers',
      method: 'POST',
      path: '/api/queue/add-tasks',
      expectedBackend: 'go',
      body: {
        tasks: [
          { payload: goBatchPayloads[0] },
          {
            payload: goBatchPayloads[1],
            priority: 6.5,
            maxAttempts: 2.5,
          },
        ],
        defaultPriority: 3.5,
        defaultMaxAttempts: 4.5,
      },
    })
    const goBatchTaskIds = expectQueueBatchAddResponse(
      goFractionalBatch.name,
      goFractionalBatch.body,
      goBatchPayloads,
    )
    for (const taskId of goBatchTaskIds) {
      state.queueTaskIds.add(taskId)
      summary.temporaryTaskIds.push(taskId)
    }

    await setProvider(api, 'node')
    const nodeReadGoBatchDefault = await api.request({
      name: 'queue control: node reads go batch fractional defaults',
      method: 'GET',
      path: `/api/queue/stats/${goBatchTaskIds[0]}`,
      expectedBackend: 'node',
    })
    expectQueueNumbers(
      nodeReadGoBatchDefault.name,
      nodeReadGoBatchDefault.body,
      3.5,
      4.5,
    )
    const nodeReadGoBatchOverride = await api.request({
      name: 'queue control: node reads go batch fractional overrides',
      method: 'GET',
      path: `/api/queue/stats/${goBatchTaskIds[1]}`,
      expectedBackend: 'node',
    })
    expectQueueNumbers(
      nodeReadGoBatchOverride.name,
      nodeReadGoBatchOverride.body,
      6.5,
      2.5,
    )

    const nodeRetryTask = createTemporaryQueueTask(
      normalized.databasePath,
      state,
      {
        prefix: normalized.prefix,
        purpose: 'single-node-retry',
        status: 'failed',
      },
    )
    summary.temporaryTaskIds.push(nodeRetryTask.id)
    const nodeRetry = await api.request({
      name: 'queue control: node retries failed task',
      method: 'POST',
      path: '/api/queue/task/retry',
      expectedBackend: 'node',
      body: { taskId: nodeRetryTask.id },
    })
    expectQueueRetryResponse(nodeRetry.name, nodeRetry.body, nodeRetryTask)

    await setProvider(api, 'go')
    const goReadAfterNodeRetry = await api.request({
      name: 'queue control: go reads node-retried task',
      method: 'GET',
      path: `/api/queue/stats/${nodeRetryTask.id}`,
      expectedBackend: 'go',
    })
    expectRetriedQueueStats(
      goReadAfterNodeRetry.name,
      goReadAfterNodeRetry.body,
      nodeRetryTask.id,
    )

    const goRetryTask = createTemporaryQueueTask(
      normalized.databasePath,
      state,
      {
        prefix: normalized.prefix,
        purpose: 'single-go-retry',
        status: 'failed',
      },
    )
    summary.temporaryTaskIds.push(goRetryTask.id)
    const goRetry = await api.request({
      name: 'queue control: go retries failed task',
      method: 'POST',
      path: '/api/queue/task/retry',
      expectedBackend: 'go',
      body: { taskId: goRetryTask.id },
    })
    expectQueueRetryResponse(goRetry.name, goRetry.body, goRetryTask)

    await setProvider(api, 'node')
    const nodeReadAfterGoRetry = await api.request({
      name: 'queue control: node reads go-retried task',
      method: 'GET',
      path: `/api/queue/stats/${goRetryTask.id}`,
      expectedBackend: 'node',
    })
    expectRetriedQueueStats(
      nodeReadAfterGoRetry.name,
      nodeReadAfterGoRetry.body,
      goRetryTask.id,
    )

    const batchFailedTask = createTemporaryQueueTask(
      normalized.databasePath,
      state,
      {
        prefix: normalized.prefix,
        purpose: 'batch-go-retry-failed',
        status: 'failed',
      },
    )
    summary.temporaryTaskIds.push(batchFailedTask.id)
    const batchCompletedTask = createTemporaryQueueTask(
      normalized.databasePath,
      state,
      {
        prefix: normalized.prefix,
        purpose: 'batch-go-retry-completed',
        status: 'completed',
      },
    )
    summary.temporaryTaskIds.push(batchCompletedTask.id)

    await setProvider(api, 'go')
    const goBatchRetry = await api.request({
      name: 'queue control: go batch retry keeps skipped task stable',
      method: 'POST',
      path: '/api/queue/task/retry-batch',
      expectedBackend: 'go',
      body: {
        taskIds: [batchFailedTask.id, batchCompletedTask.id],
        retryAll: false,
      },
    })
    expectQueueBatchRetryResponse(goBatchRetry.name, goBatchRetry.body, {
      retriedTask: batchFailedTask,
      skippedTask: batchCompletedTask,
    })

    await setProvider(api, 'node')
    const nodeReadAfterGoBatchRetry = await api.request({
      name: 'queue control: node reads go batch-retried task',
      method: 'GET',
      path: `/api/queue/stats/${batchFailedTask.id}`,
      expectedBackend: 'node',
    })
    expectRetriedQueueStats(
      nodeReadAfterGoBatchRetry.name,
      nodeReadAfterGoBatchRetry.body,
      batchFailedTask.id,
    )

    const nodeReadSkippedBatchTask = await api.request({
      name: 'queue control: node reads go batch-skipped task',
      method: 'GET',
      path: `/api/queue/stats/${batchCompletedTask.id}`,
      expectedBackend: 'node',
    })
    expectEqual(
      nodeReadSkippedBatchTask.name,
      nodeReadSkippedBatchTask.body?.status,
      'completed',
    )

    const nodeBatchNoFailed = await api.request({
      name: 'queue control: node batch retry reports no failed tasks',
      method: 'POST',
      path: '/api/queue/task/retry-batch',
      expectedBackend: 'node',
      body: {
        taskIds: [batchCompletedTask.id],
        retryAll: false,
      },
    })
    expectExactKeys(nodeBatchNoFailed.name, nodeBatchNoFailed.body, [
      'message',
      'retriedCount',
      'skippedCount',
      'success',
    ])
    expectEqual(nodeBatchNoFailed.name, nodeBatchNoFailed.body.success, true)
    expectEqual(
      nodeBatchNoFailed.name,
      nodeBatchNoFailed.body.message,
      'No failed tasks found to retry',
    )
    expectEqual(nodeBatchNoFailed.name, nodeBatchNoFailed.body.retriedCount, 0)
    expectEqual(nodeBatchNoFailed.name, nodeBatchNoFailed.body.skippedCount, 1)

    const invalidClearPath =
      '/api/queue/task/clear?includeCompleted=false&includeFailed=false'
    const nodeInvalidClear = await api.request({
      name: 'queue control: node rejects invalid clear filter',
      method: 'DELETE',
      path: invalidClearPath,
      expectedStatus: 400,
      expectedBackend: 'node',
    })
    expectQueueClearInvalidResponse(
      nodeInvalidClear.name,
      nodeInvalidClear.body,
    )

    await setProvider(api, 'go')
    const goInvalidClear = await api.request({
      name: 'queue control: go rejects invalid clear filter',
      method: 'DELETE',
      path: invalidClearPath,
      expectedStatus: 400,
      expectedBackend: 'go',
    })
    expectQueueClearInvalidResponse(goInvalidClear.name, goInvalidClear.body)

    const safeClearPath =
      '/api/queue/task/clear?includeCompleted=true&includeFailed=true&olderThanDays=200000'
    const goClearNoop = await api.request({
      name: 'queue control: go clear old tasks no-op is safe',
      method: 'DELETE',
      path: safeClearPath,
      expectedBackend: 'go',
    })
    expectQueueClearNoopResponse(goClearNoop.name, goClearNoop.body)

    await setProvider(api, 'node')
    const nodeClearNoop = await api.request({
      name: 'queue control: node clear old tasks no-op is safe',
      method: 'DELETE',
      path: safeClearPath,
      expectedBackend: 'node',
    })
    expectQueueClearNoopResponse(nodeClearNoop.name, nodeClearNoop.body)

    await verifyQueueClearDeletesTemporaryRows(
      api,
      normalized,
      state,
      summary,
      'go',
    )
    await verifyQueueClearDeletesTemporaryRows(
      api,
      normalized,
      state,
      summary,
      'node',
    )

    summary.ok = true
    return summary
  } finally {
    await cleanupQueueControlState(api, normalized.databasePath, state, summary)
  }
}

function normalizeOptions(options) {
  const rawDatabasePath =
    options.databasePath ?? process.env.CFRAME_DUAL_QUEUE_CONTROL_DB
  if (!rawDatabasePath) {
    throw new Error(
      'Queue-control verification requires --db <sqlite-path> or CFRAME_DUAL_QUEUE_CONTROL_DB',
    )
  }

  const timeoutMs = requirePositiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'timeoutMs',
  )
  const base = String(options.base ?? DEFAULT_BASE).replace(/\/+$/, '')
  return {
    base,
    cookie: options.cookie ?? DEFAULT_COOKIE,
    memberCookie: options.memberCookie ?? DEFAULT_MEMBER_COOKIE,
    nodeURL: String(options.nodeURL ?? base).replace(/\/+$/, ''),
    goURL: String(options.goURL ?? `${base}/__lab/go`).replace(/\/+$/, ''),
    databasePath: resolveSQLitePath(String(rawDatabasePath)),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    prefix: options.prefix ?? DEFAULT_PREFIX,
    readCases: options.readCases ?? QUEUE_CONTROL_READ_CASES,
    boundaryCases: options.boundaryCases ?? QUEUE_CONTROL_BOUNDARY_CASES,
    timeoutMs,
  }
}

async function verifyQueuePairCases(options, summary, cases, kind) {
  for (const testCase of cases) {
    await compareQueuePair(options, summary, { ...testCase, kind })
  }
}

async function compareQueuePair(options, summary, testCase) {
  const requestID = `dual-queue-control-${randomUUID()}`
  const [node, go] = await Promise.all([
    executePairRequest(options, testCase, options.nodeURL, 'node', requestID),
    executePairRequest(options, testCase, options.goURL, 'go', requestID),
  ])
  const differences = validateQueuePair(testCase, node, go)
  summary.checks.push({
    name: testCase.name,
    kind: testCase.kind,
    method: testCase.method,
    path: testCase.path,
    ok: differences.length === 0,
    node: compactPairResult(node),
    go: compactPairResult(go),
    differences,
  })
  if (differences.length > 0) {
    throw new QueueControlVerificationFailure(differences)
  }
}

async function executePairRequest(
  options,
  request,
  baseURL,
  expectedBackend,
  requestID,
) {
  const headers = {
    Accept: 'application/json',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'en',
    'User-Agent': `${options.prefix}/verifier`,
    'X-Forwarded-For': '198.51.100.71',
    'X-Request-Id': requestID,
  }
  const cookie = resolvePairCookie(options, request.cookie)
  if (cookie) headers.Cookie = cookie
  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs),
  }
  if (Object.hasOwn(request, 'body')) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(request.body)
  } else if (Object.hasOwn(request, 'rawBody')) {
    headers['Content-Type'] = 'application/json'
    init.body = request.rawBody
  }
  const response = await options.fetchImpl(
    joinBackendURL(baseURL, request.path),
    init,
  )
  const text = await response.text()
  return {
    expectedBackend,
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend'),
    contentType: normalizedContentType(response.headers.get('content-type')),
    requestID,
    responseRequestID: response.headers.get('x-request-id'),
    setCookie: response.headers.has('set-cookie'),
    body: parseJSON(text),
  }
}

export function validateQueuePair(testCase, node, go) {
  const differences = []
  for (const result of [node, go]) {
    const backend = result.expectedBackend
    if (result.status !== testCase.expectedStatus) {
      differences.push(
        pairDifference(
          testCase.name,
          `${backend}.status`,
          testCase.expectedStatus,
          result.status,
        ),
      )
    }
    if (result.backend !== backend) {
      differences.push(
        pairDifference(
          testCase.name,
          `${backend}.headers.x-chronoframe-backend`,
          backend,
          result.backend,
        ),
      )
    }
    if (result.contentType !== 'application/json') {
      differences.push(
        pairDifference(
          testCase.name,
          `${backend}.headers.content-type`,
          'application/json',
          result.contentType,
        ),
      )
    }
    if (result.responseRequestID !== result.requestID) {
      differences.push(
        pairDifference(
          testCase.name,
          `${backend}.headers.x-request-id`,
          result.requestID,
          result.responseRequestID,
        ),
      )
    }
    if (result.setCookie) {
      differences.push(
        pairDifference(
          testCase.name,
          `${backend}.headers.set-cookie`,
          'absent',
          'present',
        ),
      )
    }
  }

  const nodeBody = comparablePairBody(node.body, testCase.normalizers)
  const goBody = comparablePairBody(go.body, testCase.normalizers)
  if (JSON.stringify(nodeBody) !== JSON.stringify(goBody)) {
    differences.push({
      name: testCase.name,
      field: 'body',
      node: nodeBody,
      go: goBody,
    })
  }
  return differences
}

function comparablePairBody(body, normalizers = []) {
  const value = structuredClone(body)
  if (value && typeof value === 'object') {
    delete value.url
    delete value.stack
  }
  for (const pointer of normalizers) {
    removeJSONPointer(value, pointer)
  }
  return canonicalize(value)
}

function removeJSONPointer(value, pointer) {
  const segments = pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
  removeJSONPointerSegments(value, segments)
}

function removeJSONPointerSegments(value, segments) {
  if (!value || typeof value !== 'object' || segments.length === 0) return
  const [segment, ...rest] = segments
  if (segment === '*') {
    if (Array.isArray(value)) {
      for (const item of value) removeJSONPointerSegments(item, rest)
    }
    return
  }
  if (rest.length === 0) {
    delete value[segment]
    return
  }
  if (Object.hasOwn(value, segment))
    removeJSONPointerSegments(value[segment], rest)
}

function resolvePairCookie(options, kind) {
  switch (kind) {
    case undefined:
    case 'admin':
      return options.cookie
    case 'member':
      return options.memberCookie
    case 'anonymous':
      return undefined
    default:
      throw new Error(`Unknown queue-control cookie kind: ${kind}`)
  }
}

function compactPairResult(result) {
  return {
    status: result.status,
    backend: result.backend,
    contentType: result.contentType,
  }
}

function pairDifference(name, field, expected, actual) {
  return { name, field, expected, actual }
}

function normalizedContentType(value) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || ''
}

function parseJSON(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { parseError: true, raw: text.slice(0, 500) }
  }
}

function createQueueControlAPI(options, summary) {
  if (typeof options.fetchImpl !== 'function') {
    throw new Error('fetch implementation is required')
  }

  return {
    async request({
      name,
      method,
      path,
      body,
      expectedStatus = 200,
      expectedBackend,
    }) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
      const startedAt = Date.now()
      const requestID = `dual-queue-control-${randomUUID()}`
      try {
        const response = await options.fetchImpl(`${options.base}${path}`, {
          method,
          headers: {
            Accept: 'application/json',
            Cookie: options.cookie,
            'X-Request-Id': requestID,
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        })
        const contentType = response.headers.get('content-type') ?? ''
        const text = await response.text()
        let value = null
        if (text.length > 0) {
          try {
            value = JSON.parse(text)
          } catch (error) {
            throw new Error(
              `${name}: expected JSON response, failed to parse body: ${error.message}`,
            )
          }
        }
        const backendHeader =
          response.headers.get('x-chronoframe-backend') ?? ''
        const result = {
          name,
          method,
          path,
          status: response.status,
          backend: backendHeader,
          contentType: normalizedContentType(contentType),
          requestID,
          responseRequestID: response.headers.get('x-request-id'),
          setCookie: response.headers.has('set-cookie'),
          durationMs: Date.now() - startedAt,
          body: value,
        }
        summary.checks.push(result)
        validateHTTPResult(result, {
          expectedStatus,
          expectedBackend,
          contentType,
        })
        return result
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

async function setProvider(api, provider) {
  const result = await api.request({
    name: `switch read provider to ${provider}`,
    method: 'PUT',
    path: '/api/system/settings/system/backend.readProvider',
    expectedBackend: 'node',
    body: { value: provider },
  })
  if (result.body?.value !== provider) {
    throw new Error(
      `switch read provider to ${provider}: expected response value ${provider}, got ${result.body?.value}`,
    )
  }
}

async function verifyQueueClearDeletesTemporaryRows(
  api,
  options,
  state,
  summary,
  provider,
) {
  const olderThanDays = chooseIsolatedQueueClearAge(options.databasePath)
  const oldCreatedAt =
    Math.floor(Date.now() / 1000) - (olderThanDays + 2) * 24 * 60 * 60
  const completedTask = createTemporaryQueueTask(options.databasePath, state, {
    prefix: options.prefix,
    purpose: `clear-${provider}-completed`,
    status: 'completed',
    createdAt: oldCreatedAt,
  })
  const failedTask = createTemporaryQueueTask(options.databasePath, state, {
    prefix: options.prefix,
    purpose: `clear-${provider}-failed`,
    status: 'failed',
    createdAt: oldCreatedAt,
  })
  const clearTaskIds = [completedTask.id, failedTask.id]
  summary.temporaryTaskIds.push(...clearTaskIds)

  assertClearWouldOnlyDeleteTemporaryRows(
    options.databasePath,
    clearTaskIds,
    olderThanDays,
  )

  await setProvider(api, provider)
  const clear = await api.request({
    name: `queue control: ${provider} clear deletes only verifier rows`,
    method: 'DELETE',
    path: `/api/queue/task/clear?includeCompleted=true&includeFailed=true&olderThanDays=${olderThanDays}`,
    expectedBackend: provider,
  })
  expectQueueClearDeleteResponse(clear.name, clear.body, {
    completed: 1,
    failed: 1,
    olderThanDays,
  })

  const remaining = readQueueTaskIds(options.databasePath, clearTaskIds)
  if (remaining.length > 0) {
    throw new Error(
      `${clear.name}: expected clear to delete ${clearTaskIds.join(', ')}, remaining ${remaining.join(', ')}`,
    )
  }
}

function chooseIsolatedQueueClearAge(databasePath) {
  const now = Math.floor(Date.now() / 1000)
  const db = openQueueDatabase(databasePath)
  try {
    const row = db
      .prepare(`
			SELECT MIN(created_at) AS oldestCreatedAt
			FROM pipeline_queue
			WHERE status IN ('completed', 'failed')
		`)
      .get()
    if (row?.oldestCreatedAt === null || row?.oldestCreatedAt === undefined) {
      return 1
    }
    const ageSeconds = Math.max(0, now - Number(row.oldestCreatedAt))
    return Math.max(1, Math.floor(ageSeconds / (24 * 60 * 60)) + 1)
  } finally {
    db.close()
  }
}

function createTemporaryQueueTask(
  databasePath,
  state,
  { prefix, purpose, status, createdAt },
) {
  const db = openQueueDatabase(databasePath)
  try {
    const id = nextTemporaryQueueTaskId(db, state)
    const now = createdAt ?? Math.floor(Date.now() / 1000)
    const payload = {
      type: 'photo',
      storageKey: `${prefix}/${purpose}-${id}.jpg`,
    }
    const statusStage = status === 'failed' ? 'process' : 'done'
    const errorMessage =
      status === 'failed' ? `temporary ${purpose} failure` : null
    const completedAt = status === 'completed' ? now : null
    db.prepare(`
      INSERT INTO pipeline_queue (
        id,
        payload,
        priority,
        attempts,
        max_attempts,
        status,
        status_stage,
        error_message,
        created_at,
        available_at,
        claimed_by,
        claim_token,
        claim_expires_at,
        completed_at,
        owner_user_id
      )
      VALUES (?, ?, 0, 2, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      JSON.stringify(payload),
      status,
      statusStage,
      errorMessage,
      now,
      now,
      status === 'failed' ? 'dual-queue-control-verifier' : null,
      status === 'failed' ? `stale-${id}` : null,
      status === 'failed' ? now - 60 : null,
      completedAt,
      DUAL_BACKEND_COMPARE_FIXTURE.userId,
    )
    state.queueTaskIds.add(id)
    return { id, payload, status }
  } finally {
    db.close()
  }
}

function assertClearWouldOnlyDeleteTemporaryRows(
  databasePath,
  temporaryIds,
  olderThanDays,
) {
  const eligibleIds = readQueueClearEligibleTaskIds(databasePath, olderThanDays)
  const temporaryIdSet = new Set(temporaryIds)
  const unexpectedIds = eligibleIds.filter((id) => !temporaryIdSet.has(id))
  if (unexpectedIds.length > 0) {
    throw new Error(
      `Refusing queue clear verifier because olderThanDays=${olderThanDays} would also delete non-temporary task ids: ${unexpectedIds.join(', ')}`,
    )
  }
  const missingIds = temporaryIds.filter((id) => !eligibleIds.includes(id))
  if (missingIds.length > 0) {
    throw new Error(
      `Refusing queue clear verifier because temporary task ids are not eligible for clear: ${missingIds.join(', ')}`,
    )
  }
}

function readQueueClearEligibleTaskIds(databasePath, olderThanDays) {
  const thresholdUnix =
    Math.floor(Date.now() / 1000) - olderThanDays * 24 * 60 * 60
  const db = openQueueDatabase(databasePath)
  try {
    return db
      .prepare(`
        SELECT id
        FROM pipeline_queue
        WHERE status IN ('completed', 'failed')
          AND created_at < ?
        ORDER BY id
      `)
      .all(thresholdUnix)
      .map((row) => Number(row.id))
  } finally {
    db.close()
  }
}

function readQueueTaskIds(databasePath, ids) {
  const safeIds = ids
    .map((id) => Number(id))
    .filter((id) => Number.isSafeInteger(id))
  if (safeIds.length === 0) {
    return []
  }
  const db = openQueueDatabase(databasePath)
  try {
    const placeholders = safeIds.map(() => '?').join(', ')
    return db
      .prepare(
        `SELECT id FROM pipeline_queue WHERE id IN (${placeholders}) ORDER BY id`,
      )
      .all(...safeIds)
      .map((row) => Number(row.id))
  } finally {
    db.close()
  }
}

function openQueueDatabase(databasePath) {
  const db = new Database(databasePath, { fileMustExist: true })
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  return db
}

function nextTemporaryQueueTaskId(db, state) {
  const base = 970_000_000
  if (state.nextQueueTaskId === null) {
    const row = db
      .prepare(
        'SELECT COALESCE(MAX(id), ? - 1) + 1 AS id FROM pipeline_queue WHERE id >= ?',
      )
      .get(base, base)
    state.nextQueueTaskId = Number(row?.id)
  }
  const id = state.nextQueueTaskId
  if (!Number.isSafeInteger(id) || id < base) {
    throw new Error(
      `Unable to allocate temporary queue task id ${JSON.stringify(id)}`,
    )
  }
  state.nextQueueTaskId += 1
  return id
}

async function cleanupQueueControlState(api, databasePath, state, summary) {
  await cleanup(summary, 'restore read provider to node', () =>
    setProvider(api, 'node'),
  )

  const ids = [...state.queueTaskIds]
  if (ids.length === 0) {
    return
  }
  await cleanup(
    summary,
    `delete ${ids.length} temporary queue task rows`,
    () => {
      deleteTemporaryQueueTasks(databasePath, ids)
    },
  )
}

function deleteTemporaryQueueTasks(databasePath, ids) {
  const safeIds = ids
    .map((id) => Number(id))
    .filter((id) => Number.isSafeInteger(id) && id >= 970_000_000)
  if (safeIds.length === 0) {
    return
  }

  const db = openQueueDatabase(databasePath)
  try {
    const placeholders = safeIds.map(() => '?').join(', ')
    db.prepare(`DELETE FROM pipeline_queue WHERE id IN (${placeholders})`).run(
      ...safeIds,
    )
  } finally {
    db.close()
  }
}

async function cleanup(summary, name, action) {
  try {
    await action()
    summary.cleanup.push({ name, ok: true })
  } catch (error) {
    summary.cleanup.push({ name, ok: false, error: error.message })
  }
}

function validateHTTPResult(
  result,
  { expectedStatus, expectedBackend, contentType },
) {
  if (result.status !== expectedStatus) {
    throw new Error(
      `${result.name}: expected HTTP ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.body)}`,
    )
  }
  if (!contentType.includes('application/json')) {
    throw new Error(
      `${result.name}: expected application/json response, got ${contentType}`,
    )
  }
  if (expectedBackend && result.backend !== expectedBackend) {
    throw new Error(
      `${result.name}: expected backend ${expectedBackend}, got ${result.backend}`,
    )
  }
  if (result.responseRequestID !== result.requestID) {
    throw new Error(
      `${result.name}: expected x-request-id ${result.requestID}, got ${result.responseRequestID}`,
    )
  }
  if (result.setCookie) {
    throw new Error(`${result.name}: expected no set-cookie response header`)
  }
}

function expectQueueRetryResponse(name, body, task) {
  expectExactKeys(name, body, ['message', 'payload', 'success', 'taskId'])
  expectEqual(name, body.success, true)
  expectEqual(
    name,
    body.message,
    `Task ${task.id} has been reset and will be retried`,
  )
  expectEqual(name, body.taskId, task.id)
  expectDeepEqual(name, body.payload, task.payload)
}

function expectQueueAddResponse(name, body, payload) {
  expectExactKeys(name, body, ['message', 'payload', 'success', 'taskId'])
  expectEqual(name, body.success, true)
  expectEqual(name, body.message, 'Task added to queue successfully')
  expectDeepEqual(name, body.payload, payload)
  if (!Number.isSafeInteger(body.taskId) || body.taskId <= 0) {
    throw new Error(
      `${name}: expected a positive safe taskId, got ${JSON.stringify(body.taskId)}`,
    )
  }
  return body.taskId
}

function expectQueueBatchAddResponse(name, body, payloads) {
  expectExactKeys(name, body, [
    'errorCount',
    'message',
    'results',
    'success',
    'successCount',
    'totalTasks',
  ])
  expectEqual(name, body.success, true)
  expectEqual(name, body.totalTasks, payloads.length)
  expectEqual(name, body.successCount, payloads.length)
  expectEqual(name, body.errorCount, 0)
  expectEqual(
    name,
    body.message,
    `Processed ${payloads.length} tasks: ${payloads.length} successful, 0 failed`,
  )
  if (!Array.isArray(body.results) || body.results.length !== payloads.length) {
    throw new Error(
      `${name}: expected ${payloads.length} results, got ${JSON.stringify(body.results)}`,
    )
  }
  return body.results.map((result, index) => {
    expectExactKeys(`${name} result ${index}`, result, [
      'index',
      'payload',
      'success',
      'taskId',
    ])
    expectEqual(`${name} result ${index}`, result.index, index)
    expectEqual(`${name} result ${index}`, result.success, true)
    expectDeepEqual(`${name} result ${index}`, result.payload, payloads[index])
    if (!Number.isSafeInteger(result.taskId) || result.taskId <= 0) {
      throw new Error(
        `${name} result ${index}: expected a positive safe taskId, got ${JSON.stringify(result.taskId)}`,
      )
    }
    return result.taskId
  })
}

function expectQueueNumbers(name, body, priority, maxAttempts) {
  expectEqual(name, body?.priority, priority)
  expectEqual(name, body?.maxAttempts, maxAttempts)
}

function expectQueueBatchRetryResponse(
  name,
  body,
  { retriedTask, skippedTask },
) {
  expectExactKeys(name, body, [
    'message',
    'retriedCount',
    'retriedTasks',
    'skippedCount',
    'skippedTasks',
    'success',
  ])
  expectEqual(name, body.success, true)
  expectEqual(name, body.message, 'Successfully reset 1 failed tasks for retry')
  expectEqual(name, body.retriedCount, 1)
  expectEqual(name, body.skippedCount, 1)

  const retried = findById(body.retriedTasks, retriedTask.id)
  expectDeepEqual(name, retried, {
    id: retriedTask.id,
    type: retriedTask.payload.type,
    storageKey: retriedTask.payload.storageKey,
  })

  const skipped = findById(body.skippedTasks, skippedTask.id)
  expectDeepEqual(name, skipped, {
    id: skippedTask.id,
    status: skippedTask.status,
    reason: `Task is not in failed status (current: ${skippedTask.status})`,
  })
}

function expectRetriedQueueStats(name, body, taskId) {
  expectEqual(name, body?.id, taskId)
  expectEqual(name, body?.status, 'pending')
  expectEqual(name, body?.attempts, 0)
  expectEqual(name, body?.errorMessage, null)
  expectEqual(name, body?.claimedBy, null)
  expectEqual(name, body?.claimToken, null)
}

function expectQueueClearInvalidResponse(name, body) {
  expectEqual(name, body?.statusCode, 400)
  expectEqual(
    name,
    body?.statusMessage,
    'At least one of includeCompleted or includeFailed must be true',
  )
  expectEqual(
    name,
    body?.message,
    'At least one of includeCompleted or includeFailed must be true',
  )
}

function expectQueueClearNoopResponse(name, body) {
  expectExactKeys(name, body, [
    'breakdown',
    'deletedCount',
    'message',
    'success',
  ])
  expectEqual(name, body.success, true)
  expectEqual(name, body.message, 'No tasks found to clear')
  expectEqual(name, body.deletedCount, 0)
  expectDeepEqual(name, body.breakdown, { completed: 0, failed: 0 })
}

function expectQueueClearDeleteResponse(
  name,
  body,
  { completed, failed, olderThanDays },
) {
  expectExactKeys(name, body, [
    'breakdown',
    'deletedCount',
    'filter',
    'message',
    'success',
  ])
  const deletedCount = completed + failed
  expectEqual(name, body.success, true)
  expectEqual(
    name,
    body.message,
    `Successfully cleared ${deletedCount} non-active tasks`,
  )
  expectEqual(name, body.deletedCount, deletedCount)
  expectDeepEqual(name, body.breakdown, { completed, failed })
  expectExactKeys(name, body.filter, ['olderThanDays', 'thresholdDate'])
  expectEqual(name, body.filter.olderThanDays, olderThanDays)
  if (
    typeof body.filter.thresholdDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      body.filter.thresholdDate,
    )
  ) {
    throw new Error(
      `${name}: expected filter.thresholdDate to be an ISO millisecond timestamp, got ${JSON.stringify(body.filter.thresholdDate)}`,
    )
  }
}

function expectEqual(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

function expectDeepEqual(name, actual, expected) {
  const actualJSON = stableStringify(actual)
  const expectedJSON = stableStringify(expected)
  if (actualJSON !== expectedJSON) {
    throw new Error(`${name}: expected ${expectedJSON}, got ${actualJSON}`)
  }
}

function expectExactKeys(name, value, expectedKeys) {
  const actualKeys = Object.keys(value ?? {}).sort()
  const sortedExpected = [...expectedKeys].sort()
  if (stableStringify(actualKeys) !== stableStringify(sortedExpected)) {
    throw new Error(
      `${name}: expected keys ${sortedExpected.join(', ')}, got ${actualKeys.join(', ')}`,
    )
  }
}

function findById(values, id) {
  if (!Array.isArray(values)) {
    throw new Error(
      `Expected array while looking for id ${id}, got ${JSON.stringify(values)}`,
    )
  }
  const value = values.find((item) => item?.id === id)
  if (!value) {
    throw new Error(`Expected to find id ${id} in ${JSON.stringify(values)}`)
  }
  return value
}

function stableStringify(value) {
  return JSON.stringify(sortJSON(value))
}

function sortJSON(value) {
  if (Array.isArray(value)) {
    return value.map(sortJSON)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJSON(value[key])]),
    )
  }
  return value
}

function requirePositiveInteger(value, name) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return number
}

class QueueControlVerificationFailure extends Error {
  constructor(differences) {
    super(
      `${differences[0]?.name || 'queue control comparison'}: ${JSON.stringify(differences)}`,
    )
    this.name = 'QueueControlVerificationFailure'
    this.differences = differences
  }
}

export function parseQueueControlVerifierOptions(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument ${arg}`)
    }
    const [name, inlineValue] = arg.split('=', 2)
    if (
      !['--base', '--cookie', '--db', '--prefix', '--timeout-ms'].includes(name)
    ) {
      throw new Error(`Unknown argument ${name}`)
    }
    if (inlineValue !== undefined) {
      values.set(name, inlineValue)
      continue
    }
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for ${name}`)
    }
    values.set(name, next)
    index += 1
  }

  const rawDatabasePath = values.get('--db') ?? env.CFRAME_DUAL_QUEUE_CONTROL_DB
  if (!rawDatabasePath) {
    throw new Error(
      'Queue-control verification requires --db <sqlite-path> or CFRAME_DUAL_QUEUE_CONTROL_DB',
    )
  }

  return {
    base: values.get('--base') ?? env.CFRAME_DUAL_BASE ?? DEFAULT_BASE,
    cookie: values.get('--cookie') ?? env.CFRAME_DUAL_COOKIE ?? DEFAULT_COOKIE,
    databasePath: resolveSQLitePath(rawDatabasePath),
    prefix:
      values.get('--prefix') ?? env.CFRAME_DUAL_QUEUE_PREFIX ?? DEFAULT_PREFIX,
    timeoutMs: requirePositiveInteger(
      values.get('--timeout-ms') ??
        env.CFRAME_DUAL_TIMEOUT_MS ??
        DEFAULT_TIMEOUT_MS,
      'timeoutMs',
    ),
  }
}

async function main() {
  const options = parseQueueControlVerifierOptions()
  const summary = await verifyDualQueueControl(options)
  console.log(JSON.stringify(summary, null, 2))
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
