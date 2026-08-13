import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { settingsManager } from '~~/server/services/settings/settingsManager'
import { getLegacyLocalMedia } from '~~/server/utils/legacy-local-media'
import { logger } from '~~/server/utils/logger'
import { normalizePhotoDescription } from '~~/shared/utils/photo-description'

const OG_WIDTH = 1200
const OG_HEIGHT = 600
const MEDIA_WIDTH = OG_WIDTH

const escapeXml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const truncate = (value: unknown, max: number) => {
  const text = String(value ?? '').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const exifValue = (exif: unknown, key: string) => {
  if (!exif || typeof exif !== 'object') return null
  return (exif as Record<string, unknown>)[key]
}

const fallbackMediaTemplate = ({
  headline,
  title,
}: {
  headline: string
  title: string
}) => `
<svg width="${MEDIA_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${MEDIA_WIDTH} ${OG_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="mediaBg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#27272a"/>
      <stop offset="50%" stop-color="#111827"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="45%" r="65%">
      <stop offset="0%" stop-color="#f43f5e" stop-opacity="0.42"/>
      <stop offset="52%" stop-color="#38bdf8" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#020617" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${MEDIA_WIDTH}" height="${OG_HEIGHT}" fill="url(#mediaBg)"/>
  <rect width="${MEDIA_WIDTH}" height="${OG_HEIGHT}" fill="url(#glow)"/>
  <g opacity="0.22">
    ${Array.from({ length: 16 })
      .map(
        (_, index) =>
          `<rect x="${index * 54 - 12}" y="0" width="24" height="${OG_HEIGHT}" fill="#ffffff"/>`,
      )
      .join('')}
  </g>
  <g transform="translate(218 178)" fill="none" stroke="#ffffff" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" opacity="0.82">
    <rect x="0" y="0" width="284" height="190" rx="34"/>
    <path d="M38 132 104 78 162 122 196 94 248 140"/>
    <circle cx="214" cy="58" r="20" fill="#ffffff" stroke="none"/>
  </g>
  <text x="360" y="430" fill="#ffffff" opacity="0.82" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="34" font-weight="900" text-anchor="middle">${escapeXml(headline)}</text>
  <text x="360" y="480" fill="#d4d4d8" opacity="0.82" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="28" font-weight="700" text-anchor="middle">${escapeXml(title)}</text>
</svg>`

const svgTemplate = ({
  title,
  description,
  headline,
  appTitle,
  city,
  camera,
  focal,
  aperture,
  exposure,
  iso,
  fullBackground = true,
}: {
  title: string
  description: string
  headline: string
  appTitle: string
  city: string
  camera: string
  focal: string
  aperture: string
  exposure: string
  iso: string
  fullBackground?: boolean
}) => `
<svg width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#18181b"/>
      <stop offset="58%" stop-color="#09090b"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <linearGradient id="photoFade" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0%" stop-color="#09090b" stop-opacity="0.92"/>
      <stop offset="38%" stop-color="#09090b" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="#09090b" stop-opacity="0"/>
    </linearGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>
  ${
    fullBackground
      ? `<rect width="1200" height="600" fill="url(#bg)"/>
  <circle cx="150" cy="90" r="220" fill="#fb7185" opacity="0.12"/>
  <circle cx="430" cy="560" r="260" fill="#38bdf8" opacity="0.08"/>`
      : ''
  }
  <rect x="0" y="0" width="860" height="600" fill="url(#photoFade)"/>
  <g filter="url(#softShadow)">
    <text x="72" y="82" fill="#f43f5e" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="34" font-weight="800" letter-spacing="2">${escapeXml(headline)} · ${escapeXml(appTitle)}</text>
    <text x="72" y="174" fill="#ffffff" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="76" font-weight="900">${escapeXml(title)}</text>
    ${
      description
        ? `<text x="72" y="234" fill="#d4d4d8" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="30" font-weight="700">${escapeXml(description)}</text>`
        : ''
    }
    <text x="72" y="308" fill="#d4d4d8" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="28" font-weight="700">${escapeXml([city, camera].filter(Boolean).join('  ·  '))}</text>
    <g transform="translate(72,392)" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="30" font-weight="800">
      <rect x="0" y="0" width="142" height="76" rx="24" fill="#ffffff" opacity="0.10"/>
      <text x="26" y="48" fill="#fbbf24">${escapeXml(focal)}</text>
      <rect x="162" y="0" width="142" height="76" rx="24" fill="#ffffff" opacity="0.10"/>
      <text x="188" y="48" fill="#c084fc">${escapeXml(aperture)}</text>
      <rect x="324" y="0" width="156" height="76" rx="24" fill="#ffffff" opacity="0.10"/>
      <text x="350" y="48" fill="#34d399">${escapeXml(exposure)}</text>
      <rect x="500" y="0" width="128" height="76" rx="24" fill="#ffffff" opacity="0.10"/>
      <text x="526" y="48" fill="#38bdf8">${escapeXml(iso)}</text>
    </g>
  </g>
</svg>`

const renderFallbackOgImage = async ({
  headline,
  title,
  appTitle,
}: {
  headline: string
  title: string
  appTitle: string
}) => {
  const fallbackSvg = svgTemplate({
    title,
    description: '',
    headline,
    appTitle: truncate(appTitle, 28),
    city: '',
    camera: '',
    focal: '—',
    aperture: '—',
    exposure: '—',
    iso: '—',
  })

  try {
    return await sharp(Buffer.from(fallbackSvg)).png().toBuffer()
  } catch (error) {
    logger.image.warn('Failed to render SVG share preview fallback; using plain PNG', error)
    return await sharp({
      create: {
        width: OG_WIDTH,
        height: OG_HEIGHT,
        channels: 3,
        background: '#09090b',
      },
    })
      .png()
      .toBuffer()
  }
}

const renderFallbackMediaImage = async (headline: string, title: string) => {
  try {
    return await sharp(Buffer.from(fallbackMediaTemplate({ headline, title })))
      .png()
      .toBuffer()
  } catch (error) {
    logger.image.warn('Failed to render share preview media fallback; using plain media block', error)
    return await sharp({
      create: {
        width: MEDIA_WIDTH,
        height: OG_HEIGHT,
        channels: 3,
        background: '#111827',
      },
    })
      .png()
      .toBuffer()
  }
}

const normalizeMediaKey = (key?: string | null) =>
  key?.trim().replace(/^\/+/, '') || null

const keyFromProxyUrl = (url?: string | null) => {
  const value = url?.trim()
  if (!value) return null

  const pathname = (() => {
    try {
      return new URL(value, 'http://chronoframe.local').pathname
    } catch {
      return value
    }
  })()

  for (const prefix of ['/image/', '/storage/']) {
    if (pathname.startsWith(prefix)) {
      return decodeURIComponent(pathname.slice(prefix.length)).replace(/^\/+/, '')
    }
  }

  return null
}

const uniqueMediaKeys = (
  ...keys: Array<string | null | undefined>
): string[] => [
  ...new Set(keys.map(normalizeMediaKey).filter((key): key is string => !!key)),
]

const getSharePreviewCandidateKeys = (
  photo: typeof tables.photos.$inferSelect,
) => {
  if (photo.mediaType === 'video') {
    return uniqueMediaKeys(
      photo.thumbnailKey,
      photo.displayKey,
      keyFromProxyUrl(photo.thumbnailUrl),
      keyFromProxyUrl(photo.originalUrl),
      photo.storageKey,
    )
  }

  return uniqueMediaKeys(
    photo.displayKey,
    photo.storageKey,
    photo.thumbnailKey,
    keyFromProxyUrl(photo.originalUrl),
    keyFromProxyUrl(photo.thumbnailUrl),
  )
}

const loadSharePreviewMedia = async (
  event: Parameters<typeof useStorageProvider>[0],
  photo: typeof tables.photos.$inferSelect,
  headline: string,
  title: string,
) => {
  const { storageProvider } = useStorageProvider(event)
  const candidateKeys = getSharePreviewCandidateKeys(photo)

  for (const mediaKey of candidateKeys) {
    try {
      const mediaBuffer =
        (await storageProvider.get(mediaKey)) ||
        (await getLegacyLocalMedia(mediaKey))
      if (!mediaBuffer) {
        logger.image.warn(
          `Share preview media candidate not found for photo ${photo.id}: ${mediaKey}`,
        )
        continue
      }

      return await sharp(mediaBuffer, { limitInputPixels: false })
        .rotate()
        .resize(MEDIA_WIDTH, OG_HEIGHT, { fit: 'cover' })
        .png()
        .toBuffer()
    } catch (error) {
      logger.image.warn(
        `Failed to decode share preview media candidate for photo ${photo.id}: ${mediaKey}`,
        error,
      )
    }
  }

  logger.image.warn(
    `No usable share preview media found for photo ${photo.id}; using fallback card`,
  )
  return await renderFallbackMediaImage(headline, title)
}

export default eventHandler(async (event) => {
  const rawPhotoId =
    getRouterParam(event, 'photoId') ||
    getRequestURL(event).pathname.split('/').pop() ||
    ''
  const photoId = decodeURIComponent(rawPhotoId).replace(/\.png$/i, '')
  if (!photoId) {
    throw createError({ statusCode: 404, statusMessage: 'Image not found' })
  }

  const photo = useDB()
    .select()
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()
  if (!photo) {
    throw createError({ statusCode: 404, statusMessage: 'Image not found' })
  }

  await requirePublicPhotoAccess(event, photoId)

  const appTitle =
    (await settingsManager.get<string>('app', 'title')) || 'ChronoFrame'
  const exif = photo.exif
  const camera = [exifValue(exif, 'Make'), exifValue(exif, 'Model')]
    .filter(Boolean)
    .join(' ')
  const exposure = exifValue(exif, 'ExposureTime')
  const headline = photo.mediaType === 'video' ? 'VIDEO' : 'PHOTO'
  const title = truncate(photo.title || appTitle, 16)
  let image: Buffer
  try {
    const overlay = Buffer.from(
      svgTemplate({
        title,
        description: truncate(normalizePhotoDescription(photo.description), 30),
        headline,
        appTitle: truncate(appTitle, 28),
        city: truncate(photo.city || photo.locationName || '', 20),
        camera: truncate(camera, 28),
        focal: truncate(exifValue(exif, 'FocalLengthIn35mmFormat') || '—', 8),
        aperture: truncate(
          exifValue(exif, 'FNumber') ? `f/${exifValue(exif, 'FNumber')}` : '—',
          8,
        ),
        exposure: truncate(exposure ? `${exposure}s` : '—', 10),
        iso: truncate(exifValue(exif, 'ISO') || '—', 8),
        fullBackground: false,
      }),
    )

    const media = await loadSharePreviewMedia(event, photo, headline, title)

    image = await sharp({
      create: {
        width: OG_WIDTH,
        height: OG_HEIGHT,
        channels: 3,
        background: '#09090b',
      },
    })
      .composite([
        { input: media, left: 0, top: 0 },
        { input: overlay, left: 0, top: 0 },
      ])
      .png()
      .toBuffer()
  } catch (error) {
    logger.image.warn(
      `Failed to compose share preview for photo ${photo.id}; using fallback card`,
      error,
    )
    image = await renderFallbackOgImage({ headline, title, appTitle })
  }

  setHeader(event, 'Content-Type', 'image/png')
  setHeader(event, 'Content-Length', String(image.length))
  setHeader(event, 'Cache-Control', 'private, max-age=86400')
  return image
})
