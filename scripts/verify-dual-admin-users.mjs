#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import {
  canonicalize,
  DUAL_BACKEND_COMPARE_FIXTURE,
  joinBackendURL,
} from './compare-backends.mjs'
import {
  FIXTURE_MEMBER_SESSION_TOKEN,
  FIXTURE_SESSION_TOKEN,
} from './seed-dual-backend-fixture.mjs'

export const DEFAULT_ADMIN_USERS_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_ADMIN_USERS_ADMIN_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_ADMIN_USERS_MEMBER_COOKIE = `cf_session=${FIXTURE_MEMBER_SESSION_TOKEN}`
export const DEFAULT_ADMIN_USERS_PREFIX = 'dual-users'

export const ADMIN_USER_ROUTE_IDS = Object.freeze([
  'admin.users.delete',
  'admin.users.update',
  'admin.users.list',
  'admin.users.create',
])

const PROVIDERS = Object.freeze(['node', 'go'])
const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const USERS_PATH = '/api/admin/users'
const ADMIN_ID = DUAL_BACKEND_COMPARE_FIXTURE.userId
const MEMBER_ID = DUAL_BACKEND_COMPARE_FIXTURE.memberUserId
const ADMIN_EMAIL = 'dual-backend-fixture-admin@chronoframe.local'
const ADMIN_USERNAME = 'dual-backend-fixture-admin'
const USER_MUTATION_KEYS = Object.freeze([
  'email',
  'id',
  'isActive',
  'isAdmin',
  'username',
])
const USER_LIST_KEYS = Object.freeze([
  'albumCount',
  'avatar',
  'createdAt',
  'email',
  'id',
  'isActive',
  'isAdmin',
  'photoCount',
  'username',
])

