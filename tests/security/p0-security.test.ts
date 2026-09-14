import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { createHmac } from 'node:crypto'
import { LocalStorageProvider } from '../../backend/nodejs/services/storage/providers/local'
import {
  isPathContained,
  normalizeStorageRelativePath,
  resolveLocalStorageObjectPath,
} from '../../backend/nodejs/utils/local-storage-path'
import {
  getSessionCookieOptions,
  getSiteAccessCookieOptions,
  isSetupIncompleteValue,
  redactWizardSecretField,
  toSessionUser,
} from '../../backend/nodejs/utils/security-policy'
import {
  createOgMediaSignature,
  verifyOgMediaSignature,
} from '../../backend/nodejs/utils/og-media-signing'
import {
  applySQLiteSafetyPragmas,
  SQLITE_BUSY_TIMEOUT_MS,
} from '../../backend/nodejs/utils/sqlite-security'

test('session users contain only explicitly allowed identity fields', () => {
  const sessionUser = toSessionUser({
    id: 7,
    username: 'alice',
    email: 'alice@example.com',
    password: '$scrypt$sensitive-hash',
    avatar: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    isAdmin: 1,
    isActive: true,
  })

  assert.deepEqual(sessionUser, {
    id: 7,
    username: 'alice',
    email: 'alice@example.com',
    avatar: null,
    isAdmin: 1,
    isActive: true,
  })
  assert.equal('password' in sessionUser, false)
  assert.equal('createdAt' in sessionUser, false)
})

test('session cookies follow HTTP and HTTPS transport unless explicitly insecure', () => {
  for (const value of [undefined, null, false, 'false', '0', 1]) {
    assert.deepEqual(getSessionCookieOptions(value, 'https'), { secure: true })
    assert.deepEqual(getSessionCookieOptions(value, 'http'), { secure: false })
  }

  for (const value of [true, 'true', ' TRUE ']) {
    assert.deepEqual(getSessionCookieOptions(value, 'https'), { secure: false })
    assert.deepEqual(getSessionCookieOptions(value, 'http'), { secure: false })
  }

  assert.deepEqual(getSiteAccessCookieOptions(false, 'https'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
  })
  assert.deepEqual(getSiteAccessCookieOptions(false, 'http'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
  })
  assert.deepEqual(getSiteAccessCookieOptions(true, 'https'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
  })
})

test('cookie writers explicitly honor reverse-proxy request protocol', async () => {
  const [sharedSession, sharedAccess] = await Promise.all([
    fs.readFile(
      new URL('../../backend/nodejs/utils/shared-session.ts', import.meta.url),
      'utf8',
    ),
    fs.readFile(
      new URL('../../backend/nodejs/utils/shared-access.ts', import.meta.url),
      'utf8',
    ),
  ])
  const forwardedProtocol =
    /getRequestProtocol\(event, \{ xForwardedProto: true \}\)/g
  assert.equal(sharedSession.match(forwardedProtocol)?.length, 2)
  assert.equal(sharedAccess.match(forwardedProtocol)?.length, 1)
})

test('OG media uses a dedicated secret and verifies legacy session-signed links', () => {
  const previousOgSecret = process.env.NUXT_OG_IMAGE_SECRET
  const previousSessionSecret = process.env.NUXT_SESSION_PASSWORD
  const dedicatedSecret = 'dedicated-og-secret-0123456789abcdef'
  const legacySessionSecret = 'legacy-session-secret-0123456789abcdef'
  const payload = '7:photo-1:photos/thumb.webp'

  process.env.NUXT_OG_IMAGE_SECRET = dedicatedSecret
  process.env.NUXT_SESSION_PASSWORD = legacySessionSecret

  try {
    const currentToken = createOgMediaSignature(
      'photo-1',
      'photos/thumb.webp',
      '7',
    )
    const expectedCurrent = createHmac('sha256', dedicatedSecret)
      .update(payload)
      .digest('base64url')
    const legacyToken = createHmac('sha256', legacySessionSecret)
      .update(payload)
      .digest('base64url')

    assert.equal(currentToken, expectedCurrent)
    assert.equal(
      verifyOgMediaSignature('photo-1', 'photos/thumb.webp', currentToken, '7'),
      true,
    )
    assert.equal(
      verifyOgMediaSignature('photo-1', 'photos/thumb.webp', legacyToken, '7'),
      true,
    )
    assert.equal(
      verifyOgMediaSignature('photo-1', 'photos/thumb.webp', currentToken, '8'),
      false,
    )
  } finally {
    if (previousOgSecret === undefined) delete process.env.NUXT_OG_IMAGE_SECRET
    else process.env.NUXT_OG_IMAGE_SECRET = previousOgSecret
    if (previousSessionSecret === undefined)
      delete process.env.NUXT_SESSION_PASSWORD
    else process.env.NUXT_SESSION_PASSWORD = previousSessionSecret
  }
})

test('OG media fallback is domain separated while old links stay valid', () => {
  const previousOgSecret = process.env.NUXT_OG_IMAGE_SECRET
  const previousSessionSecret = process.env.NUXT_SESSION_PASSWORD
  const legacySessionSecret = 'legacy-session-secret-0123456789abcdef'
  const payload = '3:photo-2:photos/other.webp'

  delete process.env.NUXT_OG_IMAGE_SECRET
  process.env.NUXT_SESSION_PASSWORD = legacySessionSecret

  try {
    const fallbackToken = createOgMediaSignature(
      'photo-2',
      'photos/other.webp',
      '3',
    )
    const legacyToken = createHmac('sha256', legacySessionSecret)
      .update(payload)
      .digest('base64url')

    assert.notEqual(fallbackToken, legacyToken)
    assert.equal(
      verifyOgMediaSignature(
        'photo-2',
        'photos/other.webp',
        fallbackToken,
        '3',
      ),
      true,
    )
    assert.equal(
      verifyOgMediaSignature('photo-2', 'photos/other.webp', legacyToken, '3'),
      true,
    )
  } finally {
    if (previousOgSecret === undefined) delete process.env.NUXT_OG_IMAGE_SECRET
    else process.env.NUXT_OG_IMAGE_SECRET = previousOgSecret
    if (previousSessionSecret === undefined)
      delete process.env.NUXT_SESSION_PASSWORD
    else process.env.NUXT_SESSION_PASSWORD = previousSessionSecret
  }
})

