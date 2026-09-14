import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { H3Event } from 'h3'
import * as schema from '../backend/nodejs/database/schema'
import { registerSharedSessionFetchHook } from '../backend/nodejs/utils/authz'
import {
  acquireRequestRateLimit,
  buildLoginRateLimitSubject,
  buildRateLimitKey,
  RATE_LIMIT_ACQUIRE_SCRIPT,
  resetRequestRateLimit,
} from '../backend/nodejs/utils/rate-limiter'
import { parseSharedRedisRequired } from '../backend/nodejs/utils/shared-redis'
import {
  buildSharedAccessWrite,
  SHARED_ACCESS_TTL_SECONDS,
} from '../backend/nodejs/utils/shared-access'
import {
  buildSharedSessionWrite,
  legacySessionFallbackAllowed,
  registerSharedSessionClearHook,
  revokeSharedSessionRecord,
  SHARED_STATE_TTL_CLOCK_SKEW_MS,
  validateAbsoluteRedisTTL,
  writeAbsoluteSharedState,
  type SharedRedisCommands,
} from '../backend/nodejs/utils/shared-session'
import { SHARED_SESSION_TTL_SECONDS } from '../backend/nodejs/utils/shared-state-contract'
import {
  getFreshAccessPasswordHash,
  updateAccessSecurityConfiguration,
} from '../backend/nodejs/utils/site-access'
import { buildPhotoStatsWhere } from '../backend/nodejs/utils/system-stats'

const goldenToken = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const goldenDigest =
  'ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0'

test('shared Redis required flag accepts only exact booleans', () => {
  assert.equal(parseSharedRedisRequired(undefined), false)
  assert.equal(parseSharedRedisRequired('true'), true)
  assert.equal(parseSharedRedisRequired('false'), false)
  assert.throws(() => parseSharedRedisRequired('TRUE'), /true or false/)
  assert.throws(() => parseSharedRedisRequired(''), /true or false/)
  assert.throws(() => parseSharedRedisRequired('typo'), /true or false/)
})

test('required shared-state mode rejects legacy-only session replay', () => {
  assert.equal(legacySessionFallbackAllowed(undefined, false), true)
  assert.equal(legacySessionFallbackAllowed('false', false), true)
  assert.equal(legacySessionFallbackAllowed('true', false), false)
  assert.equal(legacySessionFallbackAllowed(undefined, true), false)
  assert.equal(legacySessionFallbackAllowed('false', true), false)
})

test('session fetch hook removes a replayed legacy identity', async () => {
  let fetchHook:
    | ((session: Record<string, unknown>, event: H3Event) => Promise<void>)
    | undefined
  const cleared: H3Event[] = []
  registerSharedSessionFetchHook(
    {
      hook(_name, callback) {
        fetchHook = callback
      },
    },
    async () => null,
    async (event) => {
      cleared.push(event)
    },
  )

  assert.ok(fetchHook)
  const replayedSession: Record<string, unknown> = {
    id: 'legacy-id',
    user: { id: 1, password: 'old-password-hash' },
    attackerControlled: 'old-value',
  }
  const event = { context: {} } as unknown as H3Event
  await fetchHook(replayedSession, event)
  assert.deepEqual(replayedSession, { id: 'legacy-id' })
  assert.deepEqual(cleared, [event])
})

