import type {
  PhotoMapResponse,
  PhotoMarker,
  PhotoMarkerCluster,
} from '~~/shared/types/map'

const parseFinite = (value: unknown) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

const parseBounds = (query: Record<string, any>) => {
  const west = parseFinite(query.west)
  const east = parseFinite(query.east)
  const south = parseFinite(query.south)
  const north = parseFinite(query.north)
  if (
    west === undefined ||
    east === undefined ||
    south === undefined ||
    north === undefined
  ) {
    return undefined
  }

  return {
    west: Math.max(-180, Math.min(180, west)),
    east: Math.max(-180, Math.min(180, east)),
    south: Math.max(-90, Math.min(90, south)),
    north: Math.max(-90, Math.min(90, north)),
  }
}

interface MarkerBucket {
  markers: PhotoMarker[]
  longitudeSum: number
  latitudeSum: number
}

const buildMarkerBuckets = (markers: PhotoMarker[], cellSize: number) => {
  const buckets = new Map<string, MarkerBucket>()

  for (const marker of markers) {
    const cellX = Math.floor((marker.longitude + 180) / cellSize)
    const cellY = Math.floor((marker.latitude + 90) / cellSize)
    const key = `${cellX}:${cellY}`
    const bucket = buckets.get(key)

    if (bucket) {
      bucket.markers.push(marker)
      bucket.longitudeSum += marker.longitude
      bucket.latitudeSum += marker.latitude
      continue
    }

    buckets.set(key, {
      markers: [marker],
      longitudeSum: marker.longitude,
      latitudeSum: marker.latitude,
    })
  }

  return buckets
}

const clusterMarkersForApi = (
  markers: PhotoMarker[],
  zoom: number,
  maxRenderedPoints = 520,
) => {
  if (markers.length <= maxRenderedPoints || zoom >= 12) {
    return {
      markers,
      clusters: [] as PhotoMarkerCluster[],
      clustered: false,
    }
  }

  let cellSize = Math.max(0.00025, 0.01 / Math.pow(2, zoom - 10))
  let buckets = buildMarkerBuckets(markers, cellSize)

  for (
    let attempts = 0;
    buckets.size > maxRenderedPoints && attempts < 8;
    attempts += 1
  ) {
    cellSize *= 1.8
    buckets = buildMarkerBuckets(markers, cellSize)
  }

  const clusteredMarkers: PhotoMarker[] = []
  const clusters: PhotoMarkerCluster[] = []
  let index = 0
  for (const bucket of buckets.values()) {
    if (bucket.markers.length === 1) {
      clusteredMarkers.push(bucket.markers[0]!)
      continue
    }

    clusters.push({
      id: `cluster-${index++}`,
      latitude: bucket.latitudeSum / bucket.markers.length,
      longitude: bucket.longitudeSum / bucket.markers.length,
      count: bucket.markers.length,
      clusteredPhotos: bucket.markers.slice(0, 48),
    })
  }

  return {
    markers: clusteredMarkers,
    clusters,
    clustered: true,
  }
}

export default eventHandler(async (event) => {
  const query = getQuery(event)
  const zoom = Math.max(0, Math.min(22, parseFinite(query.zoom) ?? 2))
  const bounds = parseBounds(query)
  const [state, limits] = await Promise.all([
    getAccessState(event),
    getPreviewLimits(),
  ])

  const markers = await getPublicPhotoMarkers({
    limit: state.granted ? undefined : limits.photoLimit,
    bounds,
  })
  const clustered = clusterMarkersForApi(markers, zoom)

  return {
    ...clustered,
    total: markers.length,
  } satisfies PhotoMapResponse
})
