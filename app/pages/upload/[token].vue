<script setup lang="ts">
import type { UploadProgress } from '~/composables/useUpload'

definePageMeta({
  layout: false,
})

useHead({
  title: () => $t('uploadShare.page.title'),
})

interface UploadShareStatus {
  id: number
  label: string | null
  expiresAt: string | null
  uploadCount: number
  maxUploads: number | null
  owner: {
    username: string
    avatar: string | null
  }
  maxFileSizeMB: number
}

interface GuestUploadFile {
  id: string
  file: File
  status: 'waiting' | 'preparing' | 'uploading' | 'processing' | 'completed' | 'error'
  progress: number
  message?: string
}

const route = useRoute()
const token = computed(() => String(route.params.token || ''))
const toast = useToast()
const selectedFiles = ref<File[]>([])
const uploadingFiles = ref<GuestUploadFile[]>([])
const isUploading = ref(false)

const { data: share, status, error, refresh } = await useFetch<UploadShareStatus>(
  () => `/api/upload-shares/public/${encodeURIComponent(token.value)}`,
)

const maxFileSizeMB = computed(() => share.value?.maxFileSizeMB || 256)
const maxBytes = computed(() => maxFileSizeMB.value * 1024 * 1024)

const hasSelectedFiles = computed(() => selectedFiles.value.length > 0)

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

const validateFile = (file: File) => {
  const supported =
    file.type.startsWith('image/') ||
    file.type === 'video/mp4' ||
    file.type === 'video/quicktime' ||
    /\.(heic|heif|jpg|jpeg|png|webp|gif|bmp|tif|tiff|avif|mov|mp4)$/i.test(
      file.name,
    )

  if (!supported) {
    return $t('uploadShare.errors.unsupported')
  }

  if (file.size > maxBytes.value) {
    return $t('uploadShare.errors.tooLarge', {
      maxSize: maxFileSizeMB.value,
    })
  }

  return null
}

const submitTask = async (file: File, fileKey: string) => {
  const lowerName = file.name.toLowerCase()
  const isMovFile = file.type === 'video/quicktime' || lowerName.endsWith('.mov')
  const isMp4File = file.type === 'video/mp4' || lowerName.endsWith('.mp4')

  return await $fetch(
    `/api/upload-shares/public/${encodeURIComponent(token.value)}/task`,
    {
      method: 'POST',
      body: {
        payload: {
          type: isMovFile ? 'live-photo-video' : isMp4File ? 'video' : 'photo',
          storageKey: fileKey,
        },
      },
    },
  )
}

const uploadOne = async (item: GuestUploadFile) => {
  item.status = 'preparing'
  item.progress = 0

  const uploadManager = useUpload({
    timeout: 10 * 60 * 1000,
  })

  const prepared = await $fetch(
    `/api/upload-shares/public/${encodeURIComponent(token.value)}/prepare`,
    {
      method: 'POST',
      body: {
        fileName: item.file.name,
        contentType: item.file.type || 'application/octet-stream',
      },
    },
  )

  item.status = 'uploading'

  await uploadManager.uploadFile(item.file, prepared.signedUrl, {
    onProgress: (progress: UploadProgress) => {
      item.progress = progress.percentage
    },
    onError: (message: string) => {
      item.status = 'error'
      item.message = message
    },
  })

  item.status = 'processing'
  item.progress = 100
  await submitTask(item.file, prepared.fileKey)
  item.status = 'completed'
  item.message = $t('uploadShare.status.completed')
}

