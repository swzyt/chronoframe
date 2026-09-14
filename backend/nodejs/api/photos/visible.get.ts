import { getAccessVersion } from '#server/utils/og-media'

export default eventHandler(async (event) => {
  const [state, limits] = await Promise.all([
    getAccessState(event),
    getPreviewLimits(),
  ])
  const photos = await getPublicPhotos({
    limit: state.granted ? undefined : limits.photoLimit,
  })
  const accessVersion = await getAccessVersion()
  return toPublicPhotos(photos, accessVersion)
})
