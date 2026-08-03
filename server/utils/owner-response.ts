import { inArray } from 'drizzle-orm'
import type { User } from '~~/server/utils/db'

export interface PublicOwner {
  id: number
  username: string
  avatar: string | null
  isAdmin: number
}

export const toPublicOwner = (user: User): PublicOwner => ({
  id: user.id,
  username: user.username,
  avatar: user.avatar,
  isAdmin: user.isAdmin,
})

export async function getOwnerMap(ownerUserIds: Array<number | null | undefined>) {
  const ids = [...new Set(ownerUserIds.filter((id): id is number => id != null))]
  if (ids.length === 0) return new Map<number, PublicOwner>()

  const users = await useDB()
    .select({
      id: tables.users.id,
      username: tables.users.username,
      avatar: tables.users.avatar,
      isAdmin: tables.users.isAdmin,
    })
    .from(tables.users)
    .where(inArray(tables.users.id, ids))

  return new Map(users.map((user) => [user.id, user]))
}

export async function withOwners<T extends { ownerUserId: number }>(
  records: T[],
) {
  const owners = await getOwnerMap(records.map((record) => record.ownerUserId))
  return records.map((record) => ({
    ...record,
    owner: owners.get(record.ownerUserId) || null,
  }))
}
