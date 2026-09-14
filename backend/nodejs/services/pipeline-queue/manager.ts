import type { ConsolaInstance } from 'consola'
import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'path'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { exiftool } from 'exiftool-vendored'
import type { PipelineQueueItem, Photo } from '#server/utils/db'
import { compressUint8Array } from '~~/shared/utils/u8array'
import {
  preprocessImageWithJpegUpload,
  processImageMetadataAndSharp,
} from '../image/processor'
import {
  generateDisplayImage,
  generateThumbnailAndHash,
} from '../image/thumbnail'
import { extractExifData, extractPhotoInfo } from '../image/exif'
import {
  extractLocationFromGPS,
  parseGPSCoordinates,
} from '../location/geocoding'
import { settingsManager } from '../settings/settingsManager'
import {
  findLivePhotoVideoForImage,
  findPhotoForLivePhotoVideo,
} from '../video/livephoto'
import { processMotionPhotoFromXmp } from '../video/motion-photo'
import { processMp4Video } from '../video/processor'
import { getStorageManager } from '#server/plugins/3.storage'
import { createTempDir } from '#server/utils/temp-dir'
import {
  generateSafePhotoId,
  generateSafePhotoIdWithStorageHash,
} from '#server/utils/file-utils'
import {
  normalizeContentHash,
  sha256Hex,
} from '#server/utils/photo-duplicate'
import {
  enqueuePipelineTask,
  type EnqueuePipelineTaskOptions,
  type PipelineQueuePayload,
} from './repository'

const storageProxyUrl = (key: string) =>
  `/image/${key.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`

const QUEUE_TASK_LEASE_TTL_MS = 10 * 60 * 1000
const QUEUE_TASK_LEASE_REFRESH_MS = QUEUE_TASK_LEASE_TTL_MS / 3

class QueueTaskLeaseLostError extends Error {
  constructor(taskId: number) {
    super(`Queue task ${taskId} lease is no longer held by this worker`)
    this.name = 'QueueTaskLeaseLostError'
  }
}

const resolvePhotoIdForStorageKey = (
  storageKey: string,
  ownerUserId: number,
) => {
  const legacyPhotoId = generateSafePhotoId(storageKey)
  const existingPhoto = useDB()
    .select({
      id: tables.photos.id,
      storageKey: tables.photos.storageKey,
      ownerUserId: tables.photos.ownerUserId,
    })
    .from(tables.photos)
    .where(eq(tables.photos.id, legacyPhotoId))
    .get()

  if (
    !existingPhoto ||
    (existingPhoto.ownerUserId === ownerUserId &&
      existingPhoto.storageKey === storageKey)
  ) {
    return legacyPhotoId
  }

  return generateSafePhotoIdWithStorageHash(storageKey)
}

const EXIF_LOCATION_KEYS = [
  'GPSAltitude',
  'GPSAltitudeRef',
  'GPSLatitude',
  'GPSLatitudeRef',
  'GPSLongitude',
  'GPSLongitudeRef',
  'GPSPosition',
  'GPSDateStamp',
  'GPSTimeStamp',
  'GPSImgDirection',
  'GPSImgDirectionRef',
  'GPSDestBearing',
  'GPSDestBearingRef',
] as const

const stripLocationFromExif = <
  T extends Record<string, any> | null | undefined,
>(
  exif: T,
): T => {
  if (!exif || typeof exif !== 'object') {
    return exif
  }

  const cloned = { ...exif }
  for (const key of EXIF_LOCATION_KEYS) {
    delete cloned[key]
  }

  return cloned as T
}

export class QueueManager {
  private static instances: Map<string, QueueManager> = new Map()
  private workerId: string
  private logger: ConsolaInstance
  private isProcessing: boolean = false
  private processingInterval: NodeJS.Timeout | null = null
  private processingPromise: Promise<void> | null = null
  private processedCount: number = 0
  private errorCount: number = 0
  private startTime: Date

  static getInstance(
    workerId: string = 'default',
    logger?: ConsolaInstance,
  ): QueueManager {
    if (!QueueManager.instances.has(workerId)) {
      QueueManager.instances.set(workerId, new QueueManager(workerId, logger))
    }
    return QueueManager.instances.get(workerId)!
  }

  static getAllInstances(): QueueManager[] {
    return Array.from(QueueManager.instances.values())
  }

  private constructor(workerId: string, _logger?: ConsolaInstance) {
    this.workerId = workerId
    this.logger = _logger
      ? _logger.withTag(`${workerId}`)
      : logger.dynamic(`queue-${workerId}`)
    this.startTime = new Date()
  }

  getWorkerId(): string {
    return this.workerId
  }

