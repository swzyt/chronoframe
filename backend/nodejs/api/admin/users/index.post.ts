import { z } from 'zod'

export default eventHandler(async (event) => {
  await requireAdmin(event)
  const body = await readValidatedBody(
    event,
    z
      .object({
        username: z.string().trim().min(2).max(64),
        email: z.email().transform((value) => value.trim().toLowerCase()),
        password: z.string().min(8).max(128),
        isAdmin: z.boolean().default(false),
      })
      .parse,
  )

  try {
    return useDB()
      .insert(tables.users)
      .values({
        ...body,
        password: await hashPassword(body.password),
        isAdmin: body.isAdmin ? 1 : 0,
        isActive: true,
        createdAt: new Date(),
      })
      .returning({
        id: tables.users.id,
        username: tables.users.username,
        email: tables.users.email,
        isAdmin: tables.users.isAdmin,
        isActive: tables.users.isActive,
      })
      .get()
  } catch {
    throw createError({
      statusCode: 409,
      statusMessage: 'Username or email already exists',
    })
  }
})
