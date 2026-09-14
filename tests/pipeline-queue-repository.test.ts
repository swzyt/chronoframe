import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

test('queue producers persist tasks while the Node consumer is disabled', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cframe-queue-'))
  const databasePath = path.join(tempRoot, 'queue.sqlite3')
  const previousDatabaseUrl = process.env.DATABASE_URL
  const previousConsumer = process.env.CFRAME_PIPELINE_CONSUMER
  let closeDB: (() => void) | undefined

  process.env.DATABASE_URL = databasePath
  process.env.CFRAME_PIPELINE_CONSUMER = 'none'

  const setupDatabase = new Database(databasePath)
  try {
    setupDatabase.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY
      );
      CREATE TABLE pipeline_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        status TEXT NOT NULL DEFAULT 'pending',
	        status_stage TEXT,
	        error_message TEXT,
	        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	        available_at INTEGER NOT NULL DEFAULT (unixepoch()),
	        claimed_by TEXT,
	        claim_token TEXT,
	        claim_expires_at INTEGER,
	        completed_at INTEGER,
	        owner_user_id INTEGER NOT NULL REFERENCES users(id)
	      );
      INSERT INTO users (id) VALUES (7);
    `)
  } finally {
    setupDatabase.close()
  }

  try {
    const [{ enqueuePipelineTask }, databaseModule] = await Promise.all([
      import('../backend/nodejs/services/pipeline-queue/repository'),
      import('../backend/nodejs/utils/db'),
    ])
    closeDB = databaseModule.closeDB

    assert.equal(
      (globalThis as { __workerPool?: unknown }).__workerPool,
      undefined,
    )

    const taskId = await enqueuePipelineTask(
      { type: 'photo', storageKey: 'photos/users/7/example.jpg' },
      { ownerUserId: 7, priority: 4, maxAttempts: 2 },
    )
    const defaultedTaskId = await enqueuePipelineTask(
      { type: 'photo-erase-location', photoId: 'photo-7' },
      { ownerUserId: 7 },
    )

    closeDB()
    closeDB = undefined

    const verifier = new Database(databasePath, { readonly: true })
    try {
      const task = verifier
        .prepare(
          'SELECT payload, priority, max_attempts, status, owner_user_id, available_at, claim_token FROM pipeline_queue WHERE id = ?',
        )
        .get(taskId) as {
        payload: string
        priority: number
        max_attempts: number
        status: string
        owner_user_id: number
        available_at: number
        claim_token: string | null
      }

      assert.deepEqual(JSON.parse(task.payload), {
        type: 'photo',
        storageKey: 'photos/users/7/example.jpg',
      })
      assert.equal(task.priority, 4)
      assert.equal(task.max_attempts, 2)
      assert.equal(task.status, 'pending')
      assert.equal(task.owner_user_id, 7)
      assert.equal(typeof task.available_at, 'number')
      assert.equal(task.claim_token, null)

      const defaultedTask = verifier
        .prepare(
          'SELECT priority, max_attempts, status, owner_user_id, claim_token FROM pipeline_queue WHERE id = ?',
        )
        .get(defaultedTaskId) as {
        priority: number
        max_attempts: number
        status: string
        owner_user_id: number
        claim_token: string | null
      }

      assert.deepEqual(defaultedTask, {
        priority: 0,
        max_attempts: 3,
        status: 'pending',
        owner_user_id: 7,
        claim_token: null,
      })
    } finally {
      verifier.close()
    }
  } finally {
    closeDB?.()

    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl
    }

    if (previousConsumer === undefined) {
      delete process.env.CFRAME_PIPELINE_CONSUMER
    } else {
      process.env.CFRAME_PIPELINE_CONSUMER = previousConsumer
    }

    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('shared queue row fencing rejects stale worker task writebacks by claim token', async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'cframe-queue-fence-'),
  )
  const databasePath = path.join(tempRoot, 'queue.sqlite3')

  const database = new Database(databasePath)
  try {
    database.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY
      );
      CREATE TABLE pipeline_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        status TEXT NOT NULL DEFAULT 'pending',
        status_stage TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        available_at INTEGER NOT NULL DEFAULT (unixepoch()),
        claimed_by TEXT,
        claim_token TEXT,
        claim_expires_at INTEGER,
        completed_at INTEGER,
        owner_user_id INTEGER NOT NULL REFERENCES users(id)
      );
      INSERT INTO users (id) VALUES (7);
      INSERT INTO pipeline_queue (
        id, payload, priority, attempts, max_attempts, status, status_stage,
        created_at, available_at, claimed_by, claim_token, claim_expires_at,
        owner_user_id
      )
      VALUES (
        1001, '{"type":"photo","storageKey":"photos/users/7/fenced.jpg"}',
        9, 0, 3, 'in-stages', NULL, 100, 100, 'node-worker-1',
        'good-token', 999, 7
      );
    `)

    const staleStage = database
      .prepare(
        `
        UPDATE pipeline_queue
        SET status_stage = ?
        WHERE id = ?
          AND status = 'in-stages'
          AND claim_token = ?
      `,
      )
      .run('metadata', 1001, 'stale-token')
    assert.equal(staleStage.changes, 0)

    const unchangedStage = database
      .prepare(
        'SELECT status, status_stage, claim_token FROM pipeline_queue WHERE id = ?',
      )
      .get(1001) as {
      status: string
      status_stage: string | null
      claim_token: string | null
    }
    assert.equal(unchangedStage.status, 'in-stages')
    assert.equal(unchangedStage.status_stage, null)
    assert.equal(unchangedStage.claim_token, 'good-token')

    const goodStage = database
      .prepare(
        `
        UPDATE pipeline_queue
        SET status_stage = ?
        WHERE id = ?
          AND status = 'in-stages'
          AND claim_token = ?
      `,
      )
      .run('metadata', 1001, 'good-token')
    assert.equal(goodStage.changes, 1)

    const staleComplete = database
      .prepare(
        `
        UPDATE pipeline_queue
        SET status = 'completed',
            completed_at = unixepoch(),
            claimed_by = NULL,
            claim_token = NULL,
            claim_expires_at = NULL
        WHERE id = ?
          AND status = 'in-stages'
          AND claim_token = ?
      `,
      )
      .run(1001, 'stale-token')
    assert.equal(staleComplete.changes, 0)

    const unchangedComplete = database
      .prepare(
        'SELECT status, status_stage, completed_at, claim_token FROM pipeline_queue WHERE id = ?',
      )
      .get(1001) as {
      status: string
      status_stage: string | null
      completed_at: number | null
      claim_token: string | null
    }
    assert.equal(unchangedComplete.status, 'in-stages')
    assert.equal(unchangedComplete.status_stage, 'metadata')
    assert.equal(unchangedComplete.completed_at, null)
    assert.equal(unchangedComplete.claim_token, 'good-token')

    const goodComplete = database
      .prepare(
        `
        UPDATE pipeline_queue
        SET status = 'completed',
            completed_at = unixepoch(),
            claimed_by = NULL,
            claim_token = NULL,
            claim_expires_at = NULL
        WHERE id = ?
          AND status = 'in-stages'
          AND claim_token = ?
      `,
      )
      .run(1001, 'good-token')
    assert.equal(goodComplete.changes, 1)

    const completed = database
      .prepare(
        'SELECT status, completed_at, claimed_by, claim_token, claim_expires_at FROM pipeline_queue WHERE id = ?',
      )
      .get(1001) as {
      status: string
      completed_at: number | null
      claimed_by: string | null
      claim_token: string | null
      claim_expires_at: number | null
    }
    assert.equal(completed.status, 'completed')
    assert.equal(typeof completed.completed_at, 'number')
    assert.equal(completed.claimed_by, null)
    assert.equal(completed.claim_token, null)
    assert.equal(completed.claim_expires_at, null)
  } finally {
    database.close()
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})