  getStats() {
    const uptime = Date.now() - this.startTime.getTime()
    return {
      workerId: this.workerId,
      isProcessing: this.isProcessing,
      processedCount: this.processedCount,
      errorCount: this.errorCount,
      uptime: Math.floor(uptime / 1000), // seconds
      successRate:
        this.processedCount > 0
          ? (this.processedCount / (this.processedCount + this.errorCount)) *
            100
          : 0,
    }
  }

  /**
   * 插入新任务到队列
   * @param payload 任务负荷
   * @param options 任务设置（必须包含任务 owner）
   * @returns 新创建任务的 ID
   */
  async addTask(
    payload: PipelineQueuePayload,
    options: EnqueuePipelineTaskOptions,
  ): Promise<number> {
    return await enqueuePipelineTask(payload, options)
  }

  /**
   * 获取任务状态
   * @param taskId 任务ID
   * @returns 任务状态信息
   */
  async getTaskStatus(taskId: number) {
    const db = useDB()
    const task = await db
      .select()
      .from(tables.pipelineQueue)
      .where(eq(tables.pipelineQueue.id, taskId))
      .get()
    return task
  }

  /**
   * 获取并锁定下一个待处理任务
   * @returns 下一个待处理任务
   */
  async getNextTask(): Promise<PipelineQueueItem | null> {
    const db = useDB()
    const expiresAt = new Date(Date.now() + QUEUE_TASK_LEASE_TTL_MS)

    for (let attempt = 0; attempt < 5; attempt++) {
      const claimToken = randomUUID()

      // 使用同步事务防止竞态条件
      const task = db.transaction((tx) => {
        const highestPriorityPendingTask = tx
          .select()
          .from(tables.pipelineQueue)
          .where(
            and(
              eq(tables.pipelineQueue.status, 'pending'),
              sql`${tables.pipelineQueue.availableAt} <= (unixepoch())`,
            ),
          )
          // 优先处理高优先级、到期可用且较早创建的任务
          .orderBy(
            desc(tables.pipelineQueue.priority),
            asc(tables.pipelineQueue.availableAt),
            asc(tables.pipelineQueue.createdAt),
          )
          .limit(1)
          .get()

        if (!highestPriorityPendingTask) return null

        const updatedTask = tx
          .update(tables.pipelineQueue)
          .set({
            status: 'in-stages',
            claimedBy: this.workerId,
            claimToken,
            claimExpiresAt: expiresAt,
          })
          .where(
            and(
              eq(tables.pipelineQueue.id, highestPriorityPendingTask.id),
              eq(tables.pipelineQueue.status, 'pending'),
              sql`${tables.pipelineQueue.availableAt} <= (unixepoch())`,
            ),
          )
          .returning()
          .get()

        return updatedTask ?? null
      })

      if (task) {
        return task
      }
    }

    return null
  }

  async resetExpiredTaskLeases(): Promise<number> {
    const db = useDB()
    const expiredTasks = await db
      .select({ id: tables.pipelineQueue.id })
      .from(tables.pipelineQueue)
      .where(
        and(
          eq(tables.pipelineQueue.status, 'in-stages'),
          sql`(${tables.pipelineQueue.claimExpiresAt} IS NULL OR ${tables.pipelineQueue.claimExpiresAt} <= (unixepoch()))`,
        ),
      )

    if (expiredTasks.length === 0) {
      return 0
    }

    await db
      .update(tables.pipelineQueue)
      .set({
        status: 'pending',
        statusStage: null,
        claimedBy: null,
        claimToken: null,
        claimExpiresAt: null,
        availableAt: sql`(unixepoch())`,
      })
      .where(
        and(
          eq(tables.pipelineQueue.status, 'in-stages'),
          sql`(${tables.pipelineQueue.claimExpiresAt} IS NULL OR ${tables.pipelineQueue.claimExpiresAt} <= (unixepoch()))`,
        ),
      )

    return expiredTasks.length
  }

  private async refreshTaskLease(
    taskId: number,
    claimToken: string | null,
  ): Promise<boolean> {
    if (!claimToken) {
      return false
    }

    const updated = await useDB()
      .update(tables.pipelineQueue)
      .set({
        claimedBy: this.workerId,
        claimExpiresAt: new Date(Date.now() + QUEUE_TASK_LEASE_TTL_MS),
      })
      .where(
        and(
          eq(tables.pipelineQueue.id, taskId),
          eq(tables.pipelineQueue.status, 'in-stages'),
          eq(tables.pipelineQueue.claimToken, claimToken),
        ),
      )
      .returning({ id: tables.pipelineQueue.id })
      .get()

    return !!updated
  }

