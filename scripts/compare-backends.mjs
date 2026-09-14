import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const routeContract = JSON.parse(
  readFileSync(
    new URL('../backend/contracts/routes.yaml', import.meta.url),
    'utf8',
  ),
)

const SAFE_SETTINGS_NAMESPACES = new Set([
  'analytics',
  'app',
  'location',
  'map',
  'privacy',
  'site',
  'storage',
  'system',
])

export const DUAL_BACKEND_COMPARE_FIXTURE = Object.freeze({
  userId: 910_001,
  memberUserId: 910_002,
  albumId: 910_001,
  restrictedAlbumId: 910_002,
  hiddenAlbumId: 910_003,
  photoId: 'dual-fixture-photo-1',
  mutablePhotoId: 'dual-fixture-photo-editable',
  hiddenPhotoId: 'dual-fixture-hidden-photo',
  queueTaskId: 910_001,
  storageProviderId: 910_001,
  uploadShareId: 910_001,
  uploadShareToken: 'dual-backend-fixture-token-20260911',
})

const routePolicies = new Map([
  [
    'albums.list',
    {
      samplePaths: ['/api/albums', '/api/albums?scope=manage'],
    },
  ],
  [
    'albums.detail',
    {
      allowPath: matchesRouteTemplate,
      samplePaths: [`/api/albums/${DUAL_BACKEND_COMPARE_FIXTURE.albumId}`],
    },
  ],
  [
    'photos.list',
    {
      samplePaths: [
        '/api/photos',
        '/api/photos?scope=manage',
        '/api/photos?scope=manage&page=1&pageSize=10',
        '/api/photos?scope=manage&page=1&pageSize=10&metaOnly=true',
        '/api/photos?scope=manage&search=%20dual-fixture%20',
        '/api/photos?scope=manage&search=dual&search=fixture',
        '/api/photos?scope=manage&metaOnly=true&metaOnly=false&page=1',
        '/api/photos?scope=manage&page=2&page=1&pageSize=1',
        '/api/photos?scope=manage&pageSize=1&pageSize=2',
        '/api/photos?scope=manage&mediaType=image&mediaType=video',
        '/api/photos?scope=manage&scope=public',
      ],
    },
  ],
  [
    'photos.map',
    {
      samplePaths: [
        '/api/photos/map',
        '/api/photos/map?west=100&west=-180&east=110&south=-90&north=90',
      ],
    },
  ],
  [
    'photos.albums.read',
    {
      allowPath: matchesRouteTemplate,
      samplePaths: [
        `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/albums`,
      ],
    },
  ],
  [
    'photos.livephoto.read',
    {
      allowPath: matchesRouteTemplate,
      samplePaths: [
        `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/livephoto`,
      ],
    },
  ],
  [
    'photos.reactions.read',
    {
      allowPath: matchesRouteTemplate,
      samplePaths: [
        `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/reactions`,
      ],
    },
  ],
  [
    'photos.reactions.list',
    {
      samplePaths: [
        `/api/photos/reactions?ids=${DUAL_BACKEND_COMPARE_FIXTURE.photoId}`,
      ],
    },
  ],
  [
    'queue.task-stats',
    {
      allowPath: matchesRouteTemplate,
      samplePaths: [
        `/api/queue/stats/${DUAL_BACKEND_COMPARE_FIXTURE.queueTaskId}`,
      ],
    },
  ],
  [
    'queue.stats',
    {
      normalizers: ['/timestamp', '/pool/workers/*/uptime'],
    },
  ],
  [
    'queue.tasks.list',
    {
      samplePaths: [
        '/api/queue/task/list',
        '/api/queue/task/list?status=completed&type=photo',
      ],
    },
  ],
  [
    'settings.namespace.read',
    {
      allowPath: ({ params }) => SAFE_SETTINGS_NAMESPACES.has(params.namespace),
      samplePaths: ['/api/system/settings/system'],
    },
  ],
  [
    'settings.key.read',
    {
      allowPath: ({ params }) => SAFE_SETTINGS_NAMESPACES.has(params.namespace),
      samplePaths: ['/api/system/settings/system/backend.readProvider'],
    },
  ],
  ['settings.public.read', { normalizers: ['/timestamp'] }],
  [
    'settings.fields',
    {
      samplePaths: ['/api/system/settings/fields?namespace=system'],
    },
  ],
  [
    'settings.storage-config.read',
    {
      allowPath: matchesRouteTemplate,
      samplePaths: [
        `/api/system/settings/storage-config/${DUAL_BACKEND_COMPARE_FIXTURE.storageProviderId}`,
      ],
    },
  ],
  [
    'system.stats',
    {
      normalizers: [
        '/timestamp',
        '/uptime',
        '/memory/used',
        '/workerPool/workers/*/uptime',
      ],
    },
  ],
  ['photos.status', { normalizers: ['/timestamp'] }],
  [
    'upload-shares.public.read',
    {
      allowPath: matchesRouteTemplate,
      samplePaths: [
        `/api/upload-shares/public/${DUAL_BACKEND_COMPARE_FIXTURE.uploadShareToken}`,
      ],
    },
  ],
])

