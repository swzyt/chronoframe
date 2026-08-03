import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ExecFileException } from 'node:child_process'
import { exiftool } from 'exiftool-vendored'
import type { NeededExif } from '~~/shared/types/photo'
import { createTempDir } from '~~/server/utils/temp-dir'

const execFileAsync = promisify(execFile)

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  tags?: Record<string, string>
}

interface ProbeResult {
  streams?: ProbeStream[]
  format?: {
    duration?: string
    tags?: Record<string, string>
  }
}

export interface ProcessedVideo {
  width: number
  height: number
  duration: number
  videoCodec: string
  audioCodec: string | null
  playbackBuffer: Buffer | null
  thumbnailBuffer: Buffer
  exif: NeededExif
  dateTaken: string
}

const isMissingExecutableError = (error: unknown) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as ExecFileException).code === 'ENOENT',
  )

const runMediaTool = async (
  binary: string,
  args: string[],
  toolName: string,
) => {
  try {
    return await execFileAsync(binary, args, { maxBuffer: 10 * 1024 * 1024 })
  } catch (error) {
    if (isMissingExecutableError(error)) {
      throw new Error(
        `${toolName} binary is unavailable. Install FFmpeg locally or set ${toolName === 'FFmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'}.`,
      )
    }
    throw error
  }
}

function parseDate(value: unknown) {
  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof value.toDate === 'function'
  ) {
    const date = value.toDate()
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      return date.toISOString()
    }
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export async function processMp4Video(
  input: Buffer,
  _fileName: string,
): Promise<ProcessedVideo> {
  const resolvedFfmpegPath =
    process.env.FFMPEG_PATH ||
    (process.platform === 'linux' ? '/usr/bin/ffmpeg' : 'ffmpeg')
  const resolvedFfprobePath =
    process.env.FFPROBE_PATH ||
    (process.platform === 'linux' ? '/usr/bin/ffprobe' : 'ffprobe')
  if (!resolvedFfmpegPath) {
    throw new Error('FFmpeg binary is unavailable')
  }

  const tempDir = await createTempDir('chronoframe-video')
  const inputPath = path.join(tempDir, 'input.mp4')
  const thumbnailPath = path.join(tempDir, 'thumbnail.webp')
  const playbackPath = path.join(tempDir, 'playback.mp4')

  try {
    await writeFile(inputPath, input)
    const { stdout } = await runMediaTool(
      resolvedFfprobePath,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        inputPath,
      ],
      'FFprobe',
    )
    const probe = JSON.parse(stdout) as ProbeResult
    const videoStream = probe.streams?.find(
      (stream) => stream.codec_type === 'video',
    )
    const audioStream = probe.streams?.find(
      (stream) => stream.codec_type === 'audio',
    )

    if (!videoStream?.width || !videoStream.height) {
      throw new Error('MP4 does not contain a valid video stream')
    }
    if (!['h264', 'hevc', 'h265'].includes(videoStream.codec_name || '')) {
      throw new Error(
        `Unsupported MP4 video codec: ${videoStream.codec_name || 'unknown'}. H.264 or HEVC is required.`,
      )
    }
    const requiresVideoTranscode = videoStream.codec_name !== 'h264'
    const requiresAudioTranscode =
      !!audioStream && !['aac', 'mp3'].includes(audioStream.codec_name || '')

    let playbackBuffer: Buffer | null = null
    if (requiresVideoTranscode || requiresAudioTranscode) {
      await runMediaTool(
        resolvedFfmpegPath,
        [
          '-v',
          'error',
          '-i',
          inputPath,
          ...(requiresVideoTranscode
            ? [
                '-c:v',
                'libx264',
                '-preset',
                'medium',
                '-crf',
                '21',
                '-pix_fmt',
                'yuv420p',
              ]
            : ['-c:v', 'copy']),
          ...(audioStream
            ? requiresAudioTranscode
              ? ['-c:a', 'aac', '-b:a', '192k']
              : ['-c:a', 'copy']
            : ['-an']),
          '-movflags',
          '+faststart',
          '-y',
          playbackPath,
        ],
        'FFmpeg',
      )
      playbackBuffer = await readFile(playbackPath)
    }

    const duration = Number(probe.format?.duration || 0)
    const seekTime = duration > 2 ? Math.min(1, duration * 0.1) : 0
    await runMediaTool(
      resolvedFfmpegPath,
      [
        '-v',
        'error',
        '-ss',
        String(seekTime),
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        "scale='min(1200,iw)':-2",
        '-c:v',
        'libwebp',
        '-quality',
        '82',
        '-y',
        thumbnailPath,
      ],
      'FFmpeg',
    )

    const rawTags = await exiftool.read(inputPath)
    const exif = rawTags as unknown as NeededExif
    const creationTime =
      videoStream.tags?.creation_time ||
      probe.format?.tags?.creation_time ||
      rawTags.CreateDate ||
      rawTags.DateTimeOriginal

    return {
      width: videoStream.width,
      height: videoStream.height,
      duration: Number.isFinite(duration) ? duration : 0,
      videoCodec: videoStream.codec_name,
      audioCodec: audioStream?.codec_name || null,
      playbackBuffer,
      thumbnailBuffer: await readFile(thumbnailPath),
      exif,
      dateTaken:
        parseDate(creationTime)?.toString() || new Date().toISOString(),
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
