import { getRequestHeader, type H3Event } from 'h3'

export type BackendProvider = 'node' | 'go'

export interface GoRoute {
  readonly id: string
  readonly method: string
  readonly path: string
  readonly requiresPublicScope: boolean
}

export type GoReadRoute = GoRoute

/**
 * The Node process remains the public gateway. Once the administrator selects
 * Go, every route in this explicit registry is proxied to the independent Go
 * service. Keeping the registry data-driven prevents a newly added handler
 * from being exposed accidentally.
 */
export const GO_API_ROUTES: ReadonlyArray<GoRoute> = [
  ['access.config.read', 'GET', '/api/access/config'],
  ['access.config.update', 'PUT', '/api/access/config'],
  ['access.status.read', 'GET', '/api/access/status'],
  ['access.verify', 'POST', '/api/access/verify'],
  ['admin.users.list', 'GET', '/api/admin/users'],
  ['admin.users.create', 'POST', '/api/admin/users'],
  ['admin.users.update', 'PATCH', '/api/admin/users/{id}'],
  ['admin.users.delete', 'DELETE', '/api/admin/users/{id}'],
  ['albums.list', 'GET', '/api/albums'],
  ['albums.create', 'POST', '/api/albums'],
  ['albums.reorder', 'PUT', '/api/albums/reorder'],
  ['albums.detail', 'GET', '/api/albums/{albumId}'],
  ['albums.update', 'PUT', '/api/albums/{albumId}'],
  ['albums.delete', 'DELETE', '/api/albums/{albumId}'],
  ['albums.photos.remove', 'DELETE', '/api/albums/{albumId}/photos/{photoId}'],
  ['photos.list', 'GET', '/api/photos'],
  ['photos.create', 'POST', '/api/photos'],
  ['photos.visible', 'GET', '/api/photos/visible'],
  ['photos.map', 'GET', '/api/photos/map'],
  ['photos.status', 'GET', '/api/photos/status'],
  ['photos.update', 'PUT', '/api/photos/{photoId}'],
  ['photos.delete', 'DELETE', '/api/photos/{photoId}'],
  ['photos.albums.read', 'GET', '/api/photos/{photoId}/albums'],
  ['photos.albums.update', 'PUT', '/api/photos/{photoId}/albums'],
  ['photos.livephoto.read', 'GET', '/api/photos/{photoId}/livephoto'],
  ['photos.reactions.read', 'GET', '/api/photos/{photoId}/reactions'],
  ['photos.reactions.create', 'POST', '/api/photos/{photoId}/reactions'],
  ['photos.reactions.delete', 'DELETE', '/api/photos/{photoId}/reactions'],
  ['photos.reactions.list', 'GET', '/api/photos/reactions'],
  ['photos.albums.bulk-update', 'PUT', '/api/photos/albums'],
  ['photos.duplicate.check', 'POST', '/api/photos/check-duplicate'],
  ['photos.exif.reindex', 'POST', '/api/photos/exif/reindex'],
  ['photos.upload', 'PUT', '/api/photos/upload'],
  ['photos.livephoto.manage', 'POST', '/api/photos/livephoto/manage'],
  ['identity.profile', 'GET', '/api/profile'],
  ['identity.github.callback', 'GET', '/api/auth/github'],
  ['identity.login', 'POST', '/api/login'],
  ['identity.logout', 'GET', '/api/logout'],
  ['identity.session.read', 'GET', '/api/_auth/session'],
  ['identity.session.delete', 'DELETE', '/api/_auth/session'],
  ['queue.add-task', 'POST', '/api/queue/add-task'],
  ['queue.add-tasks', 'POST', '/api/queue/add-tasks'],
  ['queue.task-stats', 'GET', '/api/queue/stats/{taskId}'],
  ['queue.stats', 'GET', '/api/queue/stats'],
  ['queue.tasks.list', 'GET', '/api/queue/task/list'],
  ['queue.clear', 'DELETE', '/api/queue/task/clear'],
  ['queue.retry-batch', 'POST', '/api/queue/task/retry-batch'],
  ['queue.retry', 'POST', '/api/queue/task/retry'],
  ['settings.namespace.read', 'GET', '/api/system/settings/{namespace}'],
  ['settings.key.read', 'GET', '/api/system/settings/{namespace}/{key}'],
  ['settings.key.update', 'PUT', '/api/system/settings/{namespace}/{key}'],
  ['settings.public.read', 'GET', '/api/system/settings/all'],
  ['settings.batch.update', 'PUT', '/api/system/settings/batch'],
  ['settings.fields', 'GET', '/api/system/settings/fields'],
  ['settings.schema', 'GET', '/api/system/settings/schema'],
  [
    'settings.storage-config.list',
    'GET',
    '/api/system/settings/storage-config',
  ],
  [
    'settings.storage-config.create',
    'POST',
    '/api/system/settings/storage-config',
  ],
  [
    'settings.storage-config.read',
    'GET',
    '/api/system/settings/storage-config/{id}',
  ],
  [
    'settings.storage-config.update',
    'PUT',
    '/api/system/settings/storage-config/{id}',
  ],
  [
    'settings.storage-config.delete',
    'DELETE',
    '/api/system/settings/storage-config/{id}',
  ],
  ['upload-shares.list', 'GET', '/api/upload-shares'],
  ['upload-shares.create', 'POST', '/api/upload-shares'],
  ['upload-shares.update', 'PATCH', '/api/upload-shares/{id}'],
  ['upload-shares.delete', 'DELETE', '/api/upload-shares/{id}'],
  ['upload-shares.public.read', 'GET', '/api/upload-shares/public/{token}'],
  [
    'upload-shares.public.prepare',
    'POST',
    '/api/upload-shares/public/{token}/prepare',
  ],
  [
    'upload-shares.public.task',
    'POST',
    '/api/upload-shares/public/{token}/task',
  ],
  [
    'upload-shares.public.upload',
    'PUT',
    '/api/upload-shares/public/{token}/upload',
  ],
  ['wizard.schema', 'GET', '/api/wizard/schema'],
  ['wizard.admin', 'POST', '/api/wizard/admin'],
  ['wizard.complete', 'POST', '/api/wizard/complete'],
  ['wizard.map', 'POST', '/api/wizard/map'],
  ['wizard.site', 'POST', '/api/wizard/site'],
  ['wizard.storage', 'POST', '/api/wizard/storage'],
  ['wizard.submit', 'POST', '/api/wizard/submit'],
  ['system.stats', 'GET', '/api/system/stats'],
  ['system.logs', 'GET', '/api/system/logs'],
  ['system.backup.run', 'POST', '/api/system/backup/run'],
  ['media.image', 'GET', '/image/{key...}'],
  ['media.image.head', 'HEAD', '/image/{key...}'],
  ['media.storage', 'GET', '/storage/{path...}'],
  ['media.storage.head', 'HEAD', '/storage/{path...}'],
  ['media.display', 'GET', '/display/{photoId}'],
  ['media.thumbnail', 'GET', '/thumb/{thumbnailUrl...}'],
  ['media.og', 'GET', '/og-media/{photoId}'],
  ['media.share-og', 'GET', '/share-og/{photoId}.png'],
].map(([id, method, path]) => ({
  id,
  method,
  path,
  requiresPublicScope: false,
}))