export const ADMIN_USER_BOUNDARY_CASES = Object.freeze([
  boundary(
    'anonymous admin users list',
    'GET',
    USERS_PATH,
    'anonymous',
    401,
    'Unauthorized',
  ),
  boundary(
    'member admin users list forbidden',
    'GET',
    USERS_PATH,
    'member',
    403,
    'Forbidden',
  ),
  boundary(
    'anonymous admin user create',
    'POST',
    USERS_PATH,
    'anonymous',
    401,
    'Unauthorized',
    { body: validCreateBody('anonymous') },
  ),
  boundary(
    'member admin user create forbidden',
    'POST',
    USERS_PATH,
    'member',
    403,
    'Forbidden',
    { body: validCreateBody('member') },
  ),
  boundary(
    'admin user create missing body',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Validation Error',
  ),
  boundary(
    'admin user create null body',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Validation Error',
    { body: null },
  ),
  boundary(
    'admin user create primitive body',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Validation Error',
    { body: 1 },
  ),
  boundary(
    'admin user create array body',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Validation Error',
    { body: [] },
  ),
  boundary(
    'admin user create malformed JSON',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Bad Request',
    { rawBody: '{"username":', contentType: 'application/json' },
  ),
  boundary(
    'admin user create missing fields',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Validation Error',
    { body: {} },
  ),
  boundary(
    'admin user create null fields',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Validation Error',
    {
      body: {
        username: null,
        email: null,
        password: null,
        isAdmin: null,
      },
    },
  ),
  boundary(
    'admin user create invalid field types',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Validation Error',
    {
      body: {
        username: 1,
        email: true,
        password: [],
        isAdmin: 'false',
      },
    },
  ),
  boundary(
    'admin user create trimmed username lower bound',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Validation Error',
    { body: { ...validCreateBody('short-name'), username: '  a  ' } },
  ),
  boundary(
    'admin user create username UTF-16 upper bound',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Validation Error',
    { body: { ...validCreateBody('long-name'), username: '😀'.repeat(33) } },
  ),
  boundary(
    'admin user create validates email before trim',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Validation Error',
    {
      body: {
        ...validCreateBody('email-whitespace'),
        email: ' dual-users-email@example.test ',
      },
    },
  ),
  boundary(
    'admin user create invalid email',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Validation Error',
    { body: { ...validCreateBody('bad-email'), email: 'not-an-email' } },
  ),
  boundary(
    'admin user create password lower bound',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Validation Error',
    { body: { ...validCreateBody('short-password'), password: 'short' } },
  ),
  boundary(
    'admin user create password UTF-16 upper bound',
    'POST',
    USERS_PATH,
    'admin',
    400,
    'Validation Error',
    {
      body: { ...validCreateBody('long-password'), password: '😀'.repeat(65) },
    },
  ),
  boundary(
    'admin user create duplicate username conflict',
    'POST',
    USERS_PATH,
    'admin',
    409,
    'Username or email already exists',
    {
      body: {
        username: ADMIN_USERNAME,
        email: 'dual-users-duplicate-username@example.test',
        password: 'DualUsers123!',
      },
    },
  ),
  boundary(
    'admin user create duplicate email conflict',
    'POST',
    USERS_PATH,
    'admin',
    409,
    'Username or email already exists',
    {
      body: {
        username: 'dual-users-duplicate-email',
        email: ADMIN_EMAIL,
        password: 'DualUsers123!',
      },
    },
  ),
  boundary(
    'anonymous admin user update',
    'PATCH',
    `/api/admin/users/${MEMBER_ID}`,
    'anonymous',
    401,
    'Unauthorized',
    { body: { username: 'not-updated' } },
  ),
  boundary(
    'member admin user update forbidden',
    'PATCH',
    `/api/admin/users/${MEMBER_ID}`,
    'member',
    403,
    'Forbidden',
    { body: { username: 'not-updated' } },
  ),
  boundary(
    'admin user update missing body',
    'PATCH',
    `/api/admin/users/${MEMBER_ID}`,
    'admin',
    400,
    'Validation Error',
  ),
  boundary(
    'admin user update null body',
    'PATCH',
    `/api/admin/users/${MEMBER_ID}`,
    'admin',
    400,
    'Validation Error',
    { body: null },
  ),
  boundary(
    'admin user update array body',
    'PATCH',
    `/api/admin/users/${MEMBER_ID}`,
    'admin',
    400,
    'Validation Error',
    { body: [] },
  ),
  boundary(
    'admin user update malformed JSON',
    'PATCH',
    `/api/admin/users/${MEMBER_ID}`,
    'admin',
    400,
    'Bad Request',
    { rawBody: '{"username":', contentType: 'application/json' },
  ),
  boundary(
    'admin user update empty object',
    'PATCH',
    `/api/admin/users/${MEMBER_ID}`,
    'admin',
    400,
    'Validation Error',
    { body: {} },
  ),
  boundary(
    'admin user update unknown-only object',
    'PATCH',
    `/api/admin/users/${MEMBER_ID}`,
    'admin',
    400,
    'Validation Error',
    { body: { unknown: true } },
  ),
  boundary(
    'admin user update null fields',
    'PATCH',
    `/api/admin/users/${MEMBER_ID}`,
    'admin',
    400,
    'Validation Error',
    {
      body: {
        username: null,
        email: null,
        password: null,
        isAdmin: null,
        isActive: null,
      },
    },
  ),
  boundary(
    'admin user update invalid field types',
    'PATCH',
    `/api/admin/users/${MEMBER_ID}`,
    'admin',
    400,
    'Validation Error',
    {
      body: {
        username: 1,
        email: true,
        password: [],
        isAdmin: 'false',
        isActive: 0,
      },
    },
  ),
  boundary(
    'admin user update transformed bounds',
    'PATCH',
    `/api/admin/users/${MEMBER_ID}`,
    'admin',
    400,
    'Validation Error',
    {
      body: {
        username: '   ',
        email: ' USER@example.test ',
        password: 'short',
      },
    },
  ),
  boundary(
    'admin user update invalid coerced path',
    'PATCH',
    '/api/admin/users/not-a-number',
    'admin',
    500,
    'Server Error',
    { body: { username: 'valid-name' } },
  ),
  boundary(
    'admin user update accepts hexadecimal path',
    'PATCH',
    '/api/admin/users/0x5f5e0ff',
    'admin',
    404,
    'User not found',
    { body: { username: 'valid-name' } },
  ),
  boundary(
    'admin user update accepts decimal integer path',
    'PATCH',
    '/api/admin/users/99999999.0',
    'admin',
    404,
    'User not found',
    { body: { username: 'valid-name' } },
  ),
  boundary(
    'admin user update accepts scientific integer path',
    'PATCH',
    '/api/admin/users/9.9999999e7',
    'admin',
    404,
    'User not found',
    { body: { username: 'valid-name' } },
  ),
  boundary(
    'admin user update rejects non-positive path',
    'PATCH',
    '/api/admin/users/0',
    'admin',
    500,
    'Server Error',
    { body: { username: 'valid-name' } },
  ),
  boundary(
    'admin user update rejects fractional path',
    'PATCH',
    '/api/admin/users/1.5',
    'admin',
    500,
    'Server Error',
    { body: { username: 'valid-name' } },
  ),
  boundary(
    'admin user update rejects unsafe integer path',
    'PATCH',
    '/api/admin/users/9007199254740992',
    'admin',
    500,
    'Server Error',
    { body: { username: 'valid-name' } },
  ),
  boundary(
    'admin user update missing user',
    'PATCH',
    '/api/admin/users/99999999',
    'admin',
    404,
    'User not found',
    { body: { username: 'valid-name' } },
  ),
  boundary(
    'admin user update duplicate email uses Node server error contract',
    'PATCH',
    `/api/admin/users/${MEMBER_ID}`,
    'admin',
    500,
    'Server Error',
    { body: { email: ADMIN_EMAIL } },
  ),
  boundary(
    'admin user update duplicate username uses Node server error contract',
    'PATCH',
    `/api/admin/users/${MEMBER_ID}`,
    'admin',
    500,
    'Server Error',
    { body: { username: ADMIN_USERNAME } },
  ),
  boundary(
    'admin cannot demote own account',
    'PATCH',
    `/api/admin/users/${ADMIN_ID}`,
    'admin',
    400,
    'You cannot demote or disable your own account',
    { body: { isAdmin: false } },
  ),
  boundary(
    'admin cannot disable own account',
    'PATCH',
    `/api/admin/users/${ADMIN_ID}`,
    'admin',
    400,
    'You cannot demote or disable your own account',
    { body: { isActive: false } },
  ),
  boundary(
    'anonymous admin user delete',
    'DELETE',
    `/api/admin/users/${MEMBER_ID}`,
    'anonymous',
    401,
    'Unauthorized',
  ),
  boundary(
    'member admin user delete forbidden',
    'DELETE',
    `/api/admin/users/${MEMBER_ID}`,
    'member',
    403,
    'Forbidden',
  ),
  boundary(
    'admin user delete invalid coerced path',
    'DELETE',
    '/api/admin/users/not-a-number',
    'admin',
    500,
    'Server Error',
  ),
  boundary(
    'admin user delete accepts hexadecimal path',
    'DELETE',
    '/api/admin/users/0x5f5e0ff',
    'admin',
    404,
    'User not found',
  ),
  boundary(
    'admin user delete missing user',
    'DELETE',
    '/api/admin/users/99999999',
    'admin',
    404,
    'User not found',
  ),
  boundary(
    'admin cannot delete own account',
    'DELETE',
    `/api/admin/users/${ADMIN_ID}`,
    'admin',
    400,
    'You cannot delete your own account',
  ),
])

