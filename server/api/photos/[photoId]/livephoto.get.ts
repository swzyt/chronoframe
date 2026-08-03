export default eventHandler(async (event) => {
  const photoId = getRouterParam(event, 'photoId')

  if (!photoId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Photo ID is required',
    })
  }

  try {
    await requirePublicPhotoAccess(event, photoId)
    const photo = useDB()
      .select()
      .from(tables.photos)
      .where(eq(tables.photos.id, photoId))
      .get()
    if (!photo) {
      throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
    }

    return {
      id: photo.id,
      title: photo.title,
      isLivePhoto: Boolean(photo.isLivePhoto),
      livePhotoVideoUrl: photo.livePhotoVideoUrl,
      originalUrl: photo.originalUrl,
      thumbnailUrl: photo.thumbnailUrl,
    }
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode) {
      throw error
    }
    logger.chrono.error('Failed to get photo details:', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to get photo details',
    })
  }
})
