import type { InjectionKey, Ref } from 'vue'

export interface AMapContext {
  map: Ref<any | null>
  AMap: Ref<any | null>
}

export const AMAP_CONTEXT_KEY: InjectionKey<AMapContext> =
  Symbol('chronoframe-amap')

let loaderPromise: Promise<any> | null = null

export const loadAMap = (key: string, securityJsCode?: string) => {
  if (!import.meta.client) {
    return Promise.reject(new Error('AMap is only available in the browser'))
  }

  const windowWithAMap = window as any
  if (windowWithAMap.AMap) {
    return Promise.resolve(windowWithAMap.AMap)
  }
  if (loaderPromise) return loaderPromise

  if (securityJsCode) {
    windowWithAMap._AMapSecurityConfig = { securityJsCode }
  }

  loaderPromise = new Promise((resolve, reject) => {
    const callbackName = `__chronoframeAMapLoaded_${Date.now()}`
    windowWithAMap[callbackName] = () => {
      delete windowWithAMap[callbackName]
      resolve(windowWithAMap.AMap)
    }

    const script = document.createElement('script')
    script.src =
      `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}` +
      `&callback=${callbackName}`
    script.async = true
    script.onerror = () => {
      delete windowWithAMap[callbackName]
      loaderPromise = null
      reject(new Error('Failed to load AMap JavaScript API'))
    }
    document.head.appendChild(script)
  })

  return loaderPromise
}

const PI = Math.PI
const A = 6378245
const EE = 0.006693421622965943

const outOfChina = (lng: number, lat: number) =>
  lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271

const transformLat = (lng: number, lat: number) => {
  let value =
    -100 +
    2 * lng +
    3 * lat +
    0.2 * lat * lat +
    0.1 * lng * lat +
    0.2 * Math.sqrt(Math.abs(lng))
  value +=
    ((20 * Math.sin(6 * lng * PI) + 20 * Math.sin(2 * lng * PI)) * 2) / 3
  value +=
    ((20 * Math.sin(lat * PI) + 40 * Math.sin((lat / 3) * PI)) * 2) / 3
  value +=
    ((160 * Math.sin((lat / 12) * PI) +
      320 * Math.sin((lat * PI) / 30)) *
      2) /
    3
  return value
}

const transformLng = (lng: number, lat: number) => {
  let value =
    300 +
    lng +
    2 * lat +
    0.1 * lng * lng +
    0.1 * lng * lat +
    0.1 * Math.sqrt(Math.abs(lng))
  value +=
    ((20 * Math.sin(6 * lng * PI) + 20 * Math.sin(2 * lng * PI)) * 2) / 3
  value +=
    ((20 * Math.sin(lng * PI) + 40 * Math.sin((lng / 3) * PI)) * 2) / 3
  value +=
    ((150 * Math.sin((lng / 12) * PI) +
      300 * Math.sin((lng / 30) * PI)) *
      2) /
    3
  return value
}

export const wgs84ToGcj02 = (
  lng: number,
  lat: number,
): [number, number] => {
  if (outOfChina(lng, lat)) return [lng, lat]
  let deltaLat = transformLat(lng - 105, lat - 35)
  let deltaLng = transformLng(lng - 105, lat - 35)
  const radLat = (lat / 180) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  deltaLat =
    (deltaLat * 180) /
    (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  deltaLng =
    (deltaLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * PI)
  return [lng + deltaLng, lat + deltaLat]
}

export const gcj02ToWgs84 = (
  lng: number,
  lat: number,
): [number, number] => {
  if (outOfChina(lng, lat)) return [lng, lat]
  const [convertedLng, convertedLat] = wgs84ToGcj02(lng, lat)
  return [lng * 2 - convertedLng, lat * 2 - convertedLat]
}

