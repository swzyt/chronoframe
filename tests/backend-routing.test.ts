import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  GO_API_ROUTES,
  GO_READ_ROUTES,
  joinGoUpstreamURL,
  normalizeBackendProvider,
  resolveGoRoute,
  resolveGoReadRoute,
  resolveGoUpstream,
  shouldDispatchReadToGo,
} from '../backend/nodejs/utils/backend-routing'

const routeManifest = JSON.parse(
  readFileSync(new URL('../backend/contracts/routes.yaml', import.meta.url)),
)
const goAppSource = readFileSync(
  new URL('../backend/go/internal/app/app.go', import.meta.url),
  'utf8',
)
const goRouteMethodSource = readFileSync(
  new URL('../backend/go/internal/app/route_methods.go', import.meta.url),
  'utf8',
)

const semanticRoutePath = (path: string) =>
  path.replaceAll(/\{([^}]+)\.\.\.\}/g, '{$1}')

const goHTTPMethodNames: Record<string, string> = {
  Delete: 'DELETE',
  Get: 'GET',
  Patch: 'PATCH',
  Post: 'POST',
  Put: 'PUT',
}

const implementationRoutePath = (path: string) => {
  const normalized = path
    .replaceAll(/\{[^}]+\.\.\.\}/g, '{...}')
    .replaceAll(/\{[^}]+\}/g, '{}')
  return normalized === '/share-og/{}' ? '/share-og/{}.png' : normalized
}

function collectGoRouteMethodWrappers(): Map<string, string[]> {
  const handlers = new Map<string, string[]>()
  for (const match of goRouteMethodSource.matchAll(
    /func \(a \*Application\) (\w+)\(w http\.ResponseWriter, r \*http\.Request\) \{([\s\S]*?)\n\}/g,
  )) {
    const methods = new Set<string>()
    for (const caseMatch of match[2].matchAll(/case\s+([^:]+):/g)) {
      for (const methodMatch of caseMatch[1].matchAll(/http\.Method(\w+)/g)) {
        const method = goHTTPMethodNames[methodMatch[1]]
        if (method) methods.add(method)
      }
    }
    handlers.set(match[1], [...methods].sort())
  }
  return handlers
}

