<script lang="ts" setup>
definePageMeta({
  layout: false,
})

type FlowPhoto = Photo & {
  originalUrl?: string | null
}

const { photos } = usePhotos()
const { accessEntitlement, unlockUrl } = useAccessEntitlement()
const route = useRoute()
const { openViewer } = useViewerState()

const getFlowImage = (photo: FlowPhoto) =>
  photo.thumbnailUrl || photo.originalUrl || photo.url || ''

const flowPhotos = computed(() => {
  const source = photos.value
    .filter((photo) => getFlowImage(photo as FlowPhoto))
    .map((photo, index) => ({
      photo,
      sort: Math.sin(index * 97.13) + Math.cos(index * 11.7),
    }))
    .toSorted((a, b) => a.sort - b.sort)
    .map(({ photo }) => photo)

  return source.length ? source : []
})

const isMobile = useMediaQuery('(max-width: 768px)')
const columnCount = computed(() => (isMobile.value ? 3 : 7))
const photosPerColumn = computed(() => (isMobile.value ? 8 : 10))
const columnDurations = computed(() =>
  Array.from({ length: columnCount.value }, (_, index) => 34 + index * 5),
)

const columns = computed(() => {
  const cols: Photo[][] = Array.from({ length: columnCount.value }, () => [])
  if (flowPhotos.value.length === 0) return cols

  for (let colIndex = 0; colIndex < columnCount.value; colIndex++) {
    for (let rowIndex = 0; rowIndex < photosPerColumn.value; rowIndex++) {
      const photoIndex =
        (colIndex * 2 + rowIndex * columnCount.value) % flowPhotos.value.length
      const photo = flowPhotos.value[photoIndex]
      if (photo) cols[colIndex]?.push(photo)
    }
  }

  return cols
})

const openFlowPhoto = (photo: Photo) => {
  const index = flowPhotos.value.findIndex((item) => item.id === photo.id)
  if (index < 0) return

  openViewer(index, route.fullPath || '/album-flow', flowPhotos.value)
}

useHead({
  title: () => $t('title.albumFlow'),
})
</script>

<template>
  <main
    class="relative min-h-[100dvh] overflow-hidden bg-neutral-950 text-white"
  >
    <ClientOnly>
      <div
        v-if="flowPhotos.length"
        class="absolute inset-0"
      >
        <div class="absolute inset-x-[-3vw] inset-y-[-8vh] flex gap-0">
          <div
            v-for="(column, colIndex) in columns"
            :key="colIndex"
            class="album-flow-column relative flex-1 overflow-hidden"
          >
            <div
              class="album-flow-track flex flex-col gap-0 will-change-transform"
              :class="
                colIndex % 2 === 0
                  ? 'album-flow-scroll-down'
                  : 'album-flow-scroll-up'
              "
              :style="{ animationDuration: `${columnDurations[colIndex]}s` }"
            >
              <template
                v-for="groupIndex in 3"
                :key="groupIndex"
              >
                <div
                  v-for="photo in column"
                  :key="`${photo.id}-${groupIndex}`"
                  class="album-flow-tile w-full overflow-hidden"
                >
                  <button
                    type="button"
                    class="block w-full cursor-zoom-in overflow-hidden bg-transparent p-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                    @click="openFlowPhoto(photo)"
                  >
                    <ThumbImage
                      class="h-full w-full object-cover"
                      :src="getFlowImage(photo as FlowPhoto)"
                      :thumbhash="photo.thumbnailHash"
                      :alt="photo.title || $t('ui.photo.altFallback')"
                      :style="{ aspectRatio: photo.aspectRatio || 1 }"
                      :lazy="false"
                    />
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>

        <div
          class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,transparent_0%,rgba(10,10,10,0.12)_34%,rgba(10,10,10,0.78)_100%)]"
        />
        <div
          class="pointer-events-none absolute inset-0 bg-linear-to-b from-neutral-950/30 via-transparent to-neutral-950/40"
        />
      </div>

      <template #fallback>
        <div class="absolute inset-0 bg-neutral-950" />
      </template>
    </ClientOnly>

    <nav
      class="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 p-4 sm:p-6"
    >
      <UButton
        variant="soft"
        color="neutral"
        icon="tabler:arrow-left"
        :label="$t('ui.action.home.tooltip')"
        size="sm"
        to="/"
        class="rounded-full cursor-pointer"
      />

      <UButton
        v-if="accessEntitlement.hasMorePhotos"
        variant="soft"
        color="neutral"
        icon="tabler:lock-open"
        :label="$t('accessGate.morePhotos')"
        :to="unlockUrl('/album-flow')"
        size="sm"
        class="rounded-full cursor-pointer"
      />
    </nav>

    <div
      v-if="!flowPhotos.length"
      class="relative z-10 flex min-h-[100dvh] flex-col items-center justify-center gap-5 px-5 text-center"
    >
      <Icon
        name="tabler:photo-off"
        class="size-14 text-white/40"
      />
      <div>
        <h1 class="text-3xl font-bold">{{ $t('albumFlow.empty') }}</h1>
        <p class="mt-2 text-white/50">{{ $t('ui.stats.noPhotosTip') }}</p>
      </div>
      <UButton
        variant="soft"
        color="neutral"
        icon="tabler:arrow-left"
        :label="$t('ui.action.home.tooltip')"
        size="sm"
        to="/"
        class="rounded-full cursor-pointer"
      />
    </div>
  </main>
</template>

<style scoped>
@keyframes album-flow-down {
  0% {
    transform: translateY(0);
  }
  100% {
    transform: translateY(calc(-100% / 3));
  }
}

@keyframes album-flow-up {
  0% {
    transform: translateY(calc(-100% / 3));
  }
  100% {
    transform: translateY(0);
  }
}

.album-flow-scroll-down {
  animation: album-flow-down linear infinite;
}

.album-flow-scroll-up {
  animation: album-flow-up linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .album-flow-scroll-down,
  .album-flow-scroll-up {
    animation: none;
  }
}
</style>
