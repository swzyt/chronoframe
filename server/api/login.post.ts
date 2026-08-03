import { z } from 'zod'

const _invalidCredentialsError = createError({
  statusCode: 401,
  message: 'Invalid credentials',
})

export default eventHandler(async (event) => {
  const db = useDB()
  const { email: rawEmail, password } = await readValidatedBody(
    event,
    z.object({
      email: z.email(),
      password: z.string().min(6),
    }).parse,
  )
  const email = rawEmail.trim().toLowerCase()

  const user = db
    .select()
    .from(tables.users)
    .where(eq(tables.users.email, email))
    .get()

  if (!user?.isActive) {
    throw _invalidCredentialsError
  }

  if (!(await verifyPassword(user.password || '', password))) {
    throw _invalidCredentialsError
  }

  await setUserSession(
    event,
    { user },
    {
      cookie: {
        // secure: !useRuntimeConfig().allowInsecureCookie,
        secure: false,
      },
    },
  )

  return setResponseStatus(event, 201)
})
