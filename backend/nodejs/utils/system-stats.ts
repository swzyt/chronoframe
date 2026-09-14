import { and, eq, gte } from 'drizzle-orm'
import { photos } from '../database/schema'

export function buildPhotoStatsWhere(
  user: { id: number; isAdmin: number },
  takenAfter?: string,
) {
  return and(
    user.isAdmin ? undefined : eq(photos.ownerUserId, user.id),
    takenAfter ? gte(photos.dateTaken, takenAfter) : undefined,
  )
}
