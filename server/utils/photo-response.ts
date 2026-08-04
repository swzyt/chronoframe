import type { Photo } from '~~/server/utils/db'
import { createOgMediaToken } from '~~/server/utils/og-media'
import type { PublicOwner } from '~~/server/utils/owner-response'
import { getOwnerMap } from '~~/server/utils/owner-response'

const encodeStorageKey = (key: string) =>
  key.split('/').map(encodeURIComponent).join('/')

const getOriginalProxyUrl = (photo: Photo, storageKey: string | null) => {
  if (photo.originalUrl?.startsWith('/image/')) {
    return photo.originalUrl
  }
  if (photo.originalUrl?.startsWith('/storage/')) {
    return `/image/${encodeStorageKey(photo.originalUrl.slice('/storage/'.length))}`
  }
  return storageKey ? `/image/${encodeStorageKey(storageKey)}` : null
}

const getDisplayProxyUrl = (photo: Photo, originalUrl: string | null) => {
  if (photo.mediaType === 'video') return originalUrl
  return `/display/${encodeURIComponent(photo.id)}`
}

export async function toPublicPhoto(
  photo: Photo,
  accessVersion?: string,
  owner?: PublicOwner | null,
) {
  const {
    storageKey,
    thumbnailKey,
    displayKey: _displayKey,
    livePhotoVideoKey,
    videoPlaybackKey,
    ownerUserId: _ownerUserId,
    ...safe
  } = photo
  const originalUrl = getOriginalProxyUrl(photo, videoPlaybackKey || storageKey)

  return {
    ...safe,
    originalUrl,
    displayUrl: getDisplayProxyUrl(photo, originalUrl),
    thumbnailUrl: thumbnailKey
      ? `/image/${encodeStorageKey(thumbnailKey)}`
      : null,
    livePhotoVideoUrl: livePhotoVideoKey
      ? `/image/${encodeStorageKey(livePhotoVideoKey)}`
      : null,
    owner: owner || null,
    ogThumbnailUrl: thumbnailKey
      ? `/og-media/${encodeURIComponent(photo.id)}?token=${encodeURIComponent(
          await createOgMediaToken(photo.id, thumbnailKey, accessVersion),
        )}`
      : null,
  }
}

export async function toPublicPhotos(photos: Photo[], accessVersion?: string) {
  const owners = await getOwnerMap(photos.map((photo) => photo.ownerUserId))
  return Promise.all(
    photos.map((photo) =>
      toPublicPhoto(
        photo,
        accessVersion,
        owners.get(photo.ownerUserId) || null,
      ),
    ),
  )
}
