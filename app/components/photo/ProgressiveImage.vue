<script setup lang="ts">
import type { WebGLImageViewerRef } from '@chronoframe/webgl-image'

import type { LoadingIndicatorRef } from './LoadingIndicator.vue'
import type { ImageLoaderManager } from '~/libs/image-loader-manager'

interface Props {
  src: string
  thumbnailSrc?: string
  thumbhash?: string | null
  alt?: string
  width?: number
  height?: number
  className?: string
  enablePan?: boolean
  enableZoom?: boolean
  isCurrentImage?: boolean
  loadingIndicatorRef: LoadingIndicatorRef | null
  onProgress?: (progress: number) => void
  onError?: () => void
  onZoomChange?: (isZoomed: boolean, level?: number) => void
  onBlobSrcChange?: (blobSrc: string | null) => void
  onImageLoaded?: () => void
  isLivePhoto?: boolean
  livePhotoVideoUrl?: string
  isHDR?: boolean
  layoutRefreshKey?: string | number | boolean
  rotation?: number
}

const props = withDefaults(defineProps<Props>(), {
  enablePan: true,
  enableZoom: true,
  isCurrentImage: true,
  thumbnailSrc: '',
  thumbhash: null,
  alt: 'Image',
  width: undefined,
  height: undefined,
  className: '',
  onProgress: undefined,
  onError: undefined,
  onZoomChange: undefined,
  onBlobSrcChange: undefined,
  onImageLoaded: undefined,
  isLivePhoto: false,
  livePhotoVideoUrl: '',
  isHDR: false,
  layoutRefreshKey: 0,
  rotation: 0,
})

const containerRef = ref<HTMLDivElement>()
const webglViewerRef = ref<WebGLImageViewerRef>()

const highResLoaded = ref(false)
const highResRendered = ref(false)
const hasError = ref(false)
const currentSrc = ref<string | null>()

const loaderManagerRef = ref<ImageLoaderManager | null>(null)
const hasEmittedImageLoaded = ref(false)
let resizeFrame: number | null = null
let layoutRefreshFrame: number | null = null

const containerSize = reactive({
  width: 0,
  height: 0,
})

const showThumbnail = computed(() => {
  return props.thumbnailSrc && (!highResRendered.value || hasError.value)
})

const showWebGLViewer = computed(() => {
  return (
    highResLoaded.value &&
    currentSrc.value &&
    props.isCurrentImage &&
    !hasError.value
  )
})

const imageAspectRatio = computed(() => {
  if (props.width && props.height) return props.width / props.height
  return null
})

const fittedImageStyle = computed(() => {
  const ratio = imageAspectRatio.value

  if (!ratio || !containerSize.width || !containerSize.height) {
    return {
      maxWidth: '100%',
      maxHeight: '100%',
    }
  }

  let width = containerSize.width
  let height = width / ratio

  if (height > containerSize.height) {
    height = containerSize.height
    width = height * ratio
  }

  return {
    width: `${Math.max(1, Math.round(width))}px`,
    height: `${Math.max(1, Math.round(height))}px`,
    maxWidth: '100%',
    maxHeight: '100%',
  }
})

const fittedImageSizeKey = computed(() => {
  const style = fittedImageStyle.value
  return `${style.width || 'auto'}:${style.height || 'auto'}`
})

const resetZoomState = () => {
  props.onZoomChange?.(false, 1)
}

const measureContainer = () => {
  if (!containerRef.value) return

  const rect = containerRef.value.getBoundingClientRect()
  updateContainerSize(rect.width, rect.height)
}

const updateContainerSize = (width: number, height: number) => {
  const nextWidth = Math.round(width)
  const nextHeight = Math.round(height)

  if (
    containerSize.width === nextWidth &&
    containerSize.height === nextHeight
  ) {
    return
  }

  containerSize.width = nextWidth
  containerSize.height = nextHeight
}

const refreshWebGLLayout = async () => {
  if (!showWebGLViewer.value) return

  measureContainer()
  await nextTick()

  webglViewerRef.value?.resize()
}

const handleWebGLImageLoaded = async () => {
  measureContainer()
  highResRendered.value = true

  if (!hasEmittedImageLoaded.value) {
    hasEmittedImageLoaded.value = true
    props.onImageLoaded?.()
  }

  await nextTick()
  webglViewerRef.value?.resize()
}

const handleWebGLError = () => {
  hasError.value = true
  highResRendered.value = false
  resetZoomState()
  props.onError?.()
}

const handleWebGLZoomChange = (
  _originalScale: number,
  relativeScale: number,
) => {
  props.onZoomChange?.(relativeScale > 1.1, Math.round(relativeScale * 10) / 10)
}

const webglPanningConfig = computed(() => ({
  disabled: !props.enablePan,
  velocityDisabled: true,
}))

const webglWheelConfig = computed(() => ({
  step: 0.12,
  wheelDisabled: !props.enableZoom,
  touchPadDisabled: false,
}))

const webglPinchConfig = computed(() => ({
  step: 0.5,
  disabled: !props.enableZoom,
}))

const webglDoubleClickConfig = computed(() => ({
  step: 2.5,
  disabled: !props.enableZoom,
  mode: 'toggle' as const,
  animationTime: 180,
}))

