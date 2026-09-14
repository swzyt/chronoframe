import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { assertSharedStateEnvironment } from './shared-state-contract'
import { sharedStateEnvironment } from './shared-session'
import { useSharedRedis } from './shared-redis'

export const DEFAULT_RUNTIME_LEASE_TTL_MS = 30_000

export type RuntimeLeaseActor = 'pipeline-consumer' | 'backup-scheduler'
export type RuntimeLeaseOwner = 'node' | 'go'

const RUNTIME_LEASE_ACTORS = new Set<RuntimeLeaseActor>([
  'pipeline-consumer',
  'backup-scheduler',
])
const RUNTIME_LEASE_OWNERS = new Set<RuntimeLeaseOwner>(['node', 'go'])

export interface RuntimeLeaseHandle {
  key: string
  value: string
  acquired: boolean
  enabled: boolean
  release(): Promise<void>
}

interface RuntimeLeaseOptions {
  actor: RuntimeLeaseActor
  owner: RuntimeLeaseOwner
  ttlMs?: number
  onLost?: (reason: unknown) => void | Promise<void>
}

const REFRESH_RUNTIME_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`

const RELEASE_RUNTIME_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

export function runtimeLeaseKey(
  actor: RuntimeLeaseActor,
  environment = sharedStateEnvironment(),
) {
  assertRuntimeLeaseActor(actor)
  return `cf:v1:${assertSharedStateEnvironment(environment)}:lease:${actor}`
}

export function runtimeLeaseValue(
  owner: RuntimeLeaseOwner,
  instance = `${hostname()}:${process.pid}:${randomUUID()}`,
) {
  assertRuntimeLeaseOwner(owner)
  return JSON.stringify({
    schemaVersion: 1,
    owner,
    instance,
    acquiredAt: Date.now(),
  })
}

function assertRuntimeLeaseActor(actor: string): asserts actor is RuntimeLeaseActor {
  if (!RUNTIME_LEASE_ACTORS.has(actor as RuntimeLeaseActor)) {
    throw new Error(`Unsupported runtime lease actor: ${actor}`)
  }
}

function assertRuntimeLeaseOwner(owner: string): asserts owner is RuntimeLeaseOwner {
  if (!RUNTIME_LEASE_OWNERS.has(owner as RuntimeLeaseOwner)) {
    throw new Error(`Unsupported runtime lease owner: ${owner}`)
  }
}

export async function acquireRuntimeLease({
  actor,
  owner,
  ttlMs = DEFAULT_RUNTIME_LEASE_TTL_MS,
  onLost,
}: RuntimeLeaseOptions): Promise<RuntimeLeaseHandle> {
  const key = runtimeLeaseKey(actor)
  const value = runtimeLeaseValue(owner)
  const redis = await useSharedRedis()
  if (!redis) {
    return {
      key,
      value,
      acquired: true,
      enabled: false,
      async release() {},
    }
  }

  const acquired = await redis.set(key, value, {
    NX: true,
    PX: ttlMs,
  })

  if (acquired !== 'OK') {
    return {
      key,
      value,
      acquired: false,
      enabled: true,
      async release() {},
    }
  }

  let closed = false
  const refreshInterval = setInterval(async () => {
    if (closed) return
    try {
      const refreshed = await redis.eval(REFRESH_RUNTIME_LEASE_SCRIPT, {
        keys: [key],
        arguments: [value, String(ttlMs)],
      })
      if (refreshed !== 1 && refreshed !== true) {
        closed = true
        clearInterval(refreshInterval)
        await onLost?.(new Error(`Runtime lease ${key} was lost`))
      }
    } catch (error) {
      closed = true
      clearInterval(refreshInterval)
      await onLost?.(error)
    }
  }, Math.max(1_000, Math.floor(ttlMs / 3)))
  refreshInterval.unref?.()

  return {
    key,
    value,
    acquired: true,
    enabled: true,
    async release() {
      if (closed) return
      closed = true
      clearInterval(refreshInterval)
      await redis.eval(RELEASE_RUNTIME_LEASE_SCRIPT, {
        keys: [key],
        arguments: [value],
      })
    },
  }
}
