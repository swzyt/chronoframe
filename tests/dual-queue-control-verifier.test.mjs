import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import Database from 'better-sqlite3'

import {
  QUEUE_CONTROL_BOUNDARY_CASES,
  QUEUE_CONTROL_READ_CASES,
  QUEUE_CONTROL_ROUTE_IDS,
  parseQueueControlVerifierOptions,
  validateQueuePair,
  verifyDualQueueControl,
} from '../scripts/verify-dual-queue-control.mjs'

function jsonResponse(
  body,
  backend,
  status = 200,
  requestID = 'response-request-1',
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-chronoframe-backend': backend,
      'x-request-id': requestID,
    },
  })
}

function createQueueControlDatabase() {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'chronoframe-queue-control-'),
  )
  const databasePath = path.join(directory, 'app.sqlite3')
  const db = new Database(databasePath)
  db.exec(`
    CREATE TABLE pipeline_queue (
      id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL,
      status_stage TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      available_at INTEGER,
      claimed_by TEXT,
      claim_token TEXT,
      claim_expires_at INTEGER,
      completed_at INTEGER,
      owner_user_id INTEGER
    );
  `)
  db.close()
  return {
    databasePath,
    cleanup() {
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

function createQueueControlGateway(
  databasePath,
  { breakGoBatchShape = false } = {},
) {
  const state = {
    provider: 'node',
    requests: [],
  }

  const withDB = (callback) => {
    const db = new Database(databasePath)
    try {
      return callback(db)
    } finally {
      db.close()
    }
  }

  const fetchImpl = async (url, options) => {
    const urlObject = new URL(url)
    const pathname = urlObject.pathname
    const contentType = options.headers['Content-Type'] || ''
    const request = {
      method: options.method,
      body:
        options.body && contentType.startsWith('application/json')
          ? JSON.parse(options.body)
          : undefined,
      url: String(url),
    }
    state.requests.push(request)
    const respond = (body, backend, status = 200) =>
      jsonResponse(body, backend, status, options.headers['X-Request-Id'])

    if (
      pathname === '/api/system/settings/system/backend.readProvider' &&
      request.method === 'PUT'
    ) {
      state.provider = request.body.value
      return respond(
        {
          namespace: 'system',
          key: 'backend.readProvider',
          value: state.provider,
        },
        'node',
      )
    }

    const backend = state.provider

    if (pathname === '/api/queue/add-task' && request.method === 'POST') {
      const taskId = withDB((db) => {
        const row = db
          .prepare(
            'SELECT COALESCE(MAX(id), 969999999) + 1 AS id FROM pipeline_queue',
          )
          .get()
        const id = Number(row.id)
        db.prepare(`
          INSERT INTO pipeline_queue (
            id, payload, priority, attempts, max_attempts, status,
            created_at, available_at, owner_user_id
          )
          VALUES (?, ?, ?, 0, ?, 'pending', ?, ?, ?)
        `).run(
          id,
          JSON.stringify(request.body.payload),
          request.body.priority ?? 0,
          request.body.maxAttempts ?? 3,
          Math.floor(Date.now() / 1000),
          Math.floor(Date.now() / 1000),
          910001,
        )
        return id
      })
      return respond(
        {
          success: true,
          taskId,
          message: 'Task added to queue successfully',
          payload: request.body.payload,
        },
        backend,
      )
    }

    if (pathname === '/api/queue/add-tasks' && request.method === 'POST') {
      const now = Math.floor(Date.now() / 1000)
      const results = withDB((db) => {
        const nextRow = db
          .prepare(
            'SELECT COALESCE(MAX(id), 969999999) + 1 AS id FROM pipeline_queue',
          )
          .get()
        let nextId = Number(nextRow.id)
        const insert = db.prepare(`
          INSERT INTO pipeline_queue (
            id, payload, priority, attempts, max_attempts, status,
            created_at, available_at, owner_user_id
          )
          VALUES (?, ?, ?, 0, ?, 'pending', ?, ?, ?)
        `)
        return request.body.tasks.map((task, index) => {
          const taskId = nextId
          nextId += 1
          insert.run(
            taskId,
            JSON.stringify(task.payload),
            task.priority ?? request.body.defaultPriority ?? 0,
            task.maxAttempts ?? request.body.defaultMaxAttempts ?? 3,
            now,
            now,
            910001,
          )
          return {
            index,
            taskId,
            payload: task.payload,
            success: true,
          }
        })
      })
      return respond(
        {
          success: true,
          totalTasks: results.length,
          successCount: results.length,
          errorCount: 0,
          results,
          message: `Processed ${results.length} tasks: ${results.length} successful, 0 failed`,
        },
        backend,
      )
    }

    const statsMatch = /^\/api\/queue\/stats\/(\d+)$/.exec(pathname)
    if (statsMatch && request.method === 'GET') {
      const task = withDB((db) =>
        db
          .prepare('SELECT * FROM pipeline_queue WHERE id = ?')
          .get(Number(statsMatch[1])),
      )
      if (!task) {
        return respond({ statusMessage: 'Task not found' }, backend, 404)
      }
      return respond(rowToQueueTask(task), backend)
    }

    if (pathname === '/api/queue/task/retry' && request.method === 'POST') {
      const taskId = Number(request.body.taskId)
      const task = withDB((db) =>
        db.prepare('SELECT * FROM pipeline_queue WHERE id = ?').get(taskId),
      )
      if (!task) {
        return respond({ statusMessage: 'Task not found' }, backend, 404)
      }
      if (task.status !== 'failed') {
        return respond(
          {
            statusCode: 400,
            statusMessage: `Task is not in failed status, current status: ${task.status}`,
            message: `Task is not in failed status, current status: ${task.status}`,
          },
          backend,
          400,
        )
      }
      withDB((db) =>
        db
          .prepare(`
          UPDATE pipeline_queue
          SET status = 'pending',
              status_stage = NULL,
              error_message = NULL,
              attempts = 0,
              available_at = ?,
              claimed_by = NULL,
              claim_token = NULL,
              claim_expires_at = NULL
          WHERE id = ?
        `)
          .run(Math.floor(Date.now() / 1000), taskId),
      )
      const payload = JSON.parse(task.payload)
      return respond(
        {
          success: true,
          message: `Task ${taskId} has been reset and will be retried`,
          taskId,
          payload: {
            type: payload.type,
            storageKey: payload.storageKey,
          },
        },
        backend,
      )
    }

    if (
      pathname === '/api/queue/task/retry-batch' &&
      request.method === 'POST'
    ) {
      const ids = Array.isArray(request.body.taskIds)
        ? request.body.taskIds.map((id) => Number(id))
        : []
      const tasks = withDB((db) => {
        const statement = db.prepare(
          'SELECT * FROM pipeline_queue WHERE id = ?',
        )
        return ids.map((id) => statement.get(id)).filter(Boolean)
      })
      const failedTasks = tasks.filter((task) => task.status === 'failed')
      if (failedTasks.length === 0) {
        return respond(
          {
            success: true,
            message: 'No failed tasks found to retry',
            retriedCount: 0,
            skippedCount: ids.length,
          },
          backend,
        )
      }

      withDB((db) => {
        const statement = db.prepare(`
          UPDATE pipeline_queue
          SET status = 'pending',
              status_stage = NULL,
              error_message = NULL,
              attempts = 0,
              available_at = ?,
              claimed_by = NULL,
              claim_token = NULL,
              claim_expires_at = NULL
          WHERE id = ?
        `)
        for (const task of failedTasks) {
          statement.run(Math.floor(Date.now() / 1000), task.id)
        }
      })

      const responseBody = {
        success: true,
        message: `Successfully reset ${failedTasks.length} failed tasks for retry`,
        retriedCount: failedTasks.length,
        skippedCount: tasks.length - failedTasks.length,
        retriedTasks: failedTasks.map((task) => {
          const payload = JSON.parse(task.payload)
          return {
            id: task.id,
            type: payload.type,
            storageKey: payload.storageKey,
          }
        }),
        skippedTasks: tasks
          .filter((task) => task.status !== 'failed')
          .map((task) => ({
            id: task.id,
            status: task.status,
            reason: `Task is not in failed status (current: ${task.status})`,
          })),
      }
      if (breakGoBatchShape && backend === 'go') {
        delete responseBody.skippedTasks
      }
      return respond(responseBody, backend)
    }

    if (pathname === '/api/queue/task/clear' && request.method === 'DELETE') {
      const includeCompleted =
        urlObject.searchParams.get('includeCompleted') !== 'false'
      const includeFailed =
        urlObject.searchParams.get('includeFailed') !== 'false'
      if (!includeCompleted && !includeFailed) {
        return respond(
          {
            statusCode: 400,
            statusMessage:
              'At least one of includeCompleted or includeFailed must be true',
            message:
              'At least one of includeCompleted or includeFailed must be true',
          },
          backend,
          400,
        )
      }
      const statuses = []
      if (includeCompleted) statuses.push('completed')
      if (includeFailed) statuses.push('failed')
      const olderThanDays = urlObject.searchParams.get('olderThanDays')
      const args = [...statuses]
      let where = `status IN (${statuses.map(() => '?').join(', ')})`
      let thresholdTimestamp = null
      let thresholdDate = null
      if (olderThanDays) {
        const parsedDays = Number.parseInt(olderThanDays, 10)
        thresholdTimestamp = Math.floor(
          (Date.now() - parsedDays * 24 * 60 * 60 * 1000) / 1000,
        )
        thresholdDate = new Date(
          Date.now() - parsedDays * 24 * 60 * 60 * 1000,
        ).toISOString()
        where = `(${where}) AND created_at < ?`
        args.push(thresholdTimestamp)
      }
      const tasksToDelete = withDB((db) =>
        db
          .prepare(
            `SELECT id, status FROM pipeline_queue WHERE ${where} ORDER BY id`,
          )
          .all(...args),
      )
      if (tasksToDelete.length === 0) {
        return respond(
          {
            success: true,
            message: 'No tasks found to clear',
            deletedCount: 0,
            breakdown: {
              completed: 0,
              failed: 0,
            },
          },
          backend,
        )
      }
      withDB((db) =>
        db.prepare(`DELETE FROM pipeline_queue WHERE ${where}`).run(...args),
      )
      const breakdown = tasksToDelete.reduce(
        (counts, task) => ({
          ...counts,
          [task.status]: (counts[task.status] ?? 0) + 1,
        }),
        { completed: 0, failed: 0 },
      )
      return respond(
        {
          success: true,
          message: `Successfully cleared ${tasksToDelete.length} non-active tasks`,
          deletedCount: tasksToDelete.length,
          breakdown,
          ...(olderThanDays && {
            filter: {
              olderThanDays: Number.parseInt(olderThanDays, 10),
              thresholdDate,
            },
          }),
        },
        backend,
      )
    }

    return respond(
      { statusMessage: `Unhandled ${request.method} ${pathname}` },
      backend,
      404,
    )
  }

  return { fetchImpl, state }
}

function rowToQueueTask(row) {
  return {
    id: row.id,
    payload: JSON.parse(row.payload),
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    status: row.status,
    statusStage: row.status_stage,
    errorMessage: row.error_message,
    claimedBy: row.claimed_by,
    claimToken: row.claim_token,
  }
}

test('verifyDualQueueControl retries queue tasks through both backends and cleans temporary rows', async () => {
  const fixture = createQueueControlDatabase()
  try {
    const existing = new Database(fixture.databasePath)
    try {
      existing
        .prepare(`
        INSERT INTO pipeline_queue (
          id, payload, priority, attempts, max_attempts, status,
          created_at, available_at, owner_user_id
        )
        VALUES (42, ?, 0, 0, 3, 'completed', ?, ?, 910001)
      `)
        .run(
          JSON.stringify({ type: 'photo', storageKey: 'preexisting/keep.jpg' }),
          Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
          Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
        )
    } finally {
      existing.close()
    }
    const gateway = createQueueControlGateway(fixture.databasePath)

    const summary = await verifyDualQueueControl({
      base: 'http://dual.test',
      databasePath: fixture.databasePath,
      fetchImpl: gateway.fetchImpl,
      prefix: 'unit-queue',
      readCases: [],
      boundaryCases: [],
    })

    assert.equal(summary.ok, true)
    assert.equal(gateway.state.provider, 'node')
    assert.equal(summary.temporaryTaskIds.length, 14)
    assert.ok(
      summary.checks.some(
        (check) =>
          check.name ===
          'queue control: go reads node fractional queue numbers',
      ),
    )
    assert.ok(
      summary.checks.some(
        (check) =>
          check.name ===
          'queue control: node reads go fractional queue numbers',
      ),
    )
    assert.ok(
      summary.checks.some(
        (check) =>
          check.name ===
          'queue control: go reads node batch fractional overrides',
      ),
    )
    assert.ok(
      summary.checks.some(
        (check) =>
          check.name ===
          'queue control: node reads go batch fractional overrides',
      ),
    )
    assert.ok(
      summary.checks.some(
        (check) =>
          check.name ===
          'queue control: go batch retry keeps skipped task stable',
      ),
    )
    assert.ok(
      summary.checks.some(
        (check) =>
          check.name === 'queue control: node clear old tasks no-op is safe',
      ),
    )
    assert.ok(
      summary.checks.some(
        (check) =>
          check.name === 'queue control: go clear deletes only verifier rows',
      ),
    )
    assert.ok(
      summary.checks.some(
        (check) =>
          check.name === 'queue control: node clear deletes only verifier rows',
      ),
    )
    assert.deepEqual(
      summary.cleanup.map((item) => [item.name, item.ok]),
      [
        ['restore read provider to node', true],
        ['delete 14 temporary queue task rows', true],
      ],
    )

    const db = new Database(fixture.databasePath)
    try {
      const row = db
        .prepare(
          'SELECT COUNT(*) AS count FROM pipeline_queue WHERE id >= 970000000',
        )
        .get()
      assert.equal(row.count, 0)
      const preserved = db
        .prepare('SELECT payload FROM pipeline_queue WHERE id = 42')
        .get()
      assert.deepEqual(JSON.parse(preserved.payload), {
        type: 'photo',
        storageKey: 'preexisting/keep.jpg',
      })
    } finally {
      db.close()
    }
  } finally {
    fixture.cleanup()
  }
})

test('verifyDualQueueControl fails when Go batch retry response diverges', async () => {
  const fixture = createQueueControlDatabase()
  try {
    const gateway = createQueueControlGateway(fixture.databasePath, {
      breakGoBatchShape: true,
    })

    await assert.rejects(
      () =>
        verifyDualQueueControl({
          base: 'http://dual.test',
          databasePath: fixture.databasePath,
          fetchImpl: gateway.fetchImpl,
          prefix: 'unit-queue',
          readCases: [],
          boundaryCases: [],
        }),
      /queue control: go batch retry keeps skipped task stable: expected keys/,
    )

    const db = new Database(fixture.databasePath)
    try {
      const row = db
        .prepare(
          'SELECT COUNT(*) AS count FROM pipeline_queue WHERE id >= 970000000',
        )
        .get()
      assert.equal(row.count, 0)
    } finally {
      db.close()
    }
  } finally {
    fixture.cleanup()
  }
})

test('parseQueueControlVerifierOptions requires an explicit SQLite path', () => {
  assert.throws(
    () => parseQueueControlVerifierOptions([], {}),
    /requires --db <sqlite-path>/,
  )
})

test('parseQueueControlVerifierOptions accepts CLI values', () => {
  const options = parseQueueControlVerifierOptions(
    [
      '--base',
      'http://dual.local',
      '--cookie',
      'cf_session=test',
      '--db',
      './data/test.sqlite3',
      '--prefix',
      'queue-check',
      '--timeout-ms',
      '1234',
    ],
    {},
  )

  assert.equal(options.base, 'http://dual.local')
  assert.equal(options.cookie, 'cf_session=test')
  assert.equal(options.databasePath.endsWith('/data/test.sqlite3'), true)
  assert.equal(options.prefix, 'queue-check')
  assert.equal(options.timeoutMs, 1234)
})

test('queue-control promotion gate owns all eight pipeline-control routes', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const routes = contract.routes.filter(
    (route) => route.capability === 'pipeline-control',
  )

  assert.deepEqual(
    routes.map((route) => route.id),
    QUEUE_CONTROL_ROUTE_IDS,
  )
  assert.equal(routes.length, 8)
  assert.ok(routes.every((route) => route.maturity.node === 'stable'))
  assert.ok(routes.every((route) => route.maturity.go === 'verified'))
})

test('queue-control pair matrix covers reads, auth, validation, coercion, and safe clear semantics', () => {
  const allCases = [
    ...QUEUE_CONTROL_READ_CASES,
    ...QUEUE_CONTROL_BOUNDARY_CASES,
  ]
  const signatures = new Set(
    allCases.map((item) => `${item.method} ${item.path.split('?')[0]}`),
  )

  assert.deepEqual(
    signatures,
    new Set([
      'POST /api/queue/add-task',
      'POST /api/queue/add-tasks',
      'GET /api/queue/stats/910001',
      'GET /api/queue/stats/910001.0',
      'GET /api/queue/stats/9.10001e5',
      'GET /api/queue/stats/0xde2b1',
      'GET /api/queue/stats/%20910001%20',
      'GET /api/queue/stats',
      'DELETE /api/queue/task/clear',
      'GET /api/queue/task/list',
      'POST /api/queue/task/retry-batch',
      'POST /api/queue/task/retry',
      'GET /api/queue/stats/999999999',
      'GET /api/queue/stats/910001.5',
      'GET /api/queue/stats/not-a-number',
    ]),
  )
  assert.ok(allCases.some((item) => item.name.includes('anonymous cannot')))
  assert.ok(allCases.some((item) => item.name.includes('member cannot')))
  assert.ok(allCases.some((item) => item.name.includes('malformed JSON')))
  assert.ok(
    allCases.some((item) => item.name.includes('invalid nested options')),
  )
  assert.ok(allCases.some((item) => item.name.includes('hexadecimal notation')))
  assert.ok(
    allCases.some((item) => item.name.includes('trailing numeric prefix')),
  )
  assert.ok(allCases.some((item) => item.name.includes('repeated age')))
})

test('validateQueuePair checks exact body and response metadata', () => {
  const requestID = 'queue-pair-unit'
  const result = (expectedBackend, body, overrides = {}) => ({
    expectedBackend,
    status: 400,
    backend: expectedBackend,
    contentType: 'application/json',
    requestID,
    responseRequestID: requestID,
    setCookie: false,
    body,
    ...overrides,
  })
  const testCase = { name: 'unit pair', expectedStatus: 400 }
  const node = result('node', {
    statusCode: 400,
    message: 'same',
    url: '/node',
  })
  const go = result('go', { message: 'same', statusCode: 400, url: '/go' })

  assert.deepEqual(validateQueuePair(testCase, node, go), [])
  const differences = validateQueuePair(
    testCase,
    node,
    result(
      'go',
      { message: 'different' },
      {
        responseRequestID: 'wrong',
        setCookie: true,
      },
    ),
  )
  assert.ok(
    differences.some((item) => item.field === 'go.headers.x-request-id'),
  )
  assert.ok(differences.some((item) => item.field === 'go.headers.set-cookie'))
  assert.ok(differences.some((item) => item.field === 'body'))
})
