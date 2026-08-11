import { settingsManager } from '~~/server/services/settings/settingsManager'

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token') || ''
  const { share, owner } = await requireUploadShare(token)
  const maxFileSizeMB =
    (await settingsManager.get<number>('system', 'upload.maxFileSize')) ?? 256

  return {
    id: share.id,
    label: share.label,
    expiresAt: share.expiresAt?.toISOString() || null,
    uploadCount: share.uploadCount,
    maxUploads: share.maxUploads,
    owner: {
      username: owner.username,
      avatar: owner.avatar,
    },
    maxFileSizeMB,
  }
})
