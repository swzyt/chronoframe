import path from 'path'
import { eq } from 'drizzle-orm'
import { getStorageManager } from '~~/server/plugins/3.storage'
import type { Photo } from '~~/server/utils/db'

export const livePhotoImageKeysForVideo = (videoKey: string) => {
  const videoBaseName = path.basename(videoKey, path.extname(videoKey))
  const videoDir = path.dirname(videoKey)

  return [
    path.join(videoDir, `${videoBaseName}.HEIC`).replace(/\\/g, '/'),
    path.join(videoDir, `${videoBaseName}.heic`).replace(/\\/g, '/'),
    path.join(videoDir, `${videoBaseName}.HEIF`).replace(/\\/g, '/'),
    path.join(videoDir, `${videoBaseName}.heif`).replace(/\\/g, '/'),
    path.join(videoDir, `${videoBaseName}.JPG`).replace(/\\/g, '/'),
    path.join(videoDir, `${videoBaseName}.jpg`).replace(/\\/g, '/'),
    path.join(videoDir, `${videoBaseName}.JPEG`).replace(/\\/g, '/'),
    path.join(videoDir, `${videoBaseName}.jpeg`).replace(/\\/g, '/'),
  ]
}

export const livePhotoVideoKeysForImage = (imageKey: string) => {
  const imageBaseName = path.basename(imageKey, path.extname(imageKey))
  const imageDir = path.dirname(imageKey)

  return [
    path.join(imageDir, `${imageBaseName}.MOV`).replace(/\\/g, '/'),
    path.join(imageDir, `${imageBaseName}.mov`).replace(/\\/g, '/'),
  ]
}

export const findPhotoForLivePhotoVideo = async (
  videoKey: string,
): Promise<Photo | null> => {
  const db = useDB()

  for (const photoKey of livePhotoImageKeysForVideo(videoKey)) {
    const matched = await db
      .select()
      .from(tables.photos)
      .where(eq(tables.photos.storageKey, photoKey))
      .get()

    if (matched) {
      logger.chrono.info(`Found matching photo: ${photoKey}`)
      return matched
    }
  }

  return null
}

/**
 * 处理 LivePhoto MOV 文件，匹配相同文件名的照片并更新 LivePhoto 信息
 */
export const processLivePhotoVideo = async (
  videoKey: string,
  _videoSize: number,
): Promise<boolean> => {
  const storageProvider = getStorageManager().getProvider()
  const db = useDB()

  try {
    logger.chrono.info(`Processing LivePhoto video: ${videoKey}`)

    const matchedPhoto = await findPhotoForLivePhotoVideo(videoKey)

    if (!matchedPhoto) {
      logger.chrono.warn(
        `No matching photo found for LivePhoto video: ${videoKey}`,
      )
      return false
    }

    // 获取视频的公共 URL
    const videoUrl = storageProvider.getPublicUrl(videoKey)

    // 更新照片记录，设置 LivePhoto 信息
    await db
      .update(tables.photos)
      .set({
        isLivePhoto: 1,
        livePhotoVideoUrl: videoUrl,
        livePhotoVideoKey: videoKey,
      })
      .where(eq(tables.photos.id, matchedPhoto.id))

    logger.chrono.success(
      `Successfully processed LivePhoto: ${matchedPhoto.id}, video: ${videoKey}`,
    )
    return true
  } catch (error) {
    logger.chrono.error(`Failed to process LivePhoto video ${videoKey}:`, error)
    return false
  }
}

/**
 * 检查存储桶中是否有与照片对应的 LivePhoto 视频文件
 */
export const findLivePhotoVideoForImage = async (
  imageKey: string,
): Promise<{ videoKey: string; videoSize: number } | null> => {
  const storageProvider = getStorageManager().getProvider()

  try {
    logger.chrono.info(`Checking for LivePhoto video for image: ${imageKey}`)

    // 检查存储中是否存在对应的视频文件
    for (const videoKey of livePhotoVideoKeysForImage(imageKey)) {
      try {
        const videoBuffer = await storageProvider.get(videoKey)
        if (videoBuffer) {
          const videoSize = videoBuffer.length

          // 检查是否符合 LivePhoto 视频的特征
          const fileName = path.basename(videoKey)
          if (isLivePhotoVideo(fileName, videoSize)) {
            logger.chrono.info(`Found matching LivePhoto video: ${videoKey}`)
            return { videoKey, videoSize }
          } else {
            logger.chrono.warn(
              `Video file found but doesn't match LivePhoto criteria: ${videoKey} (size: ${videoSize})`,
            )
          }
        }
      } catch {
        // 文件不存在，继续检查下一个
        continue
      }
    }

    logger.chrono.info(
      `No matching LivePhoto video found for image: ${imageKey}`,
    )
    return null
  } catch (error) {
    logger.chrono.error(
      `Failed to check for LivePhoto video for ${imageKey}:`,
      error,
    )
    return null
  }
}

/**
 * 检查文件是否为 MOV 视频格式
 */
export const isVideoFile = (fileName: string): boolean => {
  const extName = path.extname(fileName).toLowerCase()
  return ['.mov', '.mp4'].includes(extName)
}

/**
 * 检查文件是否可能是 LivePhoto 的 MOV 文件
 * LivePhoto 的 MOV 文件通常较小，但高分辨率/较长片段可能超过十几 MB。
 */
export const isLivePhotoVideo = (
  fileName: string,
  fileSize: number,
): boolean => {
  const extName = path.extname(fileName).toLowerCase()

  // 检查是否为 MOV 格式
  if (extName !== '.mov') {
    return false
  }

  const maxLivePhotoSize = 100 * 1024 * 1024 // 100MB
  return fileSize <= maxLivePhotoSize
}
