import { and, count, eq, ne } from 'drizzle-orm'
import { z } from 'zod'

export default eventHandler(async (event) => {
  const actor = await requireAdmin(event)
  const id = z.coerce.number().int().positive().parse(getRouterParam(event, 'id'))
  const body = await readValidatedBody(
    event,
    z
      .object({
        username: z.string().trim().min(2).max(64).optional(),
        email: z
          .email()
          .transform((value) => value.trim().toLowerCase())
          .optional(),
        password: z.string().min(8).max(128).optional(),
        isAdmin: z.boolean().optional(),
        isActive: z.boolean().optional(),
      })
      .refine((value) => Object.keys(value).length > 0)
      .parse,
  )
  const db = useDB()
  const target = db
    .select()
    .from(tables.users)
    .where(eq(tables.users.id, id))
    .get()
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }
  if (
    id === actor.id &&
    (body.isAdmin === false || body.isActive === false)
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: 'You cannot demote or disable your own account',
    })
  }
  if (
    target.isAdmin &&
    target.isActive &&
    (body.isAdmin === false || body.isActive === false)
  ) {
    const admins = db
      .select({ value: count() })
      .from(tables.users)
      .where(
        and(
          eq(tables.users.isAdmin, 1),
          eq(tables.users.isActive, true),
          ne(tables.users.id, id),
        ),
      )
      .get()
    if (!admins?.value) {
      throw createError({
        statusCode: 400,
        statusMessage: 'At least one active administrator is required',
      })
    }
  }

  const updates: Record<string, unknown> = { ...body }
  if (body.password) updates.password = await hashPassword(body.password)
  if (body.isAdmin !== undefined) updates.isAdmin = body.isAdmin ? 1 : 0
  return db
    .update(tables.users)
    .set(updates)
    .where(eq(tables.users.id, id))
    .returning({
      id: tables.users.id,
      username: tables.users.username,
      email: tables.users.email,
      isAdmin: tables.users.isAdmin,
      isActive: tables.users.isActive,
    })
    .get()
})
