import type { _Object, S3ClientConfig } from '@aws-sdk/client-s3'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type {
  StorageObject,
  StorageProvider,
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

      const resp = await this.client.send(cmd)

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
      const absoluteKey = key.replace(/^\/+/, '')
      const cmd = new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
      })

      await this.client.send(cmd)
      this.logger?.success(`Deleted object with key: ${absoluteKey}`)
    } catch (error) {
      this.logger?.error(`Failed to delete object with key: ${key}`, error)
      throw error
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const absoluteKey = key.replace(/^\/+/, '')
      const cmd = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
      })

      const resp = await this.client.send(cmd)

      if (!resp.Body) {
        return null
      }

      if (resp.Body instanceof Buffer) {
        return resp.Body
      }

      const chunks: Uint8Array[] = []
      const stream = resp.Body as NodeJS.ReadableStream

      return new Promise<Buffer>((resolve, reject) => {
        stream.on('data', (chunk: Uint8Array) => {
          chunks.push(chunk)
        })

        stream.on('end', () => {
          resolve(Buffer.concat(chunks))
        })

        stream.on('error', (err) => {
          reject(err)
        })
      })
    } catch {
      return null
    }
  }

  getPublicUrl(key: string): string {
    const { cdnUrl, bucket, region, endpoint } = this.config
    const absoluteKey = key.replace(/^\/+/, '')

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
    const absoluteKey = key.replace(/^\/+/, '')
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

  async getFileMeta(key: string): Promise<StorageObject | null> {
    try {
      const absoluteKey = key.replace(/^\/+/, '')
      const cmd = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: absoluteKey,
      })

      const resp = await this.client.send(cmd)

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
      if ((error as any).$metadata?.httpStatusCode === 404) {
        return null
      }
      this.logger?.error(`Failed to get metadata for key: ${key}`, error)
      throw error
    }
  }

  async listAll(): Promise<StorageObject[]> {
    const cmd = new ListObjectsCommand({
      Bucket: this.config.bucket,
      Prefix: this.config.prefix,
      MaxKeys: this.config.maxKeys,
    })

    const resp = await this.client.send(cmd)
    this.logger?.log(resp.Contents?.map(convertToStorageObject))
    return resp.Contents?.map(convertToStorageObject) || []
  }

  async listImages(): Promise<StorageObject[]> {
    const cmd = new ListObjectsCommand({
      Bucket: this.config.bucket,
      Prefix: this.config.prefix,
      MaxKeys: this.config.maxKeys,
    })

    const resp = await this.client.send(cmd)
    // TODO: filter supported image format
    return resp.Contents?.map(convertToStorageObject) || []
  }
}