const comparableContractRoutes = routeContract.routes.filter(
  (route) =>
    route.method === 'GET' &&
    route.sideEffect === 'none' &&
    route.allowCompare === true,
)

export const COMPARABLE_READ_ROUTES = Object.freeze(
  comparableContractRoutes.map((route) => {
    if (hasRouteParameters(route.path) && !routePolicies.has(route.id)) {
      throw new Error(
        `Comparable route ${route.id} requires an explicit safe path policy`,
      )
    }

    const policy = routePolicies.get(route.id) || {}
    if (hasRouteParameters(route.path) && !Array.isArray(policy.samplePaths)) {
      throw new Error(
        `Comparable route ${route.id} requires explicit sample paths`,
      )
    }

    return Object.freeze({
      id: route.id,
      path: route.path,
      expectedStatus: 200,
      normalizers: Object.freeze([...(policy.normalizers || [])]),
      responseSideEffect: 'none',
      allowPath: policy.allowPath || matchesRouteTemplate,
      samplePaths: Object.freeze([...(policy.samplePaths || [route.path])]),
    })
  }),
)

export const COMPARABLE_READ_ROUTE_SAMPLES = Object.freeze(
  COMPARABLE_READ_ROUTES.flatMap((route) =>
    route.samplePaths.map((path) =>
      Object.freeze({
        id: route.id,
        path,
      }),
    ),
  ),
)

const comparableRoutesBySpecificity = [...COMPARABLE_READ_ROUTES].sort(
  (left, right) => routeSpecificity(right.path) - routeSpecificity(left.path),
)

export function resolveSafeReadPath(path) {
  const pathname = new URL(path, 'http://compare-backends.local').pathname
  for (const route of comparableRoutesBySpecificity) {
    const match = matchRoutePath(route.path, pathname)
    if (match && route.allowPath(match)) return route
  }
  return undefined
}

function hasRouteParameters(pattern) {
  return pattern.includes('{')
}

function routeSpecificity(pattern) {
  return pattern
    .split('/')
    .filter((segment) => segment !== '' && !segment.includes('{')).length
}

function matchesRouteTemplate(match) {
  return Boolean(match)
}

