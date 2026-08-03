import { photos } from '~~/server/database/schema'
import { eq } from 'drizzle-orm'

export default eventHandler(async (event) => {
  const user = await requireCurrentUser(event)

  const method = getMethod(event)

  if (method === 'GET') {
    // 获取最新处理完成的照片
    const recentPhotos = user.isAdmin
      ? await useDB()
          .select()
          .from(photos)
          .orderBy(photos.lastModified)
          .limit(10)
          .all()
      : await useDB()
          .select()
          .from(photos)
          .where(eq(photos.ownerUserId, user.id))
          .orderBy(photos.lastModified)
          .limit(10)
          .all()

    return {
      recentPhotos,
      timestamp: new Date().toISOString(),
    }
  } else {
    throw createError({
      statusCode: 405,
      statusMessage: 'Method not allowed',
    })
  }
})