  private startTaskLeaseHeartbeat(task: PipelineQueueItem): () => void {
    if (!task.claimToken) {
      return () => {}
    }

    const timer = setInterval(() => {
      void this.refreshTaskLease(task.id, task.claimToken).then((refreshed) => {
        if (!refreshed) {
          this.logger.warn(
            `[${this.workerId}] Task ${task.id} lease refresh was rejected; completion will be fenced`,
          )
        }
      }).catch((error) => {
        this.logger.warn(
          `[${this.workerId}] Task ${task.id} lease refresh failed`,
          error,
        )
      })
    }, QUEUE_TASK_LEASE_REFRESH_MS)

    timer.unref?.()

    return () => clearInterval(timer)
  }

  private queueTaskLeaseWhere(taskId: number, claimToken: string | null) {
    if (!claimToken) {
      throw new QueueTaskLeaseLostError(taskId)
    }

    return and(
      eq(tables.pipelineQueue.id, taskId),
      eq(tables.pipelineQueue.status, 'in-stages'),
      eq(tables.pipelineQueue.claimToken, claimToken),
    )
  }

  /**
   * 更新任务阶段
   * @param taskId 任务ID
   * @param stage 新的任务阶段
   */
  async updateTaskStage(
    taskId: number,
    stage: PipelineQueueItem['statusStage'],
    claimToken?: string | null,
  ): Promise<void> {
    const db = useDB()
    const query = db
      .update(tables.pipelineQueue)
      .set({ statusStage: stage })
      .where(
        claimToken === undefined
          ? eq(tables.pipelineQueue.id, taskId)
          : this.queueTaskLeaseWhere(taskId, claimToken),
      )
      .returning({ id: tables.pipelineQueue.id })

    const updated = await query.get()
    if (claimToken !== undefined && !updated) {
      throw new QueueTaskLeaseLostError(taskId)
    }
  }
  /**
   * 标记任务为已完成
   * @param taskId 任务ID
   */
  async markTaskCompleted(
    taskId: number,
    claimToken: string | null,
  ): Promise<void> {
    const db = useDB()
    const updated = await db
      .update(tables.pipelineQueue)
      .set({
        status: 'completed',
        completedAt: sql`(unixepoch())`,
        claimedBy: null,
        claimToken: null,
        claimExpiresAt: null,
      })
      .where(this.queueTaskLeaseWhere(taskId, claimToken))
      .returning({ id: tables.pipelineQueue.id })
      .get()

    if (!updated) {
      throw new QueueTaskLeaseLostError(taskId)
    }
  }

  /**
   * 标记任务为失败
   * @param taskId 任务ID
   * @param errorMessage 错误信息
   */
  async markTaskFailed(
    taskId: number,
    claimToken: string | null,
    errorMessage?: string,
  ): Promise<void> {
    const db = useDB()
    const task = await db
      .select()
      .from(tables.pipelineQueue)
      .where(this.queueTaskLeaseWhere(taskId, claimToken))
      .get()

    if (!task) {
      throw new QueueTaskLeaseLostError(taskId)
    }

    const newAttempts = task.attempts + 1
    const shouldRetry = newAttempts < task.maxAttempts

    // 计算重试延迟（指数退避）
    const retryDelay = shouldRetry
      ? Math.min(1000 * Math.pow(2, newAttempts - 1), 30000)
      : 0

    const updated = await db
      .update(tables.pipelineQueue)
      .set({
        status: shouldRetry ? 'pending' : 'failed',
        attempts: newAttempts,
        errorMessage: errorMessage || 'Unknown error',
        statusStage: shouldRetry ? null : task.statusStage,
        claimedBy: null,
        claimToken: null,
        claimExpiresAt: null,
        // 如果重试，设置延迟重试时间
        ...(shouldRetry && retryDelay > 0
          ? {
              availableAt: new Date(Date.now() + retryDelay),
            }
          : {}),
      })
      .where(this.queueTaskLeaseWhere(taskId, claimToken))
      .returning({ id: tables.pipelineQueue.id })
      .get()

    if (!updated) {
      throw new QueueTaskLeaseLostError(taskId)
    }

    if (shouldRetry) {
      this.logger.warn(
        `Task ${taskId} failed (attempt ${newAttempts}/${task.maxAttempts}), will retry in ${retryDelay}ms: ${errorMessage}`,
      )
    } else {
      this.logger.error(
        `Task ${taskId} failed permanently after ${newAttempts} attempts: ${errorMessage}`,
      )
    }
  }

