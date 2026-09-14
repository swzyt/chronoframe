import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

test('public upload share quota and queue insert commit atomically', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cframe-share-'))
  const databasePath = path.join(tempRoot, 'share.sqlite3')
  const previousDatabaseURL = process.env.DATABASE_URL
  process.env.DATABASE_URL = databasePath

  const setup = new Database(databasePath)
  setup.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE upload_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      token TEXT,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      upload_count INTEGER NOT NULL DEFAULT 0,
      max_uploads INTEGER,
      expires_at INTEGER,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE pipeline_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0 CHECK(priority <= 9),
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
    INSERT INTO users(id) VALUES (7);
    INSERT INTO upload_shares(
      id, token_hash, owner_user_id, created_by_user_id,
      is_active, upload_count, max_uploads
    ) VALUES
      (1, 'active', 7, 7, 1, 0, 1),
      (2, 'rollback', 7, 7, 1, 0, 5),
      (3, 'inactive', 7, 7, 0, 0, 5);
  `)
  setup.close()

  let closeDB: (() => void) | undefined
  try {
    const [{ enqueueUploadShareTaskAtomically }, databaseModule] =
      await Promise.all([
        import('../backend/nodejs/utils/upload-share'),
        import('../backend/nodejs/utils/db'),
      ])
    closeDB = databaseModule.closeDB
    const payload = {
      type: 'photo' as const,
      storageKey: 'users/7/guest-uploads/1/example.jpg',
    }
    const now = new Date('2026-09-13T15:00:00.000Z')

    const firstTask = enqueueUploadShareTaskAtomically({
      shareId: 1,
      ownerUserId: 7,
      payload,
      priority: 1,
      maxAttempts: 3,
      now,
    })
    const exhaustedTask = enqueueUploadShareTaskAtomically({
      shareId: 1,
      ownerUserId: 7,
      payload,
      priority: 1,
      maxAttempts: 3,
      now,
    })
    const inactiveTask = enqueueUploadShareTaskAtomically({
      shareId: 3,
      ownerUserId: 7,
      payload,
      priority: 1,
      maxAttempts: 3,
      now,
    })

    assert.equal(typeof firstTask, 'number')
    assert.equal(exhaustedTask, null)
    assert.equal(inactiveTask, null)
    assert.throws(() =>
      enqueueUploadShareTaskAtomically({
        shareId: 2,
        ownerUserId: 7,
        payload,
        priority: 99,
        maxAttempts: 3,
        now,
      }),
    )

    closeDB()
    closeDB = undefined
    const verifier = new Database(databasePath, { readonly: true })
    try {
      const shares = verifier
        .prepare(
          'SELECT id, upload_count, last_used_at FROM upload_shares ORDER BY id',
        )
        .all()
      assert.deepEqual(shares, [
        {
          id: 1,
          upload_count: 1,
          last_used_at: Math.floor(now.getTime() / 1000),
        },
        { id: 2, upload_count: 0, last_used_at: null },
        { id: 3, upload_count: 0, last_used_at: null },
      ])
      assert.equal(
        (
          verifier
            .prepare('SELECT count(*) AS count FROM pipeline_queue')
            .get() as { count: number }
        ).count,
        1,
      )
    } finally {
      verifier.close()
    }
  } finally {
    closeDB?.()
    if (previousDatabaseURL === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousDatabaseURL
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})