const LEGACY_GO_READ_ROUTE_IDS = [
  'access.config.read',
  'settings.public.read',
  'admin.users.list',
  'albums.list',
  'albums.detail',
  'access.status.read',
  'identity.profile',
  'photos.list',
  'photos.visible',
  'photos.map',
  'photos.status',
  'photos.albums.read',
  'photos.livephoto.read',
  'photos.reactions.read',
  'photos.reactions.list',
  'queue.task-stats',
  'queue.stats',
  'queue.tasks.list',
  'settings.namespace.read',
  'settings.key.read',
  'settings.fields',
  'settings.schema',
  'settings.storage-config.list',
  'settings.storage-config.read',
  'upload-shares.list',
  'upload-shares.public.read',
  'system.stats',
] as const

export const GO_READ_ROUTES: ReadonlyArray<GoReadRoute> =
  LEGACY_GO_READ_ROUTE_IDS.map((id) =>
    GO_API_ROUTES.find((route) => route.id === id)!,
  )

const goRouteMap = new Map(
  GO_API_ROUTES.map((route) => [`${route.method} ${route.path}`, route]),
)

export function normalizeBackendProvider(value: unknown): BackendProvider {
  return value === 'go' ? 'go' : 'node'
}

export function resolveGoUpstream(
  environment: Record<string, string | undefined> = process.env,
): URL | null {
  const raw = environment.CFRAME_GO_UPSTREAM?.trim()
  if (!raw) return null

  let upstream: URL
  try {
    upstream = new URL(raw)
  } catch {
    throw new Error('CFRAME_GO_UPSTREAM must be an absolute http(s) URL')
  }

  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error('CFRAME_GO_UPSTREAM must use http or https')
  }
  if (upstream.username || upstream.password) {
    throw new Error('CFRAME_GO_UPSTREAM must not contain credentials')
  }
  if (upstream.search || upstream.hash) {
    throw new Error(
      'CFRAME_GO_UPSTREAM must not contain query or fragment data',
    )
  }

  // Keep a possible deployment prefix (for example /__lab/go) while
  // normalizing the trailing slash so request paths join deterministically.
  upstream.pathname = upstream.pathname.replace(/\/+$/, '')
  return upstream
}