  /** 任务处理器 */
  private processors = (() => {
    return {
      photo: async (task: PipelineQueueItem) => {
        const { id: taskId, payload } = task
        if (payload.type !== 'photo') {
          throw new Error(
            `Invalid payload type for photo task: ${payload.type}`,
          )
        }
        const { storageKey } = payload
        const storageProvider = getStorageManager().getProvider()
        const photoId = resolvePhotoIdForStorageKey(
          storageKey,
          task.ownerUserId,
        )

        try {
          this.logger.info(`Start processing task ${taskId}: ${storageKey}`)

          let storageObject = await storageProvider.getFileMeta(storageKey)
          if (!storageObject) {
            // Fallback: try read the file directly to confirm existence (e.g., local provider)
            const maybeBuffer = await storageProvider.get(storageKey)
            if (maybeBuffer) {
              storageObject = {
                key: storageKey,
                size: maybeBuffer.length,
                lastModified: new Date(),
              }
            }
          }
          if (!storageObject) {
            throw new Error(`Storage object not found`)
          }

          // STEP 1: 预处理 - 转换 HEIC 到 JPEG 并上传
          await this.updateTaskStage(taskId, 'preprocessing', task.claimToken)
          this.logger.info(`[${taskId}:in-stage] preprocessing`)
          const imageBuffers = await preprocessImageWithJpegUpload(storageKey)
          if (!imageBuffers) {
            throw new Error('Preprocessing failed')
          }
          const contentHash =
            normalizeContentHash(payload.contentHash) ||
            sha256Hex(imageBuffers.raw)

          // STEP 2: 元数据处理 - 使用 Sharp 处理图片元数据
          await this.updateTaskStage(taskId, 'metadata', task.claimToken)
          this.logger.info(`[${taskId}:in-stage] metadata extraction`)
          const processedData = await processImageMetadataAndSharp(
            imageBuffers.processed,
            storageKey,
          )
          if (!processedData) {
            throw new Error('Metadata processing failed')
          }

          const { imageBuffer, metadata } = processedData

          // STEP 3: 生成缩略图
          await this.updateTaskStage(taskId, 'thumbnail', task.claimToken)
          this.logger.info(`[${taskId}:in-stage] thumbnail generation`)
          const { thumbnailBuffer, thumbnailHash } =
            await generateThumbnailAndHash(imageBuffer, this.logger)
          const displayBuffer = await generateDisplayImage(
            imageBuffer,
            this.logger,
          )

          // 上传缩略图到存储服务
          const thumbnailObject = await new Promise<any>((resolve, reject) => {
            setImmediate(async () => {
              try {
                const result = await storageProvider.create(
                  `thumbnails/${task.ownerUserId}/${photoId}.webp`,
                  thumbnailBuffer,
                  'image/webp',
                )
                resolve(result)
              } catch (error) {
                reject(error)
              }
            })
          })
          const displayObject = await new Promise<any>((resolve, reject) => {
            setImmediate(async () => {
              try {
                const result = await storageProvider.create(
                  `display/${task.ownerUserId}/${photoId}.webp`,
                  displayBuffer,
                  'image/webp',
                )
                resolve(result)
              } catch (error) {
                reject(error)
              }
            })
          })

          // STEP 4: 提取 EXIF 数据
          await this.updateTaskStage(taskId, 'exif', task.claimToken)
          this.logger.info(`[${taskId}:in-stage] exif extraction`)
          const exifData = await extractExifData(
            imageBuffer,
            imageBuffers.raw,
            this.logger,
          )
          const systemAutoEraseLocationOnUpload =
            (await settingsManager.get<boolean>(
              'privacy',
              'upload.autoEraseLocation',
            )) ?? false
          const shouldAutoEraseLocationOnUpload =
            typeof payload.eraseLocation === 'boolean'
              ? payload.eraseLocation
              : systemAutoEraseLocationOnUpload
          const normalizedExifData = shouldAutoEraseLocationOnUpload
            ? stripLocationFromExif(exifData)
            : exifData

          // 提取照片基本信息
          const photoInfo = extractPhotoInfo(storageKey, normalizedExifData)

          // STEP 5: 地理位置反向解析
          // 这里逆编码失败不报错，宽容处理
          await this.updateTaskStage(
            taskId,
            'reverse-geocoding',
            task.claimToken,
          )
          this.logger.info(`[${taskId}:in-stage] reverse geocoding`)

          let coordinates = null
          let locationInfo = null
          if (!shouldAutoEraseLocationOnUpload && normalizedExifData) {
            const { latitude, longitude } =
              parseGPSCoordinates(normalizedExifData)
            coordinates = { latitude, longitude }
            if (latitude && longitude) {
              locationInfo = await extractLocationFromGPS(latitude, longitude)
            }
          }

          // STEP 6: Motion Photo (XMP) 支持
          await this.updateTaskStage(taskId, 'motion-photo', task.claimToken)
          this.logger.info(`[${taskId}:in-stage] motion photo detection`)
          const motionPhotoInfo = imageBuffers.raw
            ? await processMotionPhotoFromXmp({
                photoId,
                storageKey,
                rawImageBuffer: imageBuffers.raw,
                exifData: normalizedExifData,
                storageProvider,
                ownerUserId: task.ownerUserId,
                logger: this.logger,
              })
            : null

          if (!imageBuffers.raw) {
            this.logger.warn(
              `[${taskId}:in-stage] motion photo detection skipped: missing raw buffer for ${storageKey}`,
            )
          }

          // STEP 7: LivePhoto 视频配对（独立 MOV 文件）
          await this.updateTaskStage(taskId, 'live-photo', task.claimToken)
          this.logger.info(`[${taskId}:in-stage] live photo detection`)
          let livePhotoInfo = null
          if (!motionPhotoInfo?.isMotionPhoto) {
            const livePhotoVideo = await findLivePhotoVideoForImage(storageKey)
            if (livePhotoVideo) {
              livePhotoInfo = {
                isLivePhoto: 1,
                livePhotoVideoUrl: storageProvider.getPublicUrl(
                  livePhotoVideo.videoKey,
                ),
                livePhotoVideoKey: livePhotoVideo.videoKey,
              }
              this.logger.info(
                `[${taskId}:in-stage] found LivePhoto video: ${livePhotoVideo.videoKey}`,
              )
            }
          } else {
            livePhotoInfo = {
              isLivePhoto: 1,
              livePhotoVideoUrl: motionPhotoInfo.livePhotoVideoUrl || null,
              livePhotoVideoKey: motionPhotoInfo.livePhotoVideoKey || null,
            }
          }

          // 构建最终的 Photo 对象
          const result: Photo = {
            id: photoId,
            title: photoInfo.title,
            description: photoInfo.description,
            dateTaken: photoInfo.dateTaken,
            tags: photoInfo.tags,
            width: metadata.width,
            height: metadata.height,
            aspectRatio: metadata.width / metadata.height,
            mediaType: 'image',
            duration: null,
            videoCodec: null,
            audioCodec: null,
            videoPlaybackKey: null,
            storageKey: storageKey,
            contentHash,
            thumbnailKey: thumbnailObject.key,
            displayKey: displayObject.key,
            fileSize: storageObject.size || null,
            lastModified:
              storageObject.lastModified?.toISOString() ||
              new Date().toISOString(),
            originalUrl: storageProxyUrl(imageBuffers.jpegKey || storageKey),
            thumbnailUrl: storageProxyUrl(thumbnailObject.key),
            thumbnailHash: thumbnailHash
              ? compressUint8Array(thumbnailHash)
              : null,
            exif: normalizedExifData,
            // 地理位置信息
            latitude: coordinates?.latitude || null,
            longitude: coordinates?.longitude || null,
            country: locationInfo?.country || null,
            city: locationInfo?.city || null,
            locationName: locationInfo?.locationName || null,
            // LivePhoto 相关字段
            isLivePhoto:
              motionPhotoInfo?.isMotionPhoto || livePhotoInfo?.isLivePhoto
                ? 1
                : 0,
            livePhotoVideoUrl:
              motionPhotoInfo?.livePhotoVideoUrl ||
              livePhotoInfo?.livePhotoVideoUrl ||
              null,
            livePhotoVideoKey:
              motionPhotoInfo?.livePhotoVideoKey ||
              livePhotoInfo?.livePhotoVideoKey ||
              null,
            ownerUserId: task.ownerUserId,
          }

          const db = useDB()
          await db.insert(tables.photos).values(result).onConflictDoUpdate({
            target: tables.photos.id,
            set: result,
          })

          if (shouldAutoEraseLocationOnUpload) {
            try {
              await this.addTask(
                {
                  type: 'photo-erase-location',
                  photoId,
                },
                {
                  priority: 2,
                  maxAttempts: 3,
                  ownerUserId: task.ownerUserId,
                },
              )
            } catch (enqueueError) {
              this.logger.warn(
                `[${taskId}:location-erase] failed to enqueue location erase task for ${photoId}`,
                enqueueError,
              )
            }
          }

          this.logger.success(`Task ${taskId} processed successfully`)
          return result
        } catch (error) {
          this.logger.error(`Task ${taskId} processing failed`, error)
          throw error
        }
      },
      reverseGeocoding: async (task: PipelineQueueItem) => {
        const db = useDB()
        const { id: taskId, payload } = task

        if (payload.type !== 'photo-reverse-geocoding') {
          throw new Error(
            `Invalid payload type for reverse geocoding task: ${payload.type}`,
          )
        }

        const { photoId } = payload

        try {
          await this.updateTaskStage(
            taskId,
            'reverse-geocoding',
            task.claimToken,
          )
          this.logger.info(
            `[${taskId}:in-stage] reverse geocoding for photo ${photoId}`,
          )

          const photo = await db
            .select()
            .from(tables.photos)
            .where(eq(tables.photos.id, photoId))
            .get()

          if (!photo) {
            this.logger.warn(
              `[${taskId}:reverse-geocoding] photo ${photoId} not found`,
            )
            throw new Error(`Photo ${photoId} not found`)
          }

          let latitude = payload.latitude ?? photo.latitude ?? undefined
          let longitude = payload.longitude ?? photo.longitude ?? undefined

          if (
            latitude === undefined ||
            latitude === null ||
            longitude === undefined ||
            longitude === null
          ) {
            if (photo.exif) {
              const coords = parseGPSCoordinates(photo.exif)
              if (latitude === undefined || latitude === null) {
                latitude = coords.latitude
              }
              if (longitude === undefined || longitude === null) {
                longitude = coords.longitude
              }
            }
          }

          const hasLatitude = latitude !== undefined && latitude !== null
          const hasLongitude = longitude !== undefined && longitude !== null

          if (!hasLatitude || !hasLongitude) {
            this.logger.warn(
              `[${taskId}:reverse-geocoding] missing coordinates for photo ${photoId}`,
            )
            await db
              .update(tables.photos)
              .set({
                latitude: null,
                longitude: null,
                country: null,
                city: null,
                locationName: null,
              })
              .where(eq(tables.photos.id, photoId))
            throw new Error(`Missing coordinates for photo ${photoId}`)
          }

          const locationInfo = await extractLocationFromGPS(
            latitude!,
            longitude!,
          )

          if (!locationInfo) {
            throw new Error(
              `Failed to extract location from GPS coordinates (${latitude}, ${longitude}), maybe network issue?`,
            )
          }

          await db
            .update(tables.photos)
            .set({
              latitude: latitude!,
              longitude: longitude!,
              country: locationInfo.country ?? null,
              city: locationInfo.city ?? null,
              locationName: locationInfo.locationName ?? null,
            })
            .where(eq(tables.photos.id, photoId))

          this.logger.success(
            `[${taskId}:reverse-geocoding] updated location for photo ${photoId}`,
          )
        } catch (error) {
          this.logger.error(
            `[${taskId}:reverse-geocoding] failed for photo ${photoId}`,
            error,
          )
          throw error
        }
      },
      eraseLocation: async (task: PipelineQueueItem) => {
        const db = useDB()
        const storageProvider = getStorageManager().getProvider()
        const { id: taskId, payload } = task

        if (payload.type !== 'photo-erase-location') {
          throw new Error(
            `Invalid payload type for erase location task: ${payload.type}`,
          )
        }

        await this.updateTaskStage(taskId, 'location-erase', task.claimToken)
        this.logger.info(
          `[${taskId}:in-stage] erase location info for photo ${payload.photoId}`,
        )

        const photo = await db
          .select()
          .from(tables.photos)
          .where(eq(tables.photos.id, payload.photoId))
          .get()

        if (!photo) {
          throw new Error(`Photo ${payload.photoId} not found`)
        }

        if (!photo.storageKey) {
          throw new Error(`Photo ${payload.photoId} has no storage key`)
        }

        const originalBuffer = await storageProvider.get(photo.storageKey)
        if (!originalBuffer) {
          throw new Error(`Photo file ${photo.storageKey} not found in storage`)
        }

        const tempDir = await createTempDir('cframe-location')
        const ext = path.extname(photo.storageKey) || '.jpg'
        const tempFile = path.join(tempDir, `erase-location${ext}`)

        try {
          await writeFile(tempFile, originalBuffer)

          const exifLocationNullMap = EXIF_LOCATION_KEYS.reduce(
            (acc, key) => {
              acc[key] = null
              return acc
            },
            {} as Record<string, null>,
          )

          await exiftool.write(tempFile, exifLocationNullMap, [
            '-overwrite_original',
          ])

          const updatedBuffer = await readFile(tempFile)

          const prefix =
            storageProvider.config && 'prefix' in storageProvider.config
              ? storageProvider.config.prefix
              : ''

          await storageProvider.create(
            photo.storageKey.replace(prefix || '', ''),
            updatedBuffer,
          )

          const exifData = stripLocationFromExif(
            await extractExifData(updatedBuffer),
          )

          await db
            .update(tables.photos)
            .set({
              exif: exifData,
              fileSize: updatedBuffer.length,
              lastModified: new Date().toISOString(),
              latitude: null,
              longitude: null,
              country: null,
              city: null,
              locationName: null,
            })
            .where(eq(tables.photos.id, payload.photoId))

          this.logger.success(
            `[${taskId}:location-erase] erased location info for photo ${payload.photoId}`,
          )
        } finally {
          await rm(tempDir, { recursive: true, force: true })
        }
      },
      video: async (task: PipelineQueueItem) => {
        const { id: taskId, payload } = task
        if (payload.type !== 'video') {
          throw new Error(
            `Invalid payload type for video task: ${payload.type}`,
          )
        }

        const storageProvider = getStorageManager().getProvider()
        const storageObject = await storageProvider.getFileMeta(
          payload.storageKey,
        )
        const videoBuffer = await storageProvider.get(payload.storageKey)
        if (!videoBuffer) throw new Error('Storage object not found')
        const contentHash =
          normalizeContentHash(payload.contentHash) || sha256Hex(videoBuffer)

        await this.updateTaskStage(taskId, 'metadata', task.claimToken)
        const processed = await processMp4Video(videoBuffer, payload.storageKey)
        const videoExif =
          (await extractExifData(videoBuffer, undefined, this.logger)) ||
          processed.exif

        await this.updateTaskStage(taskId, 'thumbnail', task.claimToken)
        const { thumbnailBuffer, thumbnailHash } =
          await generateThumbnailAndHash(processed.thumbnailBuffer, this.logger)
        const videoId = generateSafeVideoId(payload.storageKey)
        let videoPlaybackKey: string | null = null
        if (processed.playbackBuffer) {
          videoPlaybackKey = `videos/${task.ownerUserId}/${videoId}-playback.mp4`
          await storageProvider.create(
            videoPlaybackKey,
            processed.playbackBuffer,
            'video/mp4',
          )
        }
        const thumbnailObject = await storageProvider.create(
          `thumbnails/${task.ownerUserId}/${videoId}.webp`,
          thumbnailBuffer,
          'image/webp',
        )

        await this.updateTaskStage(
          taskId,
          'reverse-geocoding',
          task.claimToken,
        )
        const coordinates = parseGPSCoordinates(videoExif)
        const hasCoordinates =
          coordinates.latitude != null && coordinates.longitude != null
        const locationInfo = hasCoordinates
          ? await extractLocationFromGPS(
              coordinates.latitude!,
              coordinates.longitude!,
            )
          : null

        const baseName = path.basename(
          payload.storageKey,
          path.extname(payload.storageKey),
        )
        const result: Photo = {
          id: videoId,
          title: baseName,
          description: '',
          width: processed.width,
          height: processed.height,
          aspectRatio: processed.width / processed.height,
          mediaType: 'video',
          duration: processed.duration,
          videoCodec: processed.videoCodec,
          audioCodec: processed.audioCodec,
          videoPlaybackKey,
          dateTaken: processed.dateTaken,
          storageKey: payload.storageKey,
          contentHash,
          thumbnailKey: thumbnailObject.key,
          displayKey: null,
          fileSize: storageObject?.size || videoBuffer.length,
          lastModified:
            storageObject?.lastModified?.toISOString() ||
            new Date().toISOString(),
          originalUrl: storageProxyUrl(videoPlaybackKey || payload.storageKey),
          thumbnailUrl: storageProxyUrl(thumbnailObject.key),
          thumbnailHash: thumbnailHash
            ? compressUint8Array(thumbnailHash)
            : null,
          tags: [],
          exif: videoExif,
          latitude: coordinates.latitude || null,
          longitude: coordinates.longitude || null,
          country: locationInfo?.country || null,
          city: locationInfo?.city || null,
          locationName: locationInfo?.locationName || null,
          isLivePhoto: 0,
          livePhotoVideoUrl: null,
          livePhotoVideoKey: null,
          ownerUserId: task.ownerUserId,
        }

        await useDB()
          .insert(tables.photos)
          .values(result)
          .onConflictDoUpdate({ target: tables.photos.id, set: result })
        this.logger.success(`Video task ${taskId} processed successfully`)
      },
      livePhotoDetect: async (task: PipelineQueueItem) => {
        const db = useDB()
        const storageProvider = getStorageManager().getProvider()

        const { id: taskId, payload } = task
        if (payload.type !== 'live-photo-video') {
          throw new Error(
            `Invalid payload type for live-photo task: ${payload.type}`,
          )
        }
        const { storageKey: videoKey } = payload

        try {
          this.logger.info(
            `Start processing LivePhoto detection task ${taskId}: ${videoKey}`,
          )

          let storageObject = await storageProvider.getFileMeta(videoKey)
          if (!storageObject) {
            const maybeBuffer = await storageProvider.get(videoKey)
            if (maybeBuffer) {
              storageObject = {
                key: videoKey,
                size: maybeBuffer.length,
                lastModified: new Date(),
              }
            }
          }
          if (!storageObject) {
            throw new Error(`Storage object not found`)
          }

          const matchedPhoto = await findPhotoForLivePhotoVideo(videoKey)

          if (!matchedPhoto) {
            this.logger.warn(
              `No matching photo found for LivePhoto video yet: ${videoKey}. The photo task will pair it when the image arrives.`,
            )
            return
          }

          const livePhotoVideoUrl = storageProvider.getPublicUrl(videoKey)
          await db
            .update(tables.photos)
            .set({
              isLivePhoto: 1,
              livePhotoVideoUrl,
              livePhotoVideoKey: videoKey,
            })
            .where(eq(tables.photos.id, matchedPhoto.id))

          this.logger.success(
            `LivePhoto detection task ${taskId} processed successfully, updated photo ${matchedPhoto.id}`,
          )
        } catch (error) {
          this.logger.error(
            `LivePhoto detection task ${taskId} processing failed`,
            error,
          )
          throw error
        }
      },
    }
  })()