function matchRoutePath(pattern, path) {
  const patternSegments = pattern.split('/')
  const pathSegments = path.split('/')
  const catchAllIndex = patternSegments.findIndex((segment) =>
    /^\{[^/{}]+\.\.\.\}$/.test(segment),
  )
  if (catchAllIndex >= 0) {
    if (pathSegments.length < catchAllIndex + 1) return null
  } else if (patternSegments.length !== pathSegments.length) {
    return null
  }

  const params = {}
  for (let index = 0; index < patternSegments.length; index += 1) {
    const segment = patternSegments[index]
    const value = pathSegments[index]
    const catchAllMatch = segment.match(/^\{([^/{}]+)\.\.\.\}$/)
    if (catchAllMatch) {
      const rest = pathSegments.slice(index).filter(Boolean)
      if (rest.length === 0) return null
      params[catchAllMatch[1]] = rest.join('/')
      return { params }
    }

    const paramMatch = segment.match(/^\{([^/{}]+)\}$/)
    if (paramMatch) {
      if (!value) return null
      params[paramMatch[1]] = value
      continue
    }

    if (segment.includes('{')) {
      const names = []
      const escaped = segment.replace(/\{([^/{}]+)\}/g, (_, name) => {
        names.push(name)
        return '([^/]+)'
      })
      const matcher = new RegExp(`^${escaped.replaceAll('.', '\\.')}$`)
      const embeddedMatch = matcher.exec(value || '')
      if (!embeddedMatch) return null
      names.forEach((name, nameIndex) => {
        params[name] = embeddedMatch[nameIndex + 1]
      })
      continue
    }

    if (segment !== value) return null
  }
  return { params }
}

export function removeJSONPointer(value, pointer) {
  if (pointer === '') return undefined
  const segments = pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
  removeJSONPointerSegments(value, segments)
  return value
}

function removeJSONPointerSegments(cursor, segments) {
  if (segments.length === 0) return
  if (cursor === null || typeof cursor !== 'object') return
  const [segment, ...rest] = segments
  if (segment === '*') {
    if (!Array.isArray(cursor)) return
    for (const item of cursor) {
      removeJSONPointerSegments(item, rest)
    }
    return
  }
  if (rest.length === 0) {
    delete cursor[segment]
    return
  }
  if (!(segment in cursor)) return
  removeJSONPointerSegments(cursor[segment], rest)
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

export function normalizedContentType(value) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || ''
}

export function joinBackendURL(baseURL, requestPath) {
  const base = new URL(baseURL)
  const request = new URL(requestPath, 'http://compare-backends.local')
  const basePath = base.pathname.endsWith('/')
    ? base.pathname.slice(0, -1)
    : base.pathname
  const suffix = request.pathname.startsWith('/')
    ? request.pathname
    : `/${request.pathname}`
  base.pathname = `${basePath}${suffix}` || '/'
  base.search = request.search
  base.hash = ''
  return base
}