export function resolveGoReadRoute(
  path: string,
  searchParams?: URLSearchParams,
): GoReadRoute | null {
  const route =
    goRouteMap.get(`GET ${path}`) ||
    GO_READ_ROUTES.filter((candidate) =>
      matchesRoutePath(candidate.path, path),
    ).sort(
      (left, right) =>
        routeSpecificity(right.path) - routeSpecificity(left.path),
    )[0]
  if (!route) return null
  if (route.requiresPublicScope && searchParams?.get('scope') === 'manage') {
    return null
  }
  return route
}

export function resolveGoRoute(
  method: string,
  path: string,
  searchParams?: URLSearchParams,
): GoRoute | null {
  const normalizedMethod = method.toUpperCase()
  const route =
    goRouteMap.get(`${normalizedMethod} ${path}`) ||
    GO_API_ROUTES.filter(
      (candidate) =>
        candidate.method === normalizedMethod &&
        matchesRoutePath(candidate.path, path),
    ).sort(
      (left, right) =>
        routeSpecificity(right.path) - routeSpecificity(left.path),
    )[0]
  if (!route) return null
  if (route.requiresPublicScope && searchParams?.get('scope') === 'manage') {
    return null
  }
  return route
}

function routeSpecificity(pattern: string): number {
  return pattern
    .split('/')
    .filter((segment) => segment !== '' && !segment.startsWith('{')).length
}

function matchesRoutePath(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/')
  const pathSegments = path.split('/')
  const catchAllIndex = patternSegments.findIndex((segment) =>
    segment.endsWith('...}'),
  )
  if (catchAllIndex >= 0) {
    if (pathSegments.length < catchAllIndex + 1) return false
  } else if (patternSegments.length !== pathSegments.length) {
    return false
  }
  return patternSegments.every((segment, index) => {
    if (segment.endsWith('...}')) {
      return pathSegments.slice(index).some(Boolean)
    }
    return matchesRouteSegment(segment, pathSegments[index] ?? '')
  })
}

function matchesRouteSegment(
  patternSegment: string,
  pathSegment: string,
): boolean {
  if (patternSegment === pathSegment) return true
  if (!pathSegment || !patternSegment.includes('{')) return false

  const expressionParts: string[] = ['^']
  let cursor = 0
  for (const match of patternSegment.matchAll(/\{[^}]+\}/g)) {
    expressionParts.push(
      escapeRouteExpression(patternSegment.slice(cursor, match.index)),
      '[^/]+',
    )
    cursor = (match.index ?? 0) + match[0].length
  }
  expressionParts.push(escapeRouteExpression(patternSegment.slice(cursor)), '$')
  return new RegExp(expressionParts.join('')).test(pathSegment)
}

function escapeRouteExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function shouldDispatchReadToGo(input: {
  method: string
  path: string
  provider: unknown
  searchParams?: URLSearchParams
}): boolean {
  return (
    input.method.toUpperCase() === 'GET' &&
    normalizeBackendProvider(input.provider) === 'go' &&
    resolveGoReadRoute(input.path, input.searchParams) !== null
  )
}

type GoReadyBody = {
  status?: string
  checks?: Record<string, string>
}

export async function assertGoBackendReadyForSwitch(event: H3Event) {
  let upstream: URL | null = null
  try {
    upstream = resolveGoUpstream()
  } catch (error) {
    throw new Error((error as Error).message)
  }

  if (!upstream) {
    throw new Error('Go backend is not configured')
  }

  const target = joinGoUpstreamURL(upstream, '/health/ready')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3_000)
  try {
    const response = await fetch(target, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'X-Request-Id': getRequestHeader(event, 'x-request-id') || '',
      },
    })
    const body = (await response.json().catch(() => null)) as GoReadyBody | null
    const checks = body?.checks || {}
    const missingChecks = ['database', 'mediaTools', 'redis'].filter(
      (name) => checks[name] !== 'ok',
    )

    if (!response.ok || body?.status !== 'ready' || missingChecks.length) {
      const reason = missingChecks.length
        ? `Go backend readiness checks failed: ${missingChecks.join(', ')}`
        : `Go backend readiness returned HTTP ${response.status}`
      throw new Error(reason)
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Cannot switch to Go backend: ${error.message}`)
    }
    throw new Error('Cannot switch to Go backend: readiness request failed')
  } finally {
    clearTimeout(timeout)
  }
}

export function shouldDispatchToGo(input: {
  method: string
  path: string
  provider: unknown
  searchParams?: URLSearchParams
}): boolean {
  return (
    normalizeBackendProvider(input.provider) === 'go' &&
    resolveGoRoute(input.method, input.path, input.searchParams) !== null
  )
}

export function joinGoUpstreamURL(
  upstream: URL,
  path: string,
  search = '',
): URL {
  const target = new URL(upstream.toString())
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const prefix = upstream.pathname.replace(/\/+$/, '')
  target.pathname = `${prefix}${normalizedPath}` || '/'
  target.search = search
  return target
}
