import { getAccessVersion } from '~~/server/utils/og-media'

export default eventHandler(async (event) => {
  const [state, limits, photos] = await Promise.all([
    getAccessState(event),
    getPreviewLimits(),
    getPublicPhotos(),
  ])
  const accessVersion = await getAccessVersion()
  return toPublicPhotos(
    state.granted ? photos : photos.slice(0, limits.photoLimit),
    accessVersion,
  )
})
