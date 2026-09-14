import type { _Object, S3ClientConfig } from '@aws-sdk/client-s3'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type {
  StorageObject,
  StorageProvider,
  StorageReadOptions,
  UploadOptions,
} from '../interfaces'

const createClient = (config: S3StorageConfig): S3Client => {
  if (config.provider !== 's3') {
    throw new Error('Invalid provider for S3 client creation')
  }

  const { accessKeyId, secretAccessKey, region, endpoint } = config
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Missing required accessKeyId or secretAccessKey')
  }

  const isTencentCos = endpoint?.includes('myqcloud.com')
  const clientConfig: S3ClientConfig = {
    endpoint,
    region,
    maxAttempts: 2,
    // Tencent COS buckets created after 2024-01-01 no longer support
    // path-style domains (`cos.<region>.myqcloud.com/<bucket>/<key>`).
    // Always use virtual-hosted-style for COS even if a stale config still has
    // forcePathStyle enabled.
    forcePathStyle: isTencentCos ? false : config.forcePathStyle,
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  }

  return new S3Client(clientConfig)
}

const DEFAULT_S3_TIMEOUT_MS = 30_000

const isObjectNotFoundError = (error: unknown) => {
  const err = error as any
  return err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey'
}

const isAbortError = (error: unknown) => {
  return (error as Error | undefined)?.name === 'AbortError'
}

const sliceIgnoredRangeResponse = (
  data: Buffer,
  start: number,
  end: number,
): Buffer | null => {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  if (start < 0 || end < start || start >= data.length) return null
  return data.subarray(start, Math.min(end + 1, data.length))
}

const convertToStorageObject = (s3object: _Object): StorageObject => {
  return {
    key: s3object.Key || '',
    size: s3object.Size,
    lastModified: s3object.LastModified,
    etag: s3object.ETag,
  }
}

export class S3StorageProvider implements StorageProvider {
  config: S3StorageConfig
  private logger?: Logger['storage']
  private client: S3Client

  constructor(config: S3StorageConfig, logger?: Logger['storage']) {
    this.config = config
    this.logger = logger
    this.client = createClient(config)
  }