export function parseAdminUsersVerifierOptions(argv = process.argv.slice(2)) {
  const options = {
    baseURL: DEFAULT_ADMIN_USERS_BASE_URL,
    nodeURL: undefined,
    goURL: undefined,
    adminCookie: DEFAULT_ADMIN_USERS_ADMIN_COOKIE,
    memberCookie: DEFAULT_ADMIN_USERS_MEMBER_COOKIE,
    prefix: DEFAULT_ADMIN_USERS_PREFIX,
    timeoutMs: 15_000,
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (argument === '--base' && value) {
      options.baseURL = value
      index++
    } else if (argument === '--node' && value) {
      options.nodeURL = value
      index++
    } else if (argument === '--go' && value) {
      options.goURL = value
      index++
    } else if (argument === '--admin-cookie' && value) {
      options.adminCookie = value
      index++
    } else if (argument === '--member-cookie' && value) {
      options.memberCookie = value
      index++
    } else if (argument === '--prefix' && value) {
      options.prefix = value
      index++
    } else if (argument === '--timeout-ms' && value) {
      options.timeoutMs = Number.parseInt(value, 10)
      index++
    } else if (argument === '--help' || argument === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`)
    }
  }
  options.baseURL = normalizeBaseURL(options.baseURL)
  options.nodeURL = normalizeBaseURL(options.nodeURL || options.baseURL)
  options.goURL = normalizeBaseURL(
    options.goURL || joinBackendURL(options.baseURL, '/__lab/go'),
  )
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer')
  }
  if (!options.prefix.trim()) throw new Error('--prefix cannot be empty')
  return options
}

export async function verifyDualAdminUsers({
  fetchImpl = fetch,
  boundaryCases = ADMIN_USER_BOUNDARY_CASES,
  ...rawOptions
} = {}) {
  const options = {
    ...parseAdminUsersVerifierOptions([]),
    ...rawOptions,
    fetchImpl,
  }
  const summary = {
    ok: false,
    base: options.baseURL,
    nodeURL: options.nodeURL,
    goURL: options.goURL,
    routeIds: [...ADMIN_USER_ROUTE_IDS],
    checks: [],
    cleanup: [],
  }
  const state = {
    originalProvider: undefined,
    userIDs: new Set(),
    albumIDs: new Set(),
    sessionCookies: new Set(),
  }

  try {
    state.originalProvider = await readProvider(options, summary)
    await setProvider(options, summary, 'node')

    await comparePair(options, summary, {
      name: 'admin user list',
      kind: 'read',
      method: 'GET',
      path: USERS_PATH,
      cookie: 'admin',
      expectedStatus: 200,
    })

    for (const testCase of boundaryCases) {
      await comparePair(options, summary, { ...testCase, kind: 'boundary' })
    }

    for (const creator of PROVIDERS) {
      await verifyLifecycle(options, summary, state, creator)
    }
    summary.ok = true
  } catch (error) {
    summary.errors = [errorMessage(error)]
  } finally {
    await cleanupAdminUsers(options, summary, state)
  }

  summary.total = summary.checks.length
  summary.failed = summary.checks.filter((check) => check.ok === false).length
  if (summary.errors?.length && summary.failed === 0) summary.failed = 1
  if (summary.cleanup.some((entry) => entry.ok === false)) summary.ok = false
  return summary
}

async function verifyLifecycle(options, summary, state, creator) {
  const other = otherProvider(creator)
  const suffix = randomUUID().slice(0, 8)
  const rawUsername = `  ${options.prefix}_${creator}_${suffix}  `
  const username = rawUsername.trim()
  const rawEmail = `${options.prefix}-${creator}-${suffix}@EXAMPLE.TEST`
  const email = rawEmail.toLowerCase()
  const password = 'DualUsers123!'
  const updatedUsername =
    `${options.prefix}_${creator}_${suffix}_updated`.slice(0, 64)
  const updatedEmail = `${options.prefix}-${creator}-${suffix}-updated@example.test`
  const updatedPassword = 'DualUsers456!'

  await setProvider(options, summary, creator)
  const created = await requestOne(options, summary, {
    name: `admin user create via ${creator}`,
    kind: 'lifecycle',
    method: 'POST',
    path: USERS_PATH,
    cookie: 'admin',
    expectedBackend: creator,
    body: {
      username: rawUsername,
      email: rawEmail,
      password,
      ignored: 'stripped by the Node Zod object contract',
    },
  })
  const userID = requirePositiveInteger(
    created.body?.id,
    created.name,
    'body.id',
  )
  state.userIDs.add(userID)
  expectExactKeys(created.name, created.body, USER_MUTATION_KEYS)
  expectEqual(created.name, created.body.username, username, 'body.username')
  expectEqual(created.name, created.body.email, email, 'body.email')
  expectEqual(created.name, created.body.isAdmin, 0, 'body.isAdmin')
  expectEqual(created.name, created.body.isActive, true, 'body.isActive')

  await setProvider(options, summary, other)
  const afterCreate = await requestOne(options, summary, {
    name: `admin user list via ${other} after ${creator} create`,
    kind: 'lifecycle',
    method: 'GET',
    path: USERS_PATH,
    cookie: 'admin',
    expectedBackend: other,
  })
  const createdListUser = requireUser(afterCreate, userID)
  expectExactKeys(afterCreate.name, createdListUser, USER_LIST_KEYS)
  expectEqual(
    afterCreate.name,
    createdListUser.username,
    username,
    'user.username',
  )
  expectEqual(afterCreate.name, createdListUser.email, email, 'user.email')
  expectEqual(
    afterCreate.name,
    createdListUser.photoCount,
    0,
    'user.photoCount',
  )
  expectEqual(
    afterCreate.name,
    createdListUser.albumCount,
    0,
    'user.albumCount',
  )

  const initialLogin = await requestOne(options, summary, {
    name: `temporary user login via ${other} after ${creator} create`,
    kind: 'lifecycle',
    method: 'POST',
    path: '/api/login',
    cookie: 'anonymous',
    expectedBackend: other,
    expectedStatus: 201,
    expectedContentType: '',
    expectedBody: null,
    expectSetCookie: true,
    body: { email, password },
  })
  const initialSession = requireSessionCookie(initialLogin)
  state.sessionCookies.add(initialSession)

  await setProvider(options, summary, creator)
  const album = await requestOne(options, summary, {
    name: `temporary user album create via ${creator}`,
    kind: 'lifecycle',
    method: 'POST',
    path: '/api/albums',
    cookie: initialSession,
    expectedBackend: creator,
    body: {
      title: `${options.prefix}-owned-${creator}-${suffix}`,
      description: 'ownership transfer fixture for admin user deletion',
      isHidden: true,
    },
  })
  const albumID = requirePositiveInteger(album.body?.id, album.name, 'body.id')
  state.albumIDs.add(albumID)

  await setProvider(options, summary, other)
  const updated = await requestOne(options, summary, {
    name: `admin user update via ${other}`,
    kind: 'lifecycle',
    method: 'PATCH',
    path: `/api/admin/users/${userID}`,
    cookie: 'admin',
    expectedBackend: other,
    body: {
      username: `  ${updatedUsername}  `,
      email: updatedEmail.toUpperCase(),
      password: updatedPassword,
      isAdmin: true,
      isActive: true,
      ignored: true,
    },
  })
  expectExactKeys(updated.name, updated.body, USER_MUTATION_KEYS)
  expectEqual(
    updated.name,
    updated.body.username,
    updatedUsername,
    'body.username',
  )
  expectEqual(updated.name, updated.body.email, updatedEmail, 'body.email')
  expectEqual(updated.name, updated.body.isAdmin, 1, 'body.isAdmin')
  expectEqual(updated.name, updated.body.isActive, true, 'body.isActive')

  await setProvider(options, summary, creator)
  await requestOne(options, summary, {
    name: `old password rejected via ${creator}`,
    kind: 'lifecycle',
    method: 'POST',
    path: '/api/login',
    cookie: 'anonymous',
    expectedBackend: creator,
    expectedStatus: 401,
    expectedStatusMessage: 'Server Error',
    body: { email: updatedEmail, password },
  })

  await setProvider(options, summary, other)
  const updatedLogin = await requestOne(options, summary, {
    name: `updated password accepted via ${other}`,
    kind: 'lifecycle',
    method: 'POST',
    path: '/api/login',
    cookie: 'anonymous',
    expectedBackend: other,
    expectedStatus: 201,
    expectedContentType: '',
    expectedBody: null,
    expectSetCookie: true,
    body: { email: updatedEmail, password: updatedPassword },
  })
  const updatedSession = requireSessionCookie(updatedLogin)
  state.sessionCookies.add(updatedSession)

  await setProvider(options, summary, creator)
  await requestOne(options, summary, {
    name: `administrator delete rejected via ${creator}`,
    kind: 'boundary',
    method: 'DELETE',
    path: `/api/admin/users/${userID}`,
    cookie: 'admin',
    expectedBackend: creator,
    expectedStatus: 400,
    expectedStatusMessage:
      'Demote the administrator before deleting the account',
  })

  await setProvider(options, summary, other)
  const demoted = await requestOne(options, summary, {
    name: `admin user demote via ${other}`,
    kind: 'lifecycle',
    method: 'PATCH',
    path: `/api/admin/users/${userID}`,
    cookie: 'admin',
    expectedBackend: other,
    body: { isAdmin: false },
  })
  expectEqual(demoted.name, demoted.body?.isAdmin, 0, 'body.isAdmin')

  await setProvider(options, summary, creator)
  const disabled = await requestOne(options, summary, {
    name: `admin user disable via ${creator}`,
    kind: 'lifecycle',
    method: 'PATCH',
    path: `/api/admin/users/${userID}`,
    cookie: 'admin',
    expectedBackend: creator,
    body: { isActive: false },
  })
  expectEqual(disabled.name, disabled.body?.isActive, false, 'body.isActive')

  await setProvider(options, summary, other)
  const afterDisable = await requestOne(options, summary, {
    name: `admin user list via ${other} after disable`,
    kind: 'lifecycle',
    method: 'GET',
    path: USERS_PATH,
    cookie: 'admin',
    expectedBackend: other,
  })
  const disabledListUser = requireUser(afterDisable, userID)
  expectEqual(afterDisable.name, disabledListUser.isAdmin, 0, 'user.isAdmin')
  expectEqual(
    afterDisable.name,
    disabledListUser.isActive,
    false,
    'user.isActive',
  )
  expectEqual(
    afterDisable.name,
    disabledListUser.albumCount,
    1,
    'user.albumCount',
  )

  await setProvider(options, summary, creator)
  await requestOne(options, summary, {
    name: `admin user delete via ${creator}`,
    kind: 'lifecycle',
    method: 'DELETE',
    path: `/api/admin/users/${userID}`,
    cookie: 'admin',
    expectedBackend: creator,
  })
  state.userIDs.delete(userID)

  await setProvider(options, summary, other)
  const afterDelete = await requestOne(options, summary, {
    name: `admin user list via ${other} after ${creator} delete`,
    kind: 'lifecycle',
    method: 'GET',
    path: USERS_PATH,
    cookie: 'admin',
    expectedBackend: other,
  })
  if (findUser(afterDelete.body, userID)) {
    throw new Error(
      `${afterDelete.name}: deleted user ${userID} is still listed`,
    )
  }

  const transferredAlbum = await requestOne(options, summary, {
    name: `transferred album read via ${other} after user delete`,
    kind: 'lifecycle',
    method: 'GET',
    path: `/api/albums/${albumID}`,
    cookie: 'admin',
    expectedBackend: other,
  })
  expectEqual(
    transferredAlbum.name,
    transferredAlbum.body?.ownerUserId,
    ADMIN_ID,
    'body.ownerUserId',
  )

  await setProvider(options, summary, 'node')
  await requestOne(options, summary, {
    name: `temporary transferred album delete after ${creator} lifecycle`,
    kind: 'cleanup-check',
    method: 'DELETE',
    path: `/api/albums/${albumID}`,
    cookie: 'admin',
    expectedBackend: 'node',
  })
  state.albumIDs.delete(albumID)

  await comparePair(options, summary, {
    name: `deleted user session rejected after ${creator} lifecycle`,
    kind: 'boundary',
    method: 'GET',
    path: '/api/profile',
    cookie: updatedSession,
    expectedStatus: 401,
    expectedStatusMessage: 'Unauthorized',
    expectedSetCookie: true,
  })
}

async function comparePair(options, summary, testCase) {
  const requestID = `dual-admin-users-${randomUUID()}`
  const [node, go] = await Promise.all([
    fetchResponse(options, {
      ...testCase,
      baseURL: options.nodeURL,
      expectedBackend: 'node',
      requestID,
    }),
    fetchResponse(options, {
      ...testCase,
      baseURL: options.goURL,
      expectedBackend: 'go',
      requestID,
    }),
  ])
  const differences = validateAdminUserPair(testCase, node, go)
  const result = {
    name: testCase.name,
    kind: testCase.kind,
    method: testCase.method,
    path: testCase.path,
    ok: differences.length === 0,
    node: summarizeResponse(node),
    go: summarizeResponse(go),
    differences,
  }
  summary.checks.push(result)
  if (!result.ok) {
    throw new Error(
      `${testCase.name}: ${differences.map(formatDifference).join('; ')}`,
    )
  }
  return { node, go }
}

export function validateAdminUserPair(testCase, node, go) {
  const differences = []
  compareValue(differences, 'node.status', node.status, testCase.expectedStatus)
  compareValue(differences, 'go.status', go.status, testCase.expectedStatus)
  compareValue(differences, 'node.backend', node.backend, 'node')
  compareValue(differences, 'go.backend', go.backend, 'go')
  compareValue(
    differences,
    'contentType',
    normalizeContentType(node.contentType),
    normalizeContentType(go.contentType),
  )
  compareValue(
    differences,
    'node.requestId',
    node.responseRequestID,
    node.requestID,
  )
  compareValue(differences, 'go.requestId', go.responseRequestID, go.requestID)
  const expectedSetCookie = testCase.expectedSetCookie ?? false
  compareValue(differences, 'node.setCookie', node.setCookie, expectedSetCookie)
  compareValue(differences, 'go.setCookie', go.setCookie, expectedSetCookie)
  compareValue(differences, 'location', node.location, go.location)
  compareValue(
    differences,
    'body',
    canonicalize(normalizePairBody(node.body)),
    canonicalize(normalizePairBody(go.body)),
  )
  if (testCase.expectedStatusMessage) {
    compareValue(
      differences,
      'node.statusMessage',
      node.body?.statusMessage,
      testCase.expectedStatusMessage,
    )
    compareValue(
      differences,
      'go.statusMessage',
      go.body?.statusMessage,
      testCase.expectedStatusMessage,
    )
  }
  return differences
}

async function requestOne(options, summary, request) {
  const response = await fetchResponse(options, {
    ...request,
    baseURL:
      request.baseURL ||
      (request.expectedBackend === 'go' ? options.goURL : options.nodeURL),
    requestID: `dual-admin-users-${randomUUID()}`,
  })
  const differences = []
  compareValue(
    differences,
    'status',
    response.status,
    request.expectedStatus ?? 200,
  )
  compareValue(
    differences,
    'backend',
    response.backend,
    request.expectedBackend,
  )
  compareValue(
    differences,
    'contentType',
    normalizeContentType(response.contentType),
    request.expectedContentType ?? 'application/json',
  )
  compareValue(
    differences,
    'requestId',
    response.responseRequestID,
    response.requestID,
  )
  if (request.expectSetCookie === true) {
    compareValue(differences, 'setCookie', response.setCookie, true)
  } else {
    compareValue(differences, 'setCookie', response.setCookie, false)
  }
  if (request.expectedStatusMessage) {
    compareValue(
      differences,
      'statusMessage',
      response.body?.statusMessage,
      request.expectedStatusMessage,
    )
  }
  if (Object.hasOwn(request, 'expectedBody')) {
    compareValue(differences, 'body', response.body, request.expectedBody)
  }
  const result = {
    name: request.name,
    kind: request.kind || 'lifecycle',
    method: request.method,
    path: request.path,
    ok: differences.length === 0,
    result: summarizeResponse(response),
    differences,
  }
  summary.checks.push(result)
  if (!result.ok) {
    throw new Error(
      `${request.name}: ${differences.map(formatDifference).join('; ')}`,
    )
  }
  response.name = request.name
  return response
}

async function fetchResponse(options, request) {
  const headers = {
    Accept: 'application/json',
    'X-Request-Id': request.requestID,
  }
  const cookie = resolveCookie(options, request.cookie)
  if (cookie) headers.Cookie = cookie
  let body
  if (Object.hasOwn(request, 'rawBody')) {
    body = request.rawBody
    headers['Content-Type'] = request.contentType || 'application/json'
  } else if (Object.hasOwn(request, 'body')) {
    body = JSON.stringify(request.body)
    headers['Content-Type'] = request.contentType || 'application/json'
  }
  const response = await options.fetchImpl(
    joinBackendURL(request.baseURL, request.path),
    {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: 'manual',
    },
  )
  const text = await response.text()
  let parsed = text
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      // Preserve non-JSON bodies so the comparison reports the drift.
    }
  } else {
    parsed = null
  }
  const setCookieHeader = response.headers.get('set-cookie')
  return {
    requestID: request.requestID,
    responseRequestID: response.headers.get('x-request-id'),
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend'),
    contentType: response.headers.get('content-type'),
    location: response.headers.get('location'),
    setCookie: Boolean(setCookieHeader),
    setCookieHeader,
    body: parsed,
  }
}

async function readProvider(options, summary) {
  const response = await requestOne(options, summary, {
    name: 'capture original backend provider',
    kind: 'control',
    method: 'GET',
    path: PROVIDER_SETTING_PATH,
    cookie: 'admin',
    expectedBackend: 'node',
  })
  const provider = response.body?.value
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unsupported backend provider: ${String(provider)}`)
  }
  return provider
}

