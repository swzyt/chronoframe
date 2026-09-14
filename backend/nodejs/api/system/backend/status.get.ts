import { readBackendProviderForDispatch } from '#server/utils/backend-provider-setting'
import {
  joinGoUpstreamURL,
  resolveGoUpstream,
} from '#server/utils/backend-routing'

type GoReadyBody = {
  status?: string
  checks?: Record<string, string>
  schema?: {
    migrationCount?: number
    latestMigrationMillis?: number
  }
}

export default eventHandler(async (event) => {
  await requireAdmin(event)

  const currentProvider = readBackendProviderForDispatch()
  const response = {
    currentProvider,
    node: {
      status: 'ready',
      owned: currentProvider === 'node',
    },
    go: {
      configured: false,
      status: 'not_configured',
      owned: currentProvider === 'go',
      upstream: '',
      checks: {} as Record<string, string>,
      schema: null as GoReadyBody['schema'] | null,
      error: '',
    },
  }

  let upstream: URL | null = null
  try {
    upstream = resolveGoUpstream()
  } catch (error) {
    response.go.error = (error as Error).message
    return response
  }
  if (!upstream) {
    return response
  }

  response.go.configured = true
  response.go.upstream = publicGoUpstreamLabel(upstream)
  const target = joinGoUpstreamURL(upstream, '/health/ready')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3_000)
  try {
    const readyResponse = await fetch(target, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'X-Request-Id': getRequestHeader(event, 'x-request-id') || '',
      },
    })
    const body = (await readyResponse
      .json()
      .catch(() => null)) as GoReadyBody | null
    response.go.status =
      readyResponse.ok && body?.status === 'ready' ? 'ready' : 'not_ready'
    response.go.checks = body?.checks || {}
    response.go.schema = body?.schema || null
    if (!readyResponse.ok && !response.go.error) {
      response.go.error = `Go readiness returned HTTP ${readyResponse.status}`
    }
  } catch (error) {
    response.go.status = 'unreachable'
    response.go.error =
      error instanceof Error ? error.message : 'Go readiness request failed'
  } finally {
    clearTimeout(timeout)
  }

  return response
})

function publicGoUpstreamLabel(upstream: URL) {
  const value = new URL(upstream.toString())
  value.username = ''
  value.password = ''
  value.search = ''
  value.hash = ''
  return value.toString()
}
