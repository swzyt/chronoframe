import { withRetry, RetryPresets } from '../../utils/retry'
import { settingsManager } from '../settings/settingsManager'

export interface LocationInfo {
  latitude: number
  longitude: number
  country?: string
  city?: string
  locationName?: string
}

export interface GeocodingProvider {
  reverseGeocode(lat: number, lon: number): Promise<LocationInfo | null>
}

const DEFAULT_LOCATION_LANGUAGE = 'zh-Hans'

const normalizeLocationLanguage = (language?: string | null) => {
  switch (language) {
    case 'zh':
    case 'zh-CN':
      return 'zh-Hans'
    case 'zh-TW':
      return 'zh-Hant-TW'
    case 'zh-HK':
      return 'zh-Hant-HK'
    default:
      return language || DEFAULT_LOCATION_LANGUAGE
  }
}

const toMapboxLanguage = (language?: string | null) => {
  const normalized = normalizeLocationLanguage(language)
  switch (normalized) {
    case 'zh-Hant-TW':
    case 'zh-Hant-HK':
      return 'zh-Hant'
    default:
      return normalized
  }
}

const wgs84ToGcj02 = (lng: number, lat: number): [number, number] => {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) {
    return [lng, lat]
  }
  const pi = Math.PI
  const a = 6378245
  const ee = 0.006693421622965943
  const transformLat = (x: number, y: number) => {
    let value =
      -100 +
      2 * x +
      3 * y +
      0.2 * y * y +
      0.1 * x * y +
      0.2 * Math.sqrt(Math.abs(x))
    value += ((20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2) / 3
    value += ((20 * Math.sin(y * pi) + 40 * Math.sin((y / 3) * pi)) * 2) / 3
    value +=
      ((160 * Math.sin((y / 12) * pi) + 320 * Math.sin((y * pi) / 30)) * 2) / 3
    return value
  }
  const transformLng = (x: number, y: number) => {
    let value =
      300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
    value += ((20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2) / 3
    value += ((20 * Math.sin(x * pi) + 40 * Math.sin((x / 3) * pi)) * 2) / 3
    value +=
      ((150 * Math.sin((x / 12) * pi) + 300 * Math.sin((x / 30) * pi)) * 2) / 3
    return value
  }
  let deltaLat = transformLat(lng - 105, lat - 35)
  let deltaLng = transformLng(lng - 105, lat - 35)
  const radLat = (lat / 180) * pi
  let magic = Math.sin(radLat)
  magic = 1 - ee * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  deltaLat = (deltaLat * 180) / (((a * (1 - ee)) / (magic * sqrtMagic)) * pi)
  deltaLng = (deltaLng * 180) / ((a / sqrtMagic) * Math.cos(radLat) * pi)
  return [lng + deltaLng, lat + deltaLat]
}

export class AMapGeocodingProvider implements GeocodingProvider {
  private readonly baseUrl = 'https://restapi.amap.com'
  private lastRequestTime = 0
  private readonly rateLimitMs = 100

  constructor(private readonly webServiceKey: string) {}

  async reverseGeocode(lat: number, lon: number): Promise<LocationInfo | null> {
    try {
      return await withRetry(
        async () => {
          const elapsed = Date.now() - this.lastRequestTime
          if (elapsed < this.rateLimitMs) {
            await new Promise((resolve) =>
              setTimeout(resolve, this.rateLimitMs - elapsed),
            )
          }
          this.lastRequestTime = Date.now()

          const [gcjLng, gcjLat] = wgs84ToGcj02(lon, lat)
          const url = new URL('/v3/geocode/regeo', this.baseUrl)
          url.searchParams.set('key', this.webServiceKey)
          url.searchParams.set('location', `${gcjLng},${gcjLat}`)
          url.searchParams.set('extensions', 'base')
          url.searchParams.set('output', 'JSON')

          const response = await fetch(url)
          if (!response.ok) {
            throw new Error(
              `AMap API error: ${response.status} ${response.statusText}`,
            )
          }
          const data = await response.json()
          if (data?.status !== '1' || !data.regeocode) {
            throw new Error(
              `AMap API error: ${data?.infocode || 'unknown'} ${data?.info || ''}`,
            )
          }

          const address = data.regeocode.addressComponent || {}
          const cityValue = Array.isArray(address.city)
            ? address.province
            : address.city
          const city =
            cityValue || address.district || address.province || undefined

          return {
            latitude: lat,
            longitude: lon,
            country: address.country || undefined,
            city,
            locationName: data.regeocode.formatted_address || undefined,
          }
        },
        {
          ...RetryPresets.network,
          timeout: 10000,
          delayStrategy: 'exponential',
        },
        logger.location,
      )
    } catch (error) {
      logger.location.error(
        'AMap reverse geocoding failed after all retries:',
        error,
      )
      return null
    }
  }
}

/**
 * Mapbox 地理编码提供者
 * 高精度商业地理编码服务，支持全球范围和多语言
 */
export class MapboxGeocodingProvider implements GeocodingProvider {
  private accessToken: string
  private readonly baseUrl = 'https://api.mapbox.com'
  private lastRequestTime = 0
  private readonly rateLimitMs = 100 // Mapbox 默认速率限制为 1000/分钟，约60ms间隔

  constructor(accessToken: string) {
    this.accessToken = accessToken
  }

  async reverseGeocode(lat: number, lon: number): Promise<LocationInfo | null> {
    try {
      return await withRetry(
        async () => {
          // 应用速率限制
          await this.applyRateLimit()

          // 获取设置的地理编码语言，默认简体中文
          const language = await settingsManager.get<string>(
            'location',
            'language',
            DEFAULT_LOCATION_LANGUAGE,
          )

          const url = new URL('/search/geocode/v6/reverse', this.baseUrl)
          url.searchParams.set('access_token', this.accessToken)
          url.searchParams.set('longitude', lon.toString())
          url.searchParams.set('latitude', lat.toString())
          url.searchParams.set('types', 'address,place,district,region,country')

          url.searchParams.set('language', toMapboxLanguage(language))

          logger.location.info(`Mapbox API URL: ${url.toString()}`)

          const response = await fetch(url.toString())

          if (!response.ok) {
            throw new Error(
              `Mapbox API error: ${response.status} ${response.statusText}`,
            )
          }

          const data = await response.json()

          if (!data || !data.features || data.features.length === 0) {
            logger.location.warn('Mapbox API returned no features')
            return null
          }

          // 取第一个最相关的结果
          const feature = data.features[0]
          const properties = feature.properties || {}
          const context = properties.context || {}

          // 提取国家信息
          const country = context.country?.name

          // 提取城市信息（优先级：locality > place > locality > district > region）
          const city =
            context.locality?.name ||
            context.place?.name ||
            context.locality?.name ||
            context.district?.name ||
            context.region?.name

          // 构建位置名称
          const locationName = properties.place_formatted || properties.name

          logger.location.success(
            `Successfully geocoded location: ${city}, ${country}`,
          )
          return {
            latitude: lat,
            longitude: lon,
            country,
            city,
            locationName,
          }
        },
        {
          ...RetryPresets.network,
          timeout: 10000,
          delayStrategy: 'exponential',
        },
        logger.location,
      )
    } catch (error) {
      logger.location.error(
        'Mapbox reverse geocoding failed after all retries:',
        error,
      )
      return null
    }
  }

  private async applyRateLimit(): Promise<void> {
    const now = Date.now()
    const timeSinceLastRequest = now - this.lastRequestTime

    if (timeSinceLastRequest < this.rateLimitMs) {
      const delay = this.rateLimitMs - timeSinceLastRequest
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    this.lastRequestTime = Date.now()
  }
}

/**
 * OpenStreetMap Nominatim API 地理编码提供者
 * 免费的地理编码服务，适合开发和小规模使用
 */
export class NominatimGeocodingProvider implements GeocodingProvider {
  private readonly baseUrl: string
  private readonly userAgent = 'chronoframe/1.0'
  private lastRequestTime = 0
  private readonly rateLimitMs = 1000 // Nominatim 要求至少1秒间隔

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || 'https://nominatim.openstreetmap.org'
  }

  async reverseGeocode(lat: number, lon: number): Promise<LocationInfo | null> {
    try {
      return await withRetry(
        async () => {
          // 应用速率限制
          await this.applyRateLimit()

          // 获取设置的地理编码语言，默认简体中文
          const language = normalizeLocationLanguage(
            await settingsManager.get<string>(
              'location',
              'language',
              DEFAULT_LOCATION_LANGUAGE,
            ),
          )

          const url = new URL('/reverse', this.baseUrl)
          url.searchParams.set('lat', lat.toString())
          url.searchParams.set('lon', lon.toString())
          url.searchParams.set('format', 'json')
          url.searchParams.set('addressdetails', '1')
          url.searchParams.set('accept-language', `${language},zh-CN,en`)

          const response = await fetch(url.toString(), {
            headers: {
              'User-Agent': this.userAgent,
            },
          })

          if (!response.ok) {
            throw new Error(
              `Nominatim API error: ${response.status} ${response.statusText}`,
            )
          }

          const data = await response.json()

          if (!data || data.error) {
            throw new Error(`Nominatim API returned error: ${data?.error}`)
          }

          const address = data.address || {}

          // 提取国家信息
          const country = address.country || address.country_code?.toUpperCase()

          // 提取城市信息（优先级：district > city > town > county > state > village > hamlet）
          // 适配中国行政区划
          const city =
            address.district ||
            address.city ||
            address.town ||
            address.county ||
            address.state ||
            address.village ||
            address.hamlet

          // 构建位置名称
          const locationName = data.display_name

          return {
            latitude: lat,
            longitude: lon,
            country,
            city,
            locationName,
          }
        },
        {
          ...RetryPresets.network,
          timeout: 15000, // Nominatim 可能比较慢
          delayStrategy: 'linear', // 线性退避，避免过快重试
        },
        logger.location,
      )
    } catch (error) {
      logger.location.error(
        'Nominatim reverse geocoding failed after all retries:',
        error,
      )
      return null
    }
  }

  private async applyRateLimit(): Promise<void> {
    const now = Date.now()
    const timeSinceLastRequest = now - this.lastRequestTime

    if (timeSinceLastRequest < this.rateLimitMs) {
      const delay = this.rateLimitMs - timeSinceLastRequest
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    this.lastRequestTime = Date.now()
  }
}

/**
 * 创建地理编码提供者实例
 * @description 按配置选择提供者；auto 保持旧版本的 Mapbox/Nominatim 回退行为
 */
async function createGeocodingProvider(): Promise<GeocodingProvider> {
  const provider =
    (await settingsManager.get<string>('location', 'provider')) || 'auto'
  const mapboxToken = await settingsManager.get<string>(
    'location',
    'mapbox.token',
  )
  const amapKey = await settingsManager.get<string>(
    'location',
    'amap.webServiceKey',
  )
  const nominatimBaseUrl =
    (await settingsManager.get<string>('location', 'nominatim.baseUrl')) ||
    undefined

  if (provider === 'amap') {
    if (!amapKey) {
      throw new Error('AMap Web Service key is required')
    }
    return new AMapGeocodingProvider(amapKey)
  }
  if (provider === 'mapbox') {
    if (!mapboxToken) {
      throw new Error('Mapbox token is required')
    }
    return new MapboxGeocodingProvider(mapboxToken)
  }
  if (provider === 'nominatim') {
    return new NominatimGeocodingProvider(nominatimBaseUrl)
  }

  if (mapboxToken) return new MapboxGeocodingProvider(mapboxToken)
  return new NominatimGeocodingProvider(nominatimBaseUrl)
}

export async function extractLocationFromGPS(
  gpsLatitude?: number,
  gpsLongitude?: number,
  provider?: GeocodingProvider,
): Promise<LocationInfo | null> {
  if (!gpsLatitude || !gpsLongitude) {
    return null
  }

  // 验证坐标范围
  if (Math.abs(gpsLatitude) > 90 || Math.abs(gpsLongitude) > 180) {
    logger.location.warn(
      `Invalid GPS coordinates: ${gpsLatitude}, ${gpsLongitude}`,
    )
    return null
  }

  logger.location.info(
    `Reverse geocoding coordinates: ${gpsLatitude}, ${gpsLongitude}`,
  )

  // 如果没有指定提供者，使用默认提供者
  const geocodingProvider = provider || (await createGeocodingProvider())

  try {
    const locationInfo = await geocodingProvider.reverseGeocode(
      gpsLatitude,
      gpsLongitude,
    )

    if (locationInfo) {
      logger.location.success(
        `Location found: ${locationInfo.city}, ${locationInfo.country}`,
      )
    } else {
      logger.location.warn('No location found for coordinates')
    }

    return locationInfo
  } catch (error) {
    logger.location.error('Location extraction failed:', error)
    return null
  }
}

/**
 * 解析EXIF GPS数据为十进制度数
 */
export function parseGPSCoordinates(exifData: any): {
  latitude?: number
  longitude?: number
} {
  try {
    let latitude: number | undefined
    let longitude: number | undefined

    // 尝试从GPSLatitude和GPSLongitude获取
    if (exifData.GPSLatitude && exifData.GPSLongitude) {
      latitude = parseFloat(exifData.GPSLatitude.toString())
      longitude = parseFloat(exifData.GPSLongitude.toString())
    }

    // 如果上面的方法失败，尝试从GPSCoordinates获取
    if ((!latitude || !longitude) && exifData.GPSCoordinates) {
      const coords = exifData.GPSCoordinates.toString()
      const match = coords.match(/([-+]?\d+\.?\d*)[°,\s]+([-+]?\d+\.?\d*)/)
      if (match) {
        latitude = parseFloat(match[1])
        longitude = parseFloat(match[2])
      }
    }

    // 应用GPS参考（南纬为负，西经为负）
    if (latitude && exifData.GPSLatitudeRef === 'S') {
      latitude = -Math.abs(latitude)
    }
    if (longitude && exifData.GPSLongitudeRef === 'W') {
      longitude = -Math.abs(longitude)
    }

    return { latitude, longitude }
  } catch (error) {
    logger.location.error('Failed to parse GPS coordinates:', error)
    return {}
  }
}