  /**
   * 处理下一个待处理任务
   */
  private async processNextTask(): Promise<void> {
    if (this.isProcessing) {
      this.logger.debug('Task is already processing, skipping this poll')
      return
    }

    this.isProcessing = true

    try {
      const task = await this.getNextTask()
      if (!task) {
        this.logger.debug('No tasks to process at the moment')
        return
      }

      const stopLeaseHeartbeat = this.startTaskLeaseHeartbeat(task)
      try {
        const { type } = task.payload

        switch (type) {
          case 'video':
            await this.processors.video(task)
            break
          case 'live-photo-video':
            await this.processors.livePhotoDetect(task)
            break
          case 'photo':
            await this.processors.photo(task)
            break
          case 'photo-reverse-geocoding':
            await this.processors.reverseGeocoding(task)
            break
          case 'photo-erase-location':
            await this.processors.eraseLocation(task)
            break
          default:
            throw new Error(`Unknown task type: ${type}`)
        }

        await this.markTaskCompleted(task.id, task.claimToken)
        this.processedCount++
        this.logger.success(
          `[${this.workerId}] Task ${task.id} processed successfully (Total: ${this.processedCount})`,
        )

        // const result = await this.processTask(task)
        // if (result) {
        //   await this.markTaskCompleted(task.id)
        //   this.processedCount++
        //   this.logger.success(
        //     `[${this.workerId}] Task ${task.id} processed successfully (Total: ${this.processedCount})`,
        //   )
        // } else {
        //   await this.markTaskFailed(task.id, 'Processing result is empty')
        //   this.errorCount++
        // }
      } catch (error) {
        if (error instanceof QueueTaskLeaseLostError) {
          this.errorCount++
          this.logger.warn(
            `[${this.workerId}] Task ${task.id} lost its queue lease; skipping status writeback`,
            error,
          )
          return
        }

        const errorMessage =
          error instanceof Error ? error.message : String(error)
        try {
          await this.markTaskFailed(task.id, task.claimToken, errorMessage)
        } catch (markError) {
          this.errorCount++
          this.logger.error(
            `[${this.workerId}] Task ${task.id} processing failed, but status writeback was rejected:`,
            markError,
          )
          return
        }
        this.errorCount++
        this.logger.error(
          `[${this.workerId}] Task ${task.id} processing failed (Error: ${this.errorCount}):`,
          errorMessage,
        )
      } finally {
        stopLeaseHeartbeat()
      }
    } catch (error) {
      this.logger.error('Error occurred while fetching the next task:', error)
    } finally {
      this.isProcessing = false
    }
  }