const loadImage = () => {
  loaderManagerRef.value = useImageLoader(
    props.src,
    props.isCurrentImage,
    highResLoaded.value,
    hasError.value,
    props.loadingIndicatorRef,
    props.onProgress,
    props.onError,
    (src) => (currentSrc.value = src),
    (loaded) => (highResLoaded.value = loaded),
    (error) => (hasError.value = error),
    (rendered) => {
      highResRendered.value = rendered
    },
    undefined,
  )
}

// 监听 isCurrentImage 的变化，当变为 true 时触发图片加载
watch(
  () => props.isCurrentImage,
  (isCurrent, wasCurrent) => {
    if (!isCurrent && wasCurrent) {
      // 当图片不再是当前图片时，中断加载
      loaderManagerRef.value?.cleanup()
      loaderManagerRef.value = null
      resetZoomState()
    } else if (
      isCurrent &&
      !wasCurrent &&
      !highResLoaded.value &&
      !hasError.value
    ) {
      // 当图片变为当前图片且尚未加载高分辨率图片时，触发加载
      loadImage()
    }
  },
  { immediate: false },
)

// 监听 src 的变化，当源地址改变时重置状态并重新加载
watch(
  () => props.src,
  (newSrc, oldSrc) => {
    if (newSrc !== oldSrc) {
      // 中断之前的加载
      loaderManagerRef.value?.cleanup()
      loaderManagerRef.value = null

      // 重置状态
      highResLoaded.value = false
      highResRendered.value = false
      hasEmittedImageLoaded.value = false
      hasError.value = false
      currentSrc.value = null
      resetZoomState()

      // 如果是当前图片，立即开始加载
      if (props.isCurrentImage) {
        loadImage()
      }
    }
  },
  { immediate: false },
)

watch(
  () => props.enableZoom,
  (enabled) => {
    if (enabled) return
    webglViewerRef.value?.resetView()
    resetZoomState()
  },
)

watch(
  () => props.isCurrentImage,
  (isCurrent) => {
    if (!isCurrent) return
    webglViewerRef.value?.resetView()
    resetZoomState()
  },
)

watch(showWebGLViewer, async (visible) => {
  if (!visible) return

  await nextTick()
  await refreshWebGLLayout()
})

watch(
  fittedImageSizeKey,
  async () => {
    if (!showWebGLViewer.value) return

    await nextTick()
    await refreshWebGLLayout()
  },
  { flush: 'post' },
)

watch(
  () => props.layoutRefreshKey,
  async () => {
    if (!import.meta.client || !showWebGLViewer.value) return

    await nextTick()

    if (layoutRefreshFrame !== null) {
      cancelAnimationFrame(layoutRefreshFrame)
    }

    layoutRefreshFrame = requestAnimationFrame(() => {
      layoutRefreshFrame = requestAnimationFrame(async () => {
        await refreshWebGLLayout()
        layoutRefreshFrame = null
      })
    })
  },
  { flush: 'post' },
)

// 初始加载
loadImage()

useResizeObserver(containerRef, (entries) => {
  const entry = entries[0]
  const rect = entry?.contentRect
  if (!rect) return

  if (resizeFrame !== null) {
    cancelAnimationFrame(resizeFrame)
  }

  resizeFrame = requestAnimationFrame(() => {
    updateContainerSize(rect.width, rect.height)
    resizeFrame = null
  })
})

onUnmounted(() => {
  if (resizeFrame !== null) {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = null
  }

  if (layoutRefreshFrame !== null) {
    cancelAnimationFrame(layoutRefreshFrame)
    layoutRefreshFrame = null
  }
})

// 组件卸载时清理
onUnmounted(() => {
  loaderManagerRef.value?.cleanup()
  loaderManagerRef.value = null
})
</script>

<template>
  <div
    ref="containerRef"
    class="relative w-full h-full flex items-center justify-center"
  >
    <!-- 缩略图 (加载时显示) -->
    <!-- <img
      v-if="showThumbnail"
      :src="thumbnailSrc"
      :alt="alt"
      class="absolute inset-0 w-full h-full object-contain"
    /> -->
    <!-- use <ThumbImage /> instead -->
    <ThumbImage
      v-if="showThumbnail"
      :src="thumbnailSrc"
      :thumbhash="thumbhash"
      :alt="alt || $t('ui.photo.altFallback')"
      class="absolute inset-0 z-0 m-auto object-contain transition-opacity duration-150"
      :style="fittedImageStyle"
      thumbhash-class="opacity-50"
      image-contain
    />

    <!-- WebGL 缩放图片查看器 -->
    <WebGLImageViewer
      v-if="showWebGLViewer"
      ref="webglViewerRef"
      :src="currentSrc!"
      :class="className"
      class="absolute inset-0 z-10 h-full w-full"
      :min-scale="1"
      :max-scale="12"
      :rotation="rotation"
      :smooth="true"
      :limit-to-bounds="true"
      :panning="webglPanningConfig"
      :wheel="webglWheelConfig"
      :pinch="webglPinchConfig"
      :double-click="webglDoubleClickConfig"
      @image-loaded="handleWebGLImageLoaded"
      @error="handleWebGLError"
      @zoom-change="handleWebGLZoomChange"
    />

    <!-- 错误状态 -->
    <div
      v-if="hasError"
      class="flex flex-col items-center justify-center text-white/70 gap-2"
    >
      <Icon
        name="tabler:photo-off"
        class="w-12 h-12"
      />
      <p class="text-sm">{{ $t('photo.image.loadError') }}</p>
    </div>
  </div>
</template>

<style scoped></style>