test('identity-sensitive routes and session fetch use shared guards', async () => {
  const [
    profileRoute,
    displayRoute,
    statsRoute,
    albumRoute,
    photoAlbumsRoute,
    sharedRedisPlugin,
  ] = await Promise.all([
    readFile(new URL('../backend/nodejs/api/profile.get.ts', import.meta.url), 'utf8'),
    readFile(
      new URL('../backend/nodejs/routes/display/[photoId].get.ts', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../backend/nodejs/api/system/stats.get.ts', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../backend/nodejs/api/albums/[albumId]/index.get.ts', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../backend/nodejs/api/photos/[photoId]/albums.get.ts', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../backend/nodejs/plugins/1.shared-redis.ts', import.meta.url),
      'utf8',
    ),
  ])
  assert.match(profileRoute, /requireCurrentUser\(event\)/)
  assert.match(displayRoute, /getOptionalCurrentUser\(event\)/)
  assert.doesNotMatch(displayRoute, /\bgetUserSession\(event\)/)
  assert.match(statsRoute, /requireCurrentUser\(event\)/)
  assert.doesNotMatch(statsRoute, /\brequireUserSession\(event\)/)
  assert.equal(
    statsRoute.match(/buildPhotoStatsWhere\(user/g)?.length,
    6,
    'every photo aggregate in system stats must use the user-aware scope',
  )
  assert.match(statsRoute, /if \(user\.isAdmin\)/)
  assert.match(albumRoute, /getOptionalCurrentUser\(event\)/)
  assert.doesNotMatch(albumRoute, /\bgetUserSession\(event\)/)
  assert.match(photoAlbumsRoute, /getOptionalCurrentUser\(event\)/)
  assert.doesNotMatch(photoAlbumsRoute, /\bgetUserSession\(event\)/)
  assert.match(
    sharedRedisPlugin,
    /registerSharedSessionFetchHook\(sessionHooks\)/,
  )
})

test('system photo stats scope members by owner and leaves admins global', () => {
  const database = new Database(':memory:')
  try {
    const orm = drizzle(database, { schema })
    const memberQuery = orm
      .select({ id: schema.photos.id })
      .from(schema.photos)
      .where(
        buildPhotoStatsWhere({ id: 7, isAdmin: 0 }, '2026-09-01T00:00:00.000Z'),
      )
      .toSQL()
    assert.match(memberQuery.sql, /owner_user_id[^?]*= \?/)
    assert.match(memberQuery.sql, /date_taken[^?]*>= \?/)
    assert.deepEqual(memberQuery.params, [7, '2026-09-01T00:00:00.000Z'])

    const adminQuery = orm
      .select({ id: schema.photos.id })
      .from(schema.photos)
      .where(buildPhotoStatsWhere({ id: 1, isAdmin: 1 }))
      .toSQL()
    assert.doesNotMatch(adminQuery.sql, /owner_user_id/)
    assert.deepEqual(adminQuery.params, [])
  } finally {
    database.close()
  }
})

test('session/access writes use cross-language JSON and absolute Redis expiry', async () => {
  const nowSeconds = 1_788_940_800
  const session = buildSharedSessionWrite({
    environment: 'test',
    userId: 12,
    authVersion: 4,
    nowSeconds,
    token: goldenToken,
  })
  const access = buildSharedAccessWrite({
    environment: 'test',
    accessVersion: 3,
    nowSeconds,
    token: goldenToken,
  })

  assert.equal(session.key, `cf:v1:test:session:${goldenDigest}`)
  assert.equal(
    session.value,
    `{"schemaVersion":1,"userId":12,"authVersion":4,"issuedAt":${nowSeconds},"expiresAt":${nowSeconds + SHARED_SESSION_TTL_SECONDS}}`,
  )
  assert.equal(access.key, `cf:v1:test:access:${goldenDigest}`)
  assert.equal(access.record.expiresAt, nowSeconds + SHARED_ACCESS_TTL_SECONDS)

  const calls: unknown[][] = []
  const redis = {
    async set(...args: unknown[]) {
      calls.push(args)
      return 'OK'
    },
  } as unknown as SharedRedisCommands
  await writeAbsoluteSharedState(
    redis,
    session.key,
    session.value,
    session.record.expiresAt,
  )
  assert.deepEqual(calls, [
    [
      session.key,
      session.value,
      {
        expiration: { type: 'EXAT', value: session.record.expiresAt },
      },
    ],
  ])
})

test('shared-state readers reject Redis TTL beyond record expiry', () => {
  const nowSeconds = 1_788_940_800
  const expiresAt = nowSeconds + 60
  validateAbsoluteRedisTTL(expiresAt, nowSeconds, 60_000)
  validateAbsoluteRedisTTL(
    expiresAt,
    nowSeconds,
    60_000 + SHARED_STATE_TTL_CLOCK_SKEW_MS,
  )
  assert.throws(
    () =>
      validateAbsoluteRedisTTL(
        expiresAt,
        nowSeconds,
        60_001 + SHARED_STATE_TTL_CLOCK_SKEW_MS,
      ),
    /absolute expiry/,
  )
  assert.throws(
    () => validateAbsoluteRedisTTL(expiresAt, nowSeconds, -1),
    /absolute expiry/,
  )
})

test('logout revokes the digest key and the built-in session clear hook calls it', async () => {
  const deleted: string[] = []
  await revokeSharedSessionRecord(
    {
      async del(key) {
        deleted.push(key)
        return 1
      },
    },
    'test',
    goldenToken,
  )
  assert.deepEqual(deleted, [`cf:v1:test:session:${goldenDigest}`])

  let clearHook:
    | ((session: unknown, event: H3Event) => Promise<void>)
    | undefined
  const revoked: string[] = []
  registerSharedSessionClearHook(
    {
      hook(_name, callback) {
        clearHook = callback as typeof clearHook
      },
    },
    async (event) => {
      revoked.push((event as unknown as { marker: string }).marker)
    },
  )
  assert.ok(clearHook)
  await clearHook({}, { marker: 'built-in-delete' } as unknown as H3Event)
  assert.deepEqual(revoked, ['built-in-delete'])
})

test('rate-limit keys are fixed-size HMAC identifiers in fixed windows', () => {
  const input = {
    environment: 'test',
    purpose: 'login' as const,
    subject: `203.0.113.9:${'attacker-input'.repeat(100)}`,
    nowSeconds: 1_788_940_800,
    windowSeconds: 900,
    secret: 'rate-limit-secret-0123456789abcdef',
  }
  const first = buildRateLimitKey(input)
  const second = buildRateLimitKey({
    ...input,
    nowSeconds: input.nowSeconds + 1,
  })
  assert.equal(first.key, second.key)
  assert.equal(first.key.includes('203.0.113.9'), false)
  assert.match(first.key, /^cf:v1:test:ratelimit:login:[a-f0-9]{64}:[0-9]+$/)
  assert.ok(first.key.length < 128)
  assert.match(RATE_LIMIT_ACQUIRE_SCRIPT, /redis\.call\('INCR'/)
  assert.match(RATE_LIMIT_ACQUIRE_SCRIPT, /redis\.call\('EXPIREAT'/)
})

test('login uses an email-specific bucket while site access remains IP-scoped', async () => {
  const [loginRoute, accessRoute] = await Promise.all([
    readFile(new URL('../backend/nodejs/api/login.post.ts', import.meta.url), 'utf8'),
    readFile(
      new URL('../backend/nodejs/api/access/verify.post.ts', import.meta.url),
      'utf8',
    ),
  ])
  assert.match(loginRoute, /buildLoginRateLimitSubject\(/)
  assert.match(loginRoute, /requestRateLimitSubject\(event\)/)
  assert.doesNotMatch(accessRoute, /buildLoginRateLimitSubject\(/)
  assert.match(accessRoute, /acquireRequestRateLimit\(event, 'access'\)/)
})

test('successful login resets only that IP and normalized-email bucket', async () => {
  const previousEnvironment = process.env.CFRAME_ENV
  const previousRateLimitSecret = process.env.CFRAME_RATE_LIMIT_SECRET
  const previousRedisURL = process.env.CFRAME_REDIS_URL
  const previousRedisRequired = process.env.CFRAME_REDIS_REQUIRED
  process.env.CFRAME_ENV = 'login-bucket-test'
  process.env.CFRAME_RATE_LIMIT_SECRET =
    'login-rate-limit-secret-0123456789abcdef'
  delete process.env.CFRAME_REDIS_URL
  process.env.CFRAME_REDIS_REQUIRED = 'false'

  try {
    const event = {} as H3Event
    const sharedOptions = {
      nowSeconds: 1_788_940_800,
      windowSeconds: 900,
    }
    const victimSubject = buildLoginRateLimitSubject(
      '203.0.113.9',
      ' Victim@Example.COM ',
    )
    const ownSubject = buildLoginRateLimitSubject(
      '203.0.113.9',
      'attacker@example.com',
    )
    assert.equal(victimSubject, '203.0.113.9\0victim@example.com')
    assert.notEqual(victimSubject, ownSubject)

    const victimFirst = await acquireRequestRateLimit(event, 'login', {
      ...sharedOptions,
      subject: victimSubject,
    })
    const ownSuccessful = await acquireRequestRateLimit(event, 'login', {
      ...sharedOptions,
      subject: ownSubject,
    })
    await resetRequestRateLimit(ownSuccessful)
    const victimSecond = await acquireRequestRateLimit(event, 'login', {
      ...sharedOptions,
      subject: victimSubject,
    })

    assert.equal(victimFirst.count, 1)
    assert.equal(victimSecond.count, 2)
    assert.notEqual(victimFirst.key, ownSuccessful.key)
    await resetRequestRateLimit(victimSecond)
  } finally {
    if (previousEnvironment === undefined) delete process.env.CFRAME_ENV
    else process.env.CFRAME_ENV = previousEnvironment
    if (previousRateLimitSecret === undefined)
      delete process.env.CFRAME_RATE_LIMIT_SECRET
    else process.env.CFRAME_RATE_LIMIT_SECRET = previousRateLimitSecret
    if (previousRedisURL === undefined) delete process.env.CFRAME_REDIS_URL
    else process.env.CFRAME_REDIS_URL = previousRedisURL
    if (previousRedisRequired === undefined)
      delete process.env.CFRAME_REDIS_REQUIRED
    else process.env.CFRAME_REDIS_REQUIRED = previousRedisRequired
  }
})

test('auth_version defaults to one and security mutations invalidate sessions', async () => {
  const migration = await readFile(
    new URL(
      '../backend/nodejs/database/migrations/0022_user_auth_version.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const database = new Database(':memory:')
  try {
    database.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        password TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO users (id, password) VALUES (1, 'old-hash');
    `)
    database.exec(migration.replaceAll('--> statement-breakpoint', ''))
    const authVersion = () =>
      (
        database
          .prepare('SELECT auth_version FROM users WHERE id = 1')
          .get() as { auth_version: number }
      ).auth_version

    assert.equal(authVersion(), 1)
    database.prepare('UPDATE users SET password = ? WHERE id = 1').run('new')
    assert.equal(authVersion(), 2)
    database.prepare('UPDATE users SET is_admin = 1 WHERE id = 1').run()
    assert.equal(authVersion(), 3)
    database.prepare('UPDATE users SET is_active = 0 WHERE id = 1').run()
    assert.equal(authVersion(), 4)
    database.prepare('UPDATE users SET password = ? WHERE id = 1').run('new')
    assert.equal(authVersion(), 4)
  } finally {
    database.close()
  }
})

test('access password verification reads the latest database value', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.exec(`
      CREATE TABLE settings (namespace TEXT, key TEXT, value TEXT);
      INSERT INTO settings VALUES ('app', 'access.passwordHash', 'old-hash');
    `)
    const database = drizzle(sqlite, { schema })
    assert.equal(getFreshAccessPasswordHash(database), 'old-hash')

    sqlite
      .prepare(
        "UPDATE settings SET value = 'new-hash' WHERE namespace = 'app' AND key = 'access.passwordHash'",
      )
      .run()
    assert.equal(getFreshAccessPasswordHash(database), 'new-hash')
  } finally {
    sqlite.close()
  }
})

test('two database connections increment access version without stale-cache rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chronoframe-access-version-'))
  const databasePath = join(directory, 'settings.db')
  const sqliteA = new Database(databasePath)
  const sqliteB = new Database(databasePath)
  try {
    sqliteA.pragma('journal_mode = WAL')
    sqliteA.pragma('busy_timeout = 5000')
    sqliteB.pragma('busy_timeout = 5000')
    sqliteA.exec(`
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at INTEGER,
        updated_by INTEGER,
        UNIQUE(namespace, key)
      );
      INSERT INTO settings (namespace, key, value) VALUES
        ('app', 'access.passwordHash', 'existing-hash'),
        ('app', 'access.enabled', 'false'),
        ('app', 'access.previewPhotoLimit', '10'),
        ('app', 'access.previewAlbumLimit', '1'),
        ('app', 'access.version', '1');
    `)
    const databaseA = drizzle(sqliteA, { schema })
    const databaseB = drizzle(sqliteB, { schema })

    // Both processes may have observed the same old cached value. Neither
    // value is supplied to the updater; SQLite owns the increment.
    assert.equal(
      sqliteA
        .prepare(
          "SELECT value FROM settings WHERE namespace = 'app' AND key = 'access.version'",
        )
        .pluck()
        .get(),
      '1',
    )
    assert.equal(
      sqliteB
        .prepare(
          "SELECT value FROM settings WHERE namespace = 'app' AND key = 'access.version'",
        )
        .pluck()
        .get(),
      '1',
    )

    const first = updateAccessSecurityConfiguration(
      {
        enabled: true,
        photoLimit: 20,
        albumLimit: 2,
        updatedBy: 1,
      },
      databaseA,
    )
    const second = updateAccessSecurityConfiguration(
      {
        enabled: false,
        photoLimit: 30,
        albumLimit: 3,
        updatedBy: 2,
      },
      databaseB,
    )

    assert.equal(first.version, 2)
    assert.equal(second.version, 3)
    assert.equal(
      sqliteA
        .prepare(
          "SELECT value FROM settings WHERE namespace = 'app' AND key = 'access.version'",
        )
        .pluck()
        .get(),
      '3',
    )
  } finally {
    sqliteA.close()
    sqliteB.close()
    await rm(directory, { recursive: true, force: true })
  }
})