const startUpload = async () => {
  if (!selectedFiles.value.length || isUploading.value) return

  const items: GuestUploadFile[] = []
  for (const file of selectedFiles.value) {
    const errorMessage = validateFile(file)
    items.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}-${file.name}`,
      file,
      status: errorMessage ? 'error' : 'waiting',
      progress: 0,
      message: errorMessage || undefined,
    })
  }

  uploadingFiles.value = items
  selectedFiles.value = []
  isUploading.value = true

  const queue = items.filter((item) => item.status === 'waiting')
  const concurrentLimit = 3
  const workers = Array.from({ length: concurrentLimit }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) return
      try {
        await uploadOne(item)
      } catch (uploadError: any) {
        item.status = 'error'
        item.message =
          uploadError?.data?.message ||
          uploadError?.message ||
          $t('uploadShare.errors.uploadFailed')
      }
    }
  })

  await Promise.all(workers)
  isUploading.value = false
  await refresh()

  const successCount = uploadingFiles.value.filter(
    (item) => item.status === 'completed',
  ).length
  toast.add({
    title: $t('uploadShare.toast.finished.title'),
    description: $t('uploadShare.toast.finished.description', {
      count: successCount,
      total: uploadingFiles.value.length,
    }),
    color: successCount > 0 ? 'success' : 'error',
  })
}
</script>

<template>
  <div
    class="min-h-screen overflow-x-hidden bg-neutral-950 text-white selection:bg-primary-400/30"
  >
    <div
      class="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,rgba(99,102,241,0.32),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(20,184,166,0.24),transparent_36%)]"
    />

    <main class="relative mx-auto flex min-h-screen w-full max-w-4xl min-w-0 flex-col px-5 py-10">
      <NuxtLink
        to="/"
        class="mb-8 inline-flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/10 px-4 py-2 text-sm text-white/80 backdrop-blur transition hover:bg-white/15 hover:text-white"
      >
        <Icon name="tabler:arrow-left" class="size-4" />
        {{ $t('uploadShare.actions.backHome') }}
      </NuxtLink>

      <UCard
        class="min-w-0 overflow-hidden border-white/10 bg-white/10 shadow-2xl shadow-black/30 backdrop-blur-xl"
        :ui="{ body: 'p-0 sm:p-0' }"
      >
        <div class="grid min-w-0 gap-0 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <section class="min-w-0 border-b border-white/10 p-8 md:border-b-0 md:border-r">
            <div v-if="status === 'pending'" class="space-y-4">
              <USkeleton class="h-8 w-48 bg-white/10" />
              <USkeleton class="h-24 w-full bg-white/10" />
            </div>

            <div v-else-if="error" class="space-y-5">
              <div
                class="flex size-14 items-center justify-center rounded-2xl bg-error-500/15 text-error-200"
              >
                <Icon name="tabler:link-off" class="size-7" />
              </div>
              <div>
                <h1 class="text-2xl font-semibold">
                  {{ $t('uploadShare.invalid.title') }}
                </h1>
                <p class="mt-2 text-sm leading-6 text-white/60">
                  {{ $t('uploadShare.invalid.description') }}
                </p>
              </div>
            </div>

            <div v-else-if="share" class="space-y-7">
              <div>
                <p class="text-sm uppercase tracking-[0.28em] text-primary-200/80">
                  {{ $t('uploadShare.kicker') }}
                </p>
                <h1 class="mt-4 text-3xl font-semibold tracking-tight">
                  {{ share.label || $t('uploadShare.page.heading') }}
                </h1>
                <p class="mt-3 text-sm leading-6 text-white/62">
                  {{
                    $t('uploadShare.page.description', {
                      owner: share.owner.username,
                    })
                  }}
                </p>
              </div>

              <div class="flex items-center gap-3 rounded-2xl bg-white/8 p-4">
                <UAvatar
                  :src="share.owner.avatar || undefined"
                  :alt="share.owner.username"
                  size="lg"
                />
                <div class="min-w-0">
                  <p class="text-sm text-white/50">
                    {{ $t('uploadShare.owner') }}
                  </p>
                  <p class="truncate font-medium">{{ share.owner.username }}</p>
                </div>
              </div>

              <div class="grid gap-3 text-sm text-white/62">
                <div class="flex items-center gap-2">
                  <Icon name="tabler:file-upload" class="size-4" />
                  {{
                    $t('uploadShare.limit.maxSize', {
                      size: maxFileSizeMB,
                    })
                  }}
                </div>
                <div v-if="share.maxUploads" class="flex items-center gap-2">
                  <Icon name="tabler:hash" class="size-4" />
                  {{
                    $t('uploadShare.limit.count', {
                      used: share.uploadCount,
                      total: share.maxUploads,
                    })
                  }}
                </div>
                <div v-if="share.expiresAt" class="flex items-center gap-2">
                  <Icon name="tabler:calendar-time" class="size-4" />
                  {{
                    $t('uploadShare.limit.expiresAt', {
                      date: new Date(share.expiresAt).toLocaleString(),
                    })
                  }}
                </div>
              </div>
            </div>
          </section>

          <section class="min-w-0 p-8">
            <div v-if="share" class="min-w-0 space-y-6">
              <UFileUpload
                v-model="selectedFiles"
                :label="$t('uploadShare.uploader.label')"
                :description="
                  $t('uploadShare.uploader.description', {
                    maxSize: maxFileSizeMB,
                  })
                "
                icon="tabler:cloud-upload"
                layout="list"
                size="xl"
                accept="image/jpeg,image/png,image/heic,image/heif,image/webp,image/gif,image/tiff,image/avif,video/quicktime,video/mp4,.heic,.heif,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.avif,.mov,.mp4"
                multiple
                highlight
                dropzone
                :disabled="isUploading"
                :file-delete="{ variant: 'soft', color: 'neutral' }"
                :ui="{
                  base: 'border-white/15 bg-white/8 hover:bg-white/12 hover:border-primary-300/50',
                  label: 'text-white',
                  description: 'text-white/55',
                  file: 'min-w-0 border-white/10 bg-white/8',
                  fileName: 'min-w-0 whitespace-normal break-all text-white',
                  fileSize: 'text-white/50',
                }"
              />

              <UButton
                block
                size="xl"
                icon="tabler:upload"
                :loading="isUploading"
                :disabled="!hasSelectedFiles || isUploading"
                @click="startUpload"
              >
                {{
                  hasSelectedFiles
                    ? $t('uploadShare.actions.uploadSelected', {
                        count: selectedFiles.length,
                      })
                    : $t('uploadShare.actions.selectFiles')
                }}
              </UButton>

              <div v-if="uploadingFiles.length" class="min-w-0 space-y-3">
                <div
                  v-for="item in uploadingFiles"
                  :key="item.id"
                  class="min-w-0 rounded-2xl border border-white/10 bg-white/8 p-4"
                >
                  <div class="flex min-w-0 items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="break-all text-sm font-medium leading-5">
                        {{ item.file.name }}
                      </p>
                      <p class="text-xs text-white/45">
                        {{ formatBytes(item.file.size) }}
                      </p>
                    </div>
                    <UBadge
                      :color="
                        item.status === 'completed'
                          ? 'success'
                          : item.status === 'error'
                            ? 'error'
                            : 'primary'
                      "
                      variant="soft"
                      class="shrink-0"
                    >
                      {{ $t(`uploadShare.status.${item.status}`) }}
                    </UBadge>
                  </div>
                  <UProgress
                    v-if="item.status !== 'error'"
                    class="mt-3"
                    :model-value="item.progress"
                  />
                  <p v-if="item.message" class="mt-2 break-words text-xs text-white/55">
                    {{ item.message }}
                  </p>
                </div>
              </div>
            </div>
          </section>
        </div>
      </UCard>
    </main>
  </div>
</template>
