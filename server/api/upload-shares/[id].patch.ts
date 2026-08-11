import { z } from 'zod'

export default defineEventHandler(async (event) => {
  const user = await requireCurrentUser(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid share id' })
  }

  const body = await readValidatedBody(
    event,
    z.object({
      label: z.string().trim().max(80).nullable().optional(),
      isActive: z.boolean().optional(),
      maxUploads: z.number().int().min(1).max(10000).nullable().optional(),
    }).parse,
  )

  const existing = useDB()
    .select()
    .from(tables.uploadShares)
    .where(
      and(
        eq(tables.uploadShares.id, id),
        eq(tables.uploadShares.ownerUserId, user.id),
      ),
    )
    .get()

  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: 'Upload link not found' })
  }

  const updated = useDB()
    .update(tables.uploadShares)
    .set({
      ...(body.label !== undefined ? { label: body.label || null } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      ...(body.maxUploads !== undefined ? { maxUploads: body.maxUploads } : {}),
      updatedAt: new Date(),
    })
    .where(eq(tables.uploadShares.id, id))
    .returning()
    .get()

  return serializeUploadShare(updated)
})