  private requestProcessing(): Promise<void> {
    if (!this.processingInterval) {
      return Promise.resolve()
    }

    if (this.processingPromise) {
      return this.processingPromise
    }

    const processingPromise = this.processNextTask()
      .catch((error) => {
        this.logger.error('Error occurred while processing the queue:', error)
      })
      .finally(() => {
        if (this.processingPromise === processingPromise) {
          this.processingPromise = null
        }
      })

    this.processingPromise = processingPromise
    return processingPromise
  }

  /**
   * 开始处理队列
   * @param intervalMs 轮询间隔
   */
  startProcessing(intervalMs: number = 3000): void {
    if (this.processingInterval) return

    this.processingInterval = setInterval(() => {
      void this.requestProcessing()
    }, intervalMs)

    this.logger.success(
      `Queue processing started with interval: ${intervalMs}ms`,
    )

    void this.requestProcessing()
  }

  /**
   * 停止处理队列
   */
  async stopProcessing(timeoutMs: number = 30_000): Promise<boolean> {
    if (this.processingInterval) {
      clearInterval(this.processingInterval)
      this.processingInterval = null
      this.logger.warn('Queue processing stopped')
    }

    const processingPromise = this.processingPromise
    if (!processingPromise) {
      return true
    }

    let timeout: NodeJS.Timeout | null = null
    const drained = await Promise.race([
      processingPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])

    if (timeout) {
      clearTimeout(timeout)
    }

    if (!drained) {
      this.logger.warn(
        `[${this.workerId}] Timed out after ${timeoutMs}ms while waiting for the active task to finish`,
      )
    }

    return drained
  }

  /**
   * 获取队列统计信息
   * @returns 队列统计信息
   */
  async getQueueStats() {
    const db = useDB()
    const stats = await db
      .select({
        status: tables.pipelineQueue.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(tables.pipelineQueue)
      .groupBy(tables.pipelineQueue.status)

    return stats.reduce(
      (acc, stat) => {
        acc[stat.status] = stat.count
        return acc
      },
      {} as Record<string, number>,
    )
  }
}
