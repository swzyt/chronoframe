import { readFile } from 'node:fs/promises'
import { createClient, type RedisClientType } from 'redis'
import { logger } from './logger'

type SharedRedisClient = RedisClientType

let clientPromise: Promise<SharedRedisClient> | undefined
const redisLogger = logger.dynamic('shared-redis')

export function parseSharedRedisRequired(value: string | undefined) {
  if (value === undefined) return false
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('CFRAME_REDIS_REQUIRED must be true or false')
}

async function redisPassword() {
  const value = process.env.CFRAME_REDIS_PASSWORD
  const file = process.env.CFRAME_REDIS_PASSWORD_FILE
  if (value && file) {
    throw new Error(
      'Set only one of CFRAME_REDIS_PASSWORD and CFRAME_REDIS_PASSWORD_FILE',
    )
  }
  return file ? (await readFile(file, 'utf8')).trim() : value
}

export function isSharedRedisConfigured() {
  return Boolean(process.env.CFRAME_REDIS_URL)
}

export async function useSharedRedis(): Promise<SharedRedisClient | null> {
  const url = process.env.CFRAME_REDIS_URL
  const required = parseSharedRedisRequired(process.env.CFRAME_REDIS_REQUIRED)
  if (!url) {
    if (required) {
      throw new Error(
        'CFRAME_REDIS_URL is required when CFRAME_REDIS_REQUIRED=true',
      )
    }
    return null
  }
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = createClient({
        url,
        username: process.env.CFRAME_REDIS_USERNAME,
        password: await redisPassword(),
        socket: {
          connectTimeout: 5_000,
          reconnectStrategy(retries) {
            return Math.min(100 * 2 ** retries, 3_000)
          },
        },
      })
      client.on('error', (error) => {
        redisLogger.error('Redis client error', error)
      })
      await client.connect()
      await client.ping()
      redisLogger.info('Shared Redis connected')
      return client
    })().catch((error) => {
      clientPromise = undefined
      throw error
    })
  }
  const client = clientPromise
  if (!client) throw new Error('Shared Redis client initialization failed')
  return client
}

export async function closeSharedRedis() {
  const pending = clientPromise
  clientPromise = undefined
  if (!pending) return
  const client = await pending.catch(() => null)
  if (client?.isOpen) await client.close()
}