async function setProvider(options, summary, provider) {
  const response = await requestOne(options, summary, {
    name: `switch provider to ${provider}`,
    kind: 'control',
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    cookie: 'admin',
    expectedBackend: 'node',
    body: { value: provider },
  })
  expectEqual(response.name, response.body?.value, provider, 'body.value')
}

async function cleanupAdminUsers(options, summary, state) {
  const cleanup = async (name, action) => {
    try {
      await action()
      summary.cleanup.push({ name, ok: true })
    } catch (error) {
      summary.cleanup.push({ name, ok: false, message: errorMessage(error) })
    }
  }

  await cleanup('force Node provider for cleanup', async () => {
    await cleanupRequest(options, 'PUT', PROVIDER_SETTING_PATH, {
      value: 'node',
    })
  })

  for (const userID of [...state.userIDs]) {
    await cleanup(`normalize temporary user ${userID}`, async () => {
      const response = await cleanupRequest(
        options,
        'PATCH',
        `/api/admin/users/${userID}`,
        { isAdmin: false, isActive: true },
      )
      if (![200, 404].includes(response.status)) {
        throw new Error(`unexpected status ${response.status}`)
      }
    })
    await cleanup(`delete temporary user ${userID}`, async () => {
      const response = await cleanupRequest(
        options,
        'DELETE',
        `/api/admin/users/${userID}`,
      )
      if (![200, 404].includes(response.status)) {
        throw new Error(`unexpected status ${response.status}`)
      }
    })
  }

  for (const albumID of [...state.albumIDs]) {
    await cleanup(`delete transferred temporary album ${albumID}`, async () => {
      const response = await cleanupRequest(
        options,
        'DELETE',
        `/api/albums/${albumID}`,
      )
      if (![200, 404].includes(response.status)) {
        throw new Error(`unexpected status ${response.status}`)
      }
    })
  }

  for (const cookie of state.sessionCookies) {
    await cleanup('revoke temporary user session', async () => {
      const response = await cleanupRequest(
        options,
        'DELETE',
        '/api/_auth/session',
        undefined,
        cookie,
      )
      if (response.status >= 500) {
        throw new Error(`unexpected status ${response.status}`)
      }
    })
  }

  if (state.originalProvider) {
    await cleanup(
      `restore backend provider to ${state.originalProvider}`,
      async () => {
        await cleanupRequest(options, 'PUT', PROVIDER_SETTING_PATH, {
          value: state.originalProvider,
        })
      },
    )
  }
}