export async function compareBackends({
  nodeURL,
  goURL,
  path,
  requestId,
  requestHeaders = {},
  timeoutMs = 5_000,
}) {
  const route = resolveSafeReadPath(path)
  if (!route) {
    throw new Error(`Refusing to compare unapproved route: ${path}`)
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive safe integer')
  }
  const headers = {
    ...requestHeaders,
    'X-Request-Id':
      requestId ||
      requestHeaders['X-Request-Id'] ||
      requestHeaders['x-request-id'] ||
      randomUUID(),
  }
  const [nodeResponse, goResponse] = await Promise.all([
    fetch(joinBackendURL(nodeURL, path), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    }),
    fetch(joinBackendURL(goURL, path), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    }),
  ])
  const [nodeText, goText] = await Promise.all([
    nodeResponse.text(),
    goResponse.text(),
  ])
  const differences = []

  for (const [name, response] of [
    ['node', nodeResponse],
    ['go', goResponse],
  ]) {
    if (response.status !== route.expectedStatus) {
      differences.push({
        field: `${name}.status`,
        expected: route.expectedStatus,
        actual: response.status,
      })
    }
    if (
      route.responseSideEffect === 'none' &&
      response.headers.has('set-cookie')
    ) {
      differences.push({
        field: `${name}.headers.set-cookie`,
        expected: 'absent',
        actual: 'present',
      })
    }
  }

  if (nodeResponse.status !== goResponse.status) {
    differences.push({
      field: 'status',
      node: nodeResponse.status,
      go: goResponse.status,
    })
  }
  const nodeContentType = normalizedContentType(
    nodeResponse.headers.get('content-type'),
  )
  const goContentType = normalizedContentType(
    goResponse.headers.get('content-type'),
  )
  if (nodeContentType !== goContentType) {
    differences.push({
      field: 'headers.content-type',
      node: nodeContentType,
      go: goContentType,
    })
  }
  for (const [name, contentType] of [
    ['node', nodeContentType],
    ['go', goContentType],
  ]) {
    if (contentType !== 'application/json') {
      differences.push({
        field: `${name}.headers.content-type`,
        expected: 'application/json',
        actual: contentType,
      })
    }
  }
  for (const [name, response, expected] of [
    ['node', nodeResponse, 'node'],
    ['go', goResponse, 'go'],
  ]) {
    const backend = response.headers.get('x-chronoframe-backend')
    if (backend !== expected) {
      differences.push({
        field: `${name}.headers.x-chronoframe-backend`,
        expected,
        actual: backend,
      })
    }
    if (response.headers.get('x-request-id') !== headers['X-Request-Id']) {
      differences.push({
        field: `${name}.headers.x-request-id`,
        expected: headers['X-Request-Id'],
        actual: response.headers.get('x-request-id'),
      })
    }
  }

  let nodeBody
  let goBody
  try {
    nodeBody = JSON.parse(nodeText)
    goBody = JSON.parse(goText)
  } catch (error) {
    differences.push({ field: 'body.json', error: String(error) })
  }
  if (nodeBody !== undefined && goBody !== undefined) {
    for (const pointer of route.normalizers) {
      removeJSONPointer(nodeBody, pointer)
      removeJSONPointer(goBody, pointer)
    }
    const canonicalNode = JSON.stringify(canonicalize(nodeBody))
    const canonicalGo = JSON.stringify(canonicalize(goBody))
    if (canonicalNode !== canonicalGo) {
      differences.push({ field: 'body', node: nodeBody, go: goBody })
    }
  }

  return {
    equal: differences.length === 0,
    requestId: headers['X-Request-Id'],
    routeId: route.id,
    path,
    node: {
      status: nodeResponse.status,
      backend: nodeResponse.headers.get('x-chronoframe-backend'),
    },
    go: {
      status: goResponse.status,
      backend: goResponse.headers.get('x-chronoframe-backend'),
    },
    differences,
  }
}

export async function compareComparableReads({
  nodeURL,
  goURL,
  paths = COMPARABLE_READ_ROUTE_SAMPLES.map((sample) => sample.path),
  requestHeaders = {},
  timeoutMs = 5_000,
}) {
  const results = []
  for (const path of paths) {
    results.push(
      await compareBackends({
        nodeURL,
        goURL,
        path,
        requestHeaders,
        timeoutMs,
      }),
    )
  }
  return {
    equal: results.every((result) => result.equal),
    total: results.length,
    failed: results.filter((result) => !result.equal).length,
    results,
  }
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function flag(name) {
  return process.argv.includes(name)
}

async function main() {
  const nodeURL = option('--node')
  const goURL = option('--go')
  const path = option('--path') || '/api/system/settings/all'
  const cookie = option('--cookie')
  const all = flag('--all')
  if (!nodeURL || !goURL) {
    throw new Error(
      'Usage: node scripts/compare-backends.mjs --node <url> --go <url> [--path /api/system/settings/all | --all] [--cookie "cf_session=..."]',
    )
  }
  const requestHeaders = cookie ? { Cookie: cookie } : {}
  const result = all
    ? await compareComparableReads({
        nodeURL,
        goURL,
        requestHeaders,
      })
    : await compareBackends({
        nodeURL,
        goURL,
        path,
        requestHeaders,
      })
  console.log(JSON.stringify(result, null, 2))
  if (!result.equal) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
