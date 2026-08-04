export default eventHandler(async (event) => {
  const [state, limits] = await Promise.all([
    getAccessState(event),
    getPreviewLimits(),
  ])

  return getPublicPhotoMarkers({
    limit: state.granted ? undefined : limits.photoLimit,
  })
})