async function cleanupRequest(options, method, path, body, cookie) {
  const headers = {
    Accept: 'application/json',
    Cookie: cookie || options.adminCookie,
    'X-Request-Id': `dual-admin-users-cleanup-${randomUUID()}`,
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return options.fetchImpl(joinBackendURL(options.nodeURL, path), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(options.timeoutMs),
    redirect: 'manual',
  })
}

function boundary(
  name,
  method,
  path,
  cookie,
  expectedStatus,
  expectedStatusMessage,
  options = {},
) {
  return Object.freeze({
    name,
    method,
    path,
    cookie,
    expectedStatus,
    expectedStatusMessage,
    ...options,
  })
}

function validCreateBody(suffix) {
  return {
    username: `dual-user-${suffix}`,
    email: `dual-user-${suffix}@example.test`,
    password: 'DualUsers123!',
  }
}

function normalizePairBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const normalized = structuredClone(body)
  delete normalized.url
  delete normalized.stack
  return normalized
}

function normalizeContentType(value) {
  return String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
}

function normalizeBaseURL(value) {
  return String(value).replace(/\/+$/, '')
}

function resolveCookie(options, cookie) {
  if (!cookie || cookie === 'anonymous') return ''
  if (cookie === 'admin') return options.adminCookie
  if (cookie === 'member') return options.memberCookie
  return cookie
}