function collectGoMuxRoutes(): Set<string> {
  const wrapperMethods = collectGoRouteMethodWrappers()
  const routes = new Set<string>()
  const unmappedHandlers: string[] = []

  for (const line of goAppSource.split('\n')) {
    const pathMatch = /mux\.HandleFunc\("([^"]+)"/.exec(line)
    if (!pathMatch) continue

    const path = pathMatch[1]
    const methodMatch =
      /application\.method\(http\.Method(\w+)/.exec(line) ||
      /writeJSONMethod\(http\.Method(\w+)/.exec(line)

    if (methodMatch) {
      const method = goHTTPMethodNames[methodMatch[1]]
      if (method) routes.add(`${method} ${implementationRoutePath(path)}`)
      continue
    }

    if (/application\.readObjectMethod\(/.test(line)) {
      routes.add(`GET ${implementationRoutePath(path)}`)
      routes.add(`HEAD ${implementationRoutePath(path)}`)
      continue
    }

    const wrapperMatch = /mux\.HandleFunc\("[^"]+", application\.(\w+)\)/.exec(
      line,
    )
    if (!wrapperMatch) continue
    if (path === '/') continue

    const methods = wrapperMethods.get(wrapperMatch[1])
    if (!methods) {
      unmappedHandlers.push(`${path} -> ${wrapperMatch[1]}`)
      continue
    }
    for (const method of methods) {
      routes.add(`${method} ${implementationRoutePath(path)}`)
    }
  }

  assert.deepEqual(unmappedHandlers, [])
  return routes
}

test('legacy Go read comparison allowlist stays explicit and side-effect free', () => {
  assert.deepEqual(
    GO_READ_ROUTES.map(({ id, path }) => ({ id, path })),
    [
      { id: 'access.config.read', path: '/api/access/config' },
      { id: 'settings.public.read', path: '/api/system/settings/all' },
      { id: 'admin.users.list', path: '/api/admin/users' },
      { id: 'albums.list', path: '/api/albums' },
      { id: 'albums.detail', path: '/api/albums/{albumId}' },
      { id: 'access.status.read', path: '/api/access/status' },
      { id: 'identity.profile', path: '/api/profile' },
      { id: 'photos.list', path: '/api/photos' },
      { id: 'photos.visible', path: '/api/photos/visible' },
      { id: 'photos.map', path: '/api/photos/map' },
      { id: 'photos.status', path: '/api/photos/status' },
      { id: 'photos.albums.read', path: '/api/photos/{photoId}/albums' },
      { id: 'photos.livephoto.read', path: '/api/photos/{photoId}/livephoto' },
      { id: 'photos.reactions.read', path: '/api/photos/{photoId}/reactions' },
      { id: 'photos.reactions.list', path: '/api/photos/reactions' },
      { id: 'queue.task-stats', path: '/api/queue/stats/{taskId}' },
      { id: 'queue.stats', path: '/api/queue/stats' },
      { id: 'queue.tasks.list', path: '/api/queue/task/list' },
      {
        id: 'settings.namespace.read',
        path: '/api/system/settings/{namespace}',
      },
      {
        id: 'settings.key.read',
        path: '/api/system/settings/{namespace}/{key}',
      },
      { id: 'settings.fields', path: '/api/system/settings/fields' },
      { id: 'settings.schema', path: '/api/system/settings/schema' },
      {
        id: 'settings.storage-config.list',
        path: '/api/system/settings/storage-config',
      },
      {
        id: 'settings.storage-config.read',
        path: '/api/system/settings/storage-config/{id}',
      },
      { id: 'upload-shares.list', path: '/api/upload-shares' },
      {
        id: 'upload-shares.public.read',
        path: '/api/upload-shares/public/{token}',
      },
      { id: 'system.stats', path: '/api/system/stats' },
    ],
  )
})

test('Go read comparison allowlist matches the route contract', () => {
  const manifestComparableReadRouteIds = routeManifest.routes
    .filter(
      (route: { method: string; sideEffect: string; allowCompare: boolean }) =>
        route.method === 'GET' &&
        route.sideEffect === 'none' &&
        route.allowCompare,
    )
    .map((route: { id: string }) => route.id)
    .sort()

  assert.deepEqual(
    GO_READ_ROUTES.map((route) => route.id).sort(),
    manifestComparableReadRouteIds,
  )
})

test('backend provider normalization fails closed to Node', () => {
  assert.equal(normalizeBackendProvider('go'), 'go')
  assert.equal(normalizeBackendProvider('node'), 'node')
  assert.equal(normalizeBackendProvider('unexpected'), 'node')
  assert.equal(normalizeBackendProvider(undefined), 'node')
})

test('Go upstream validation rejects credentials and non-http schemes', () => {
  assert.equal(resolveGoUpstream({}), null)
  assert.equal(
    resolveGoUpstream({ CFRAME_GO_UPSTREAM: 'http://go:8080/' })?.href,
    'http://go:8080/',
  )
  assert.throws(
    () =>
      resolveGoUpstream({
        CFRAME_GO_UPSTREAM: 'http://user:pass@go:8080',
      }),
    /must not contain credentials/,
  )
  assert.throws(
    () =>
      resolveGoUpstream({
        CFRAME_GO_UPSTREAM: 'file:///tmp/go',
      }),
    /must use http or https/,
  )
})

test('album management reads dispatch to the complete Go management handler', () => {
  assert.ok(resolveGoReadRoute('/api/albums'))
  assert.equal(
    resolveGoReadRoute('/api/albums', new URLSearchParams('scope=manage'))?.id,
    'albums.list',
  )
  assert.equal(
    shouldDispatchReadToGo({
      method: 'GET',
      path: '/api/albums',
      provider: 'go',
      searchParams: new URLSearchParams('scope=manage'),
    }),
    true,
  )
})

test('parameterized album detail routes are matched without broad API wildcards', () => {
  assert.equal(resolveGoReadRoute('/api/albums/42')?.id, 'albums.detail')
  assert.equal(
    resolveGoReadRoute('/api/albums/not-a-number')?.id,
    'albums.detail',
  )
  assert.equal(resolveGoReadRoute('/api/albums/'), null)
  assert.equal(resolveGoReadRoute('/api/albums/42/photos/1'), null)
})

test('parameterized photo read routes are matched independently', () => {
  assert.equal(
    resolveGoReadRoute('/api/photos/photo-1/albums')?.id,
    'photos.albums.read',
  )
  assert.equal(
    resolveGoReadRoute('/api/photos/photo-1/livephoto')?.id,
    'photos.livephoto.read',
  )
  assert.equal(
    resolveGoReadRoute('/api/photos/photo-1/reactions')?.id,
    'photos.reactions.read',
  )
  assert.equal(
    resolveGoReadRoute('/api/photos/reactions')?.id,
    'photos.reactions.list',
  )
  assert.equal(resolveGoReadRoute('/api/photos//albums'), null)
  assert.equal(resolveGoReadRoute('/api/photos/photo-1/albums/extra'), null)
})

test('dispatch requires GET, Go selection, and a registered route', () => {
  assert.equal(
    shouldDispatchReadToGo({
      method: 'GET',
      path: '/api/albums',
      provider: 'go',
    }),
    true,
  )
  assert.equal(
    shouldDispatchReadToGo({
      method: 'POST',
      path: '/api/albums',
      provider: 'go',
    }),
    false,
  )
  assert.equal(
    shouldDispatchReadToGo({
      method: 'GET',
      path: '/api/photos',
      provider: 'go',
    }),
    true,
  )
  assert.equal(
    shouldDispatchReadToGo({
      method: 'GET',
      path: '/api/photos',
      provider: 'go',
      searchParams: new URLSearchParams('scope=manage'),
    }),
    true,
  )
})

test('complete Go registry matches mutations as well as reads', () => {
  assert.equal(resolveGoRoute('POST', '/api/albums')?.id, 'albums.create')
  assert.equal(
    resolveGoRoute('PUT', '/api/albums/reorder')?.id,
    'albums.reorder',
  )
  assert.equal(resolveGoRoute('DELETE', '/api/albums/42')?.id, 'albums.delete')
  assert.equal(
    resolveGoRoute('PUT', '/api/photos/photo-1')?.id,
    'photos.update',
  )
  assert.equal(resolveGoRoute('POST', '/api/login')?.id, 'identity.login')
  assert.equal(
    resolveGoRoute('PATCH', '/api/admin/users/1')?.id,
    'admin.users.update',
  )
  assert.equal(
    resolveGoRoute('HEAD', '/image/demo.png')?.id,
    'media.image.head',
  )
  assert.equal(
    resolveGoRoute('HEAD', '/storage/users/1/demo.png')?.id,
    'media.storage.head',
  )
  assert.equal(resolveGoRoute('GET', '/api/queue/stats')?.id, 'queue.stats')
  assert.equal(
    resolveGoRoute('POST', '/api/system/backup/run')?.id,
    'system.backup.run',
  )
  assert.equal(resolveGoRoute('POST', '/api/not-registered'), null)
})

test('complete Go registry covers every Go-capable non-runtime HTTP operation in the route contract', () => {
  const goRoutes = new Set(
    GO_API_ROUTES.map(
      (route) => `${route.method} ${semanticRoutePath(route.path)}`,
    ),
  )
  const manifestRoutes = routeManifest.routes.filter(
    (route: { sourceType: string; maturity?: Record<string, string> }) =>
      route.sourceType !== 'virtual' && route.maturity?.go,
  )
  assert.equal(goRoutes.size, manifestRoutes.length)
  for (const route of manifestRoutes) {
    assert.ok(
      goRoutes.has(`${route.method} ${semanticRoutePath(route.path)}`),
      `${route.method} ${route.path} is missing from GO_API_ROUTES`,
    )
  }
})

test('Go HTTP mux registers every route exposed to the admin backend switch', () => {
  const muxRoutes = collectGoMuxRoutes()
  const exposedRoutes = GO_API_ROUTES.map(
    (route) => `${route.method} ${implementationRoutePath(route.path)}`,
  ).sort()
  const missingRoutes = exposedRoutes.filter((route) => !muxRoutes.has(route))

  assert.equal(new Set(exposedRoutes).size, exposedRoutes.length)
  assert.deepEqual(missingRoutes, [])
})

test('specific settings routes win over generic parameterized settings routes', () => {
  assert.equal(
    resolveGoReadRoute('/api/system/settings/fields')?.id,
    'settings.fields',
  )
  assert.equal(
    resolveGoReadRoute('/api/system/settings/storage-config')?.id,
    'settings.storage-config.list',
  )
  assert.equal(
    resolveGoReadRoute('/api/system/settings/storage-config/1')?.id,
    'settings.storage-config.read',
  )
  assert.equal(
    resolveGoReadRoute('/api/system/settings/system/backend.readProvider')?.id,
    'settings.key.read',
  )
})

test('route matching respects static suffixes on parameterized segments', () => {
  assert.equal(
    resolveGoRoute('GET', '/share-og/dual-fixture-photo-1.png')?.id,
    'media.share-og',
  )
  assert.equal(resolveGoRoute('GET', '/share-og/dual-fixture-photo-1'), null)
})

test('upstream joining preserves deployment prefixes and query strings', () => {
  const upstream = resolveGoUpstream({
    CFRAME_GO_UPSTREAM: 'http://gateway:80/__lab/go/',
  })
  assert.ok(upstream)
  assert.equal(
    joinGoUpstreamURL(upstream, '/api/albums', '?scope=public&limit=10').href,
    'http://gateway/__lab/go/api/albums?scope=public&limit=10',
  )
})

test('upstream joining does not create a double slash at the service root', () => {
  const upstream = resolveGoUpstream({
    CFRAME_GO_UPSTREAM: 'http://go:8080',
  })
  assert.ok(upstream)
  assert.equal(
    joinGoUpstreamURL(upstream, '/api/albums').href,
    'http://go:8080/api/albums',
  )
})