test('wizard availability accepts only explicit first-launch values', () => {
  for (const value of [true, 1, 'true', '1']) {
    assert.equal(isSetupIncompleteValue(value), true)
  }

  for (const value of [false, 0, 'false', '0', null, undefined, '']) {
    assert.equal(isSetupIncompleteValue(value), false)
  }
})

test('wizard schema fields never echo password or secret values', () => {
  const passwordField = redactWizardSecretField({
    value: 'persisted-password',
    defaultValue: 'environment-password',
    ui: { type: 'password' },
  })
  const secretField = redactWizardSecretField({
    value: 'persisted-secret',
    defaultValue: 'default-secret',
    isSecret: true,
    ui: { type: 'input' },
  })
  const publicField = {
    value: 'ChronoFrame',
    defaultValue: 'ChronoFrame',
    ui: { type: 'input' },
  }

  assert.equal(passwordField.value, '')
  assert.equal(passwordField.defaultValue, '')
  assert.equal(secretField.value, '')
  assert.equal(secretField.defaultValue, '')
  assert.equal(redactWizardSecretField(publicField), publicField)
})

test('local storage paths normalize safe keys inside the configured base', () => {
  assert.equal(
    normalizeStorageRelativePath('albums//summer/photo.jpg', 'storage key'),
    'albums/summer/photo.jpg',
  )

  const prefixed = resolveLocalStorageObjectPath(
    '/srv/chronoframe/storage',
    'photos/',
    'albums/summer.jpg',
  )
  assert.equal(prefixed.relKey, 'photos/albums/summer.jpg')
  assert.equal(
    prefixed.absFile,
    path.resolve('/srv/chronoframe/storage/photos/albums/summer.jpg'),
  )

  const alreadyPrefixed = resolveLocalStorageObjectPath(
    '/srv/chronoframe/storage',
    'photos',
    'photos/albums/summer.jpg',
  )
  assert.equal(alreadyPrefixed.relKey, 'photos/albums/summer.jpg')
  assert.equal(
    isPathContained('/srv/chronoframe/storage', alreadyPrefixed.absFile),
    true,
  )
})

test('local storage rejects absolute, Windows, control, and dot-segment paths', () => {
  const invalidKeys = [
    '/etc/passwd',
    'C:/Windows/system.ini',
    'C:\\Windows\\system.ini',
    '\\\\server\\share\\file',
    'album/../outside.jpg',
    './photo.jpg',
    'album/./photo.jpg',
    'album/secret\u0000.jpg',
    '.',
    '..',
  ]

  for (const key of invalidKeys) {
    assert.throws(
      () => resolveLocalStorageObjectPath('/srv/storage', 'photos', key),
      /safe relative path/,
    )
  }

  for (const prefix of ['/photos', '../photos', 'photos\\private']) {
    assert.throws(
      () => resolveLocalStorageObjectPath('/srv/storage', prefix, 'image.jpg'),
      /safe relative path/,
    )
  }
})

test('local provider rejects symlink escapes for reads and writes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cframe-storage-'))
  const basePath = path.join(tempRoot, 'base')
  const outsidePath = path.join(tempRoot, 'outside')
  await fs.mkdir(basePath)
  await fs.mkdir(outsidePath)
  await fs.writeFile(path.join(outsidePath, 'secret.txt'), 'secret')
  await fs.symlink(outsidePath, path.join(basePath, 'escape'))

  try {
    const provider = new LocalStorageProvider({
      provider: 'local',
      basePath,
    })

    await assert.rejects(provider.get('escape/secret.txt'), /escapes basePath/)
    await assert.rejects(
      provider.create('escape/new.txt', Buffer.from('unsafe')),
      /escapes basePath/,
    )
    await assert.rejects(fs.access(path.join(outsidePath, 'new.txt')))

    const escapedPrefixProvider = new LocalStorageProvider({
      provider: 'local',
      basePath,
      prefix: 'escape/nested',
    })
    await assert.rejects(escapedPrefixProvider.listAll(), /escapes basePath/)
    await assert.rejects(fs.access(path.join(outsidePath, 'nested')))

    await provider.create('safe/photo.jpg', Buffer.from('safe'))
    assert.equal((await provider.get('safe/photo.jpg'))?.toString(), 'safe')
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('SQLite safety pragmas enable foreign keys and bounded lock waiting', () => {
  const pragmas: string[] = []
  applySQLiteSafetyPragmas({
    pragma(source) {
      pragmas.push(source)
    },
  })

  assert.deepEqual(pragmas, [
    'foreign_keys = ON',
    `busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`,
  ])

  const database = new Database(':memory:')
  try {
    applySQLiteSafetyPragmas(database)
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1)
    assert.equal(
      database.pragma('busy_timeout', { simple: true }),
      SQLITE_BUSY_TIMEOUT_MS,
    )
    database.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));
    `)
    assert.throws(
      () => database.prepare('INSERT INTO child VALUES (?)').run(42),
      /FOREIGN KEY constraint failed/,
    )
  } finally {
    database.close()
  }
})