  private async sendWithTimeout<T>(
    cmd: any,
    operation: string,
    options: StorageReadOptions = {},
    timeoutMs = DEFAULT_S3_TIMEOUT_MS,
  ): Promise<T> {
    const controller = new AbortController()
    let timedOut = false
    const forwardAbort = () => {
      controller.abort(options.signal?.reason)
    }
    if (options.signal?.aborted) {
      forwardAbort()
    } else {
      options.signal?.addEventListener('abort', forwardAbort, { once: true })
    }
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    try {
      return (await this.client.send(cmd, {
        abortSignal: controller.signal,
      })) as T
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown S3 provider error'
      if (isObjectNotFoundError(error)) {
        this.logger?.debug?.(`S3 ${operation} not found: ${message}`)
      } else {
        this.logger?.error(
          timedOut
            ? `S3 ${operation} timed out after ${timeoutMs}ms: ${message}`
            : isAbortError(error)
              ? `S3 ${operation} aborted: ${message}`
              : `S3 ${operation} failed: ${message}`,
          error,
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', forwardAbort)
    }
  }

  private async readBodyStream(
    stream: NodeJS.ReadableStream,
    key: string,
    options: StorageReadOptions = {},
    timeoutMs = DEFAULT_S3_TIMEOUT_MS,
  ): Promise<Buffer> {
    const chunks: Uint8Array[] = []

    return await new Promise<Buffer>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        const error = new Error(
          `Timed out reading S3 object stream for key ${key}`,
        )
        if ('destroy' in stream && typeof stream.destroy === 'function') {
          stream.destroy(error)
        }
        finish(error)
      }, timeoutMs)

      const cleanup = () => {
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', onAbort)
      }

      const finish = (error?: unknown, data?: Buffer) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) {
          reject(error)
          return
        }
        resolve(data || Buffer.alloc(0))
      }

      const onAbort = () => {
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        if ('destroy' in stream && typeof stream.destroy === 'function') {
          stream.destroy(error)
        }
        finish(error)
      }

      if (options.signal?.aborted) {
        onAbort()
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      stream.on('data', (chunk: Uint8Array) => {
        chunks.push(chunk)
      })

      stream.on('end', () => {
        finish(undefined, Buffer.concat(chunks))
      })

      stream.on('error', (err) => {
        this.logger?.error(`S3 stream read failed for key: ${key}`, err)
        finish(err)
      })
    })
  }

  private getAbsoluteKey(key: string): string {
    const normalizedKey = key.replace(/^\/+/, '')
    const normalizedPrefix = (this.config.prefix || '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')

    if (!normalizedPrefix || normalizedKey.startsWith(`${normalizedPrefix}/`)) {
      return normalizedKey
    }

    return `${normalizedPrefix}/${normalizedKey}`
  }

  async create(
    key: string,
    data: Buffer,
    contentType?: string,
  ): Promise<StorageObject> {
    try {
      const absoluteKey = this.getAbsoluteKey(key)
      const cmd = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
        Body: data,
        ContentType: contentType || 'application/octet-stream',
      })

      const resp = await this.sendWithTimeout<any>(
        cmd,
        `put object ${absoluteKey}`,
      )

      this.logger?.success(`Created object with key: ${absoluteKey}`)

      return {
        key: absoluteKey,
        size: data.length,
        lastModified: new Date(),
        etag: resp.ETag,
      }
    } catch (error) {
      this.logger?.error(`Failed to create object with key: ${key}`, error)
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const absoluteKey = this.getAbsoluteKey(key)
      const cmd = new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
      })

      await this.sendWithTimeout(cmd, `delete object ${absoluteKey}`)
      this.logger?.success(`Deleted object with key: ${absoluteKey}`)
    } catch (error) {
      this.logger?.error(`Failed to delete object with key: ${key}`, error)
      throw error
    }
  }

  async get(
    key: string,
    options: StorageReadOptions = {},
  ): Promise<Buffer | null> {
    try {
      const absoluteKey = this.getAbsoluteKey(key)
      const cmd = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
      })

      const resp = await this.sendWithTimeout<any>(
        cmd,
        `get object ${absoluteKey}`,
        options,
      )

      if (!resp.Body) {
        return null
      }

      if (resp.Body instanceof Buffer) {
        return resp.Body
      }

      const stream = resp.Body as NodeJS.ReadableStream
      return await this.readBodyStream(stream, absoluteKey, options)
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      if (!isObjectNotFoundError(error)) {
        this.logger?.error(`Failed to get object with key: ${key}`, error)
      }
      return null
    }
  }

  async getStream(
    key: string,
    options: StorageReadOptions = {},
  ): Promise<NodeJS.ReadableStream | null> {
    try {
      const absoluteKey = this.getAbsoluteKey(key)
      const cmd = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
      })

      const resp = await this.sendWithTimeout<any>(
        cmd,
        `stream object ${absoluteKey}`,
        options,
      )

      if (!resp.Body) {
        return null
      }

      return resp.Body as NodeJS.ReadableStream
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      if (!isObjectNotFoundError(error)) {
        this.logger?.error(`Failed to stream object with key: ${key}`, error)
      }
      return null
    }
  }

  async getRange(
    key: string,
    start: number,
    end: number,
    options: StorageReadOptions = {},
  ): Promise<Buffer | null> {
    try {
      const absoluteKey = this.getAbsoluteKey(key)
      const cmd = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
        Range: `bytes=${start}-${end}`,
      })

      const resp = await this.sendWithTimeout<any>(
        cmd,
        `get object range ${absoluteKey} ${start}-${end}`,
        options,
      )

      if (!resp.Body) {
        return null
      }

      if (resp.Body instanceof Buffer) {
        if (!resp.ContentRange && resp.Body.length !== end - start + 1) {
          return sliceIgnoredRangeResponse(resp.Body, start, end)
        }
        return resp.Body
      }

      const stream = resp.Body as NodeJS.ReadableStream
      const data = await this.readBodyStream(stream, absoluteKey, options)
      if (!resp.ContentRange && data.length !== end - start + 1) {
        return sliceIgnoredRangeResponse(data, start, end)
      }
      return data
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      if (!isObjectNotFoundError(error)) {
        this.logger?.error(`Failed to get object range with key: ${key}`, error)
      }
      return null
    }
  }

  async getRangeStream(
    key: string,
    start: number,
    end: number,
    options: StorageReadOptions = {},
  ): Promise<NodeJS.ReadableStream | null> {
    try {
      const absoluteKey = this.getAbsoluteKey(key)
      const cmd = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
        Range: `bytes=${start}-${end}`,
      })

      const resp = await this.sendWithTimeout<any>(
        cmd,
        `stream object range ${absoluteKey} ${start}-${end}`,
        options,
      )

      if (!resp.Body) {
        return null
      }

      return resp.Body as NodeJS.ReadableStream
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      if (!isObjectNotFoundError(error)) {
        this.logger?.error(
          `Failed to stream object range with key: ${key}`,
          error,
        )
      }
      return null
    }
  }

  getPublicUrl(key: string): string {
    const { cdnUrl, bucket, region, endpoint } = this.config
    const absoluteKey = this.getAbsoluteKey(key)

    // CDN URL
    if (cdnUrl) {
      return `${cdnUrl.replace(/\/$/, '')}/${absoluteKey}`
    }

    // Default AWS S3 endpoint
    if (!endpoint) {
      return `https://${bucket}.s3.${region}.amazonaws.com/${absoluteKey}`
    } else if (endpoint.includes('amazonaws.com')) {
      return `https://${bucket}.s3.${region}.amazonaws.com/${absoluteKey}`
    }

    // Alibaba Cloud OSS
    if (endpoint.includes('aliyuncs.com')) {
      const baseUrl = endpoint.replace(/\/$/, '')
      if (baseUrl.indexOf('//') === -1) {
        throw new Error('Invalid endpoint URL')
      }
      const protocol = baseUrl.split('//')[0]
      const remainder = baseUrl.split('//')[1]
      return `${protocol}//${bucket}.${remainder}/${absoluteKey}`
    }

    // Tencent Cloud COS
    if (endpoint.includes('myqcloud.com')) {
      const baseUrl = endpoint.replace(/\/$/, '')
      if (baseUrl.indexOf('//') === -1) {
        throw new Error('Invalid endpoint URL')
      }
      const protocol = baseUrl.split('//')[0]
      const remainder = baseUrl.split('//')[1]
      return `${protocol}//${bucket}.${remainder}/${absoluteKey}`
    }

    // Custom endpoint
    return `${endpoint.replace(/\/$/, '')}/${bucket}/${absoluteKey}`
  }

  async getSignedUrl(
    key: string,
    expiresIn: number = 3600,
    options?: UploadOptions,
  ): Promise<string> {
    const absoluteKey = this.getAbsoluteKey(key)
    const cmd = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: absoluteKey,
      ContentType: options?.contentType || 'application/octet-stream',
    })

    const url = await getSignedUrl(this.client, cmd, {
      expiresIn,
      // 为了更好的 CORS 支持，添加一些额外参数
      unhoistableHeaders: new Set(['Content-Type']),
    })
    return url
  }

  async getFileMeta(
    key: string,
    options: StorageReadOptions = {},
  ): Promise<StorageObject | null> {
    try {
      const absoluteKey = this.getAbsoluteKey(key)
      const cmd = new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
      })

      const resp = await this.sendWithTimeout<any>(
        cmd,
        `get metadata ${absoluteKey}`,
        options,
      )

      if (!resp.ETag) {
        return null
      }

      return {
        key: absoluteKey,
        size: resp.ContentLength || 0,
        lastModified: resp.LastModified,
        etag: resp.ETag,
      }
    } catch (error) {
      if (isObjectNotFoundError(error)) {
        return null
      }
      this.logger?.error(`Failed to get metadata for key: ${key}`, error)
      throw error
    }
  }

  async listAll(): Promise<StorageObject[]> {
    const cmd = new ListObjectsCommand({
      Bucket: this.config.bucket,
      Prefix: this.getAbsoluteKey(''),
      MaxKeys: this.config.maxKeys,
    })

    const resp = await this.sendWithTimeout<any>(cmd, 'list objects')
    this.logger?.log(resp.Contents?.map(convertToStorageObject))
    return resp.Contents?.map(convertToStorageObject) || []
  }

  async listImages(): Promise<StorageObject[]> {
    const cmd = new ListObjectsCommand({
      Bucket: this.config.bucket,
      Prefix: this.getAbsoluteKey(''),
      MaxKeys: this.config.maxKeys,
    })

    const resp = await this.sendWithTimeout<any>(cmd, 'list images')
    // TODO: filter supported image format
    return resp.Contents?.map(convertToStorageObject) || []
  }
}
