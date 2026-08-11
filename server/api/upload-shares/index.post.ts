import { z } from 'zod'

export default defineEventHandler(async (event) => {
  const user = await requireCurrentUser(event)
  const body = await readValidatedBody(
    event,
    z.object({
      label: z.string().trim().max(80).optional(),
      expiresInDays: z.number().int().min(1).max(365).optional().default(30),
      maxUploads: z.number().int().min(1).max(10000).nullable().optional(),
    }).parse,
  )

  const db = useDB()
  let token = generateUploadShareToken()
  let tokenHash = hashUploadShareToken(token)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = db
      .select({ id: tables.uploadShares.id })
      .from(tables.uploadShares)
      .where(eq(tables.uploadShares.tokenHash, tokenHash))
      .get()

    if (!existing) break
    token = generateUploadShareToken()
    tokenHash = hashUploadShareToken(token)
  }

  const expiresAt = new Date(Date.now() + body.expiresInDays * 86400000)
  const inserted = db
    .insert(tables.uploadShares)
    .values({
      tokenHash,
      ownerUserId: user.id,
      createdByUserId: user.id,
      label: body.label || null,
      maxUploads: body.maxUploads ?? null,
      expiresAt,
    })
    .returning()
    .get()

  return {
    ...serializeUploadShare(inserted),
    token,
    url: buildUploadShareUrl(event, token),
  }
})