function otherProvider(provider) {
  return provider === 'node' ? 'go' : 'node'
}

function findUser(body, userID) {
  return Array.isArray(body)
    ? body.find((user) => user?.id === userID)
    : undefined
}

function requireUser(response, userID) {
  const user = findUser(response.body, userID)
  if (!user) throw new Error(`${response.name}: user ${userID} is missing`)
  return user
}

function requirePositiveInteger(value, name, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

function requireSessionCookie(response) {
  const match = response.setCookieHeader?.match(/(?:^|,\s*)cf_session=([^;]+)/)
  if (!match) throw new Error(`${response.name}: cf_session cookie is missing`)
  return `cf_session=${match[1]}`
}

function expectExactKeys(name, value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name}: response must be an object`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (!valuesEqual(actual, expected)) {
    throw new Error(
      `${name}: response keys ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    )
  }
}

function expectEqual(name, actual, expected, field) {
  if (!valuesEqual(actual, expected)) {
    throw new Error(
      `${name}: ${field} ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    )
  }
}

function compareValue(differences, field, actual, expected) {
  if (!valuesEqual(actual, expected)) {
    differences.push({ field, actual, expected })
  }
}

function valuesEqual(actual, expected) {
  return (
    JSON.stringify(canonicalize(actual)) ===
    JSON.stringify(canonicalize(expected))
  )
}

function summarizeResponse(response) {
  return {
    status: response.status,
    backend: response.backend,
    contentType: normalizeContentType(response.contentType),
  }
}

function formatDifference(difference) {
  return `${difference.field}=${JSON.stringify(difference.actual)} expected ${JSON.stringify(difference.expected)}`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function printHelp() {
  console.log(`Usage: node scripts/verify-dual-admin-users.mjs [options]

Options:
  --base <url>            Gateway base URL (default: ${DEFAULT_ADMIN_USERS_BASE_URL})
  --node <url>            Node comparison surface (default: --base)
  --go <url>              Go comparison surface (default: <base>/__lab/go)
  --admin-cookie <value>  Administrator Cookie header
  --member-cookie <value> Member Cookie header
  --prefix <value>        Prefix for temporary users and albums
  --timeout-ms <number>   Per-request timeout (default: 15000)
`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const result = await verifyDualAdminUsers(
      parseAdminUsersVerifierOptions(process.argv.slice(2)),
    )
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok || result.failed > 0) process.exitCode = 1
  } catch (error) {
    console.error(errorMessage(error))
    process.exitCode = 1
  }
}
