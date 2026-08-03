import type { PhotoMarker, ClusterPoint } from '~~/shared/types/map'

interface MarkerBucket {
  markers: PhotoMarker[]
  longitudeSum: number
  latitudeSum: number
}

interface ClusterOptions {
  maxRenderedPoints?: number
}

const toSinglePoint = (marker: PhotoMarker): ClusterPoint => ({
  type: 'Feature',
  properties: { marker },
  geometry: {
    type: 'Point',
    coordinates: [marker.longitude, marker.latitude],
  },
})

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
    } else {
      buckets.set(key, {
        markers: [marker],
        longitudeSum: marker.longitude,
        latitudeSum: marker.latitude,
      })
    }
  }

  return buckets
}

const bucketsToClusterPoints = (buckets: Map<string, MarkerBucket>) => {
  return Array.from(buckets.values()).map((bucket) => {
    if (bucket.markers.length === 1) {
      return toSinglePoint(bucket.markers[0]!)
    }

    return {
      type: 'Feature',
      properties: {
        cluster: true,
        point_count: bucket.markers.length,
        point_count_abbreviated: bucket.markers.length.toString(),
        marker: bucket.markers[0],
        clusteredPhotos: bucket.markers,
      },
      geometry: {
        type: 'Point',
        coordinates: [
          bucket.longitudeSum / bucket.markers.length,
          bucket.latitudeSum / bucket.markers.length,
        ],
      },
    } satisfies ClusterPoint
  })
}

/**
 * Grid-based clustering for map markers.
 *
 * The old implementation compared every marker with every other marker. That
 * gets expensive very quickly on the globe page because zoom changes and
 * timeline playback can recompute clusters often. A grid bucket keeps the
 * result stable enough for map pins while making clustering roughly linear.
 */
export function clusterMarkers(
  markers: PhotoMarker[],
  zoom: number,
  options: ClusterOptions = {},
): ClusterPoint[] {
  if (markers.length === 0) return []

  if (markers.length === 1) {
    return [toSinglePoint(markers[0]!)]
  }

  const maxRenderedPoints = options.maxRenderedPoints ?? 600
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

  return bucketsToClusterPoints(buckets)
}

export function photosToMarkers(photos: Photo[]): PhotoMarker[] {
  return photos
    .filter(
      (photo) =>
        photo.latitude !== null &&
        photo.longitude !== null &&
        photo.latitude !== undefined &&
        photo.longitude !== undefined,
    )
    .map((photo) => ({
      id: photo.id,
      latitude: photo.latitude!,
      longitude: photo.longitude!,
      title: photo.title || undefined,
      thumbnailUrl: photo.thumbnailUrl || undefined,
      thumbnailHash: photo.thumbnailHash || undefined,
      dateTaken: photo.dateTaken || undefined,
      city: photo.city || undefined,
      exif: photo.exif || undefined,
    }))
}
