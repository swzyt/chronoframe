<script setup lang="ts">
import {
  AMAP_CONTEXT_KEY,
  gcj02ToWgs84,
  loadAMap,
  wgs84ToGcj02,
} from '~/utils/amap'

const props = withDefaults(
  defineProps<{
    apiKey: string
    securityJsCode?: string
    center?: [number, number]
    zoom?: number
    interactive?: boolean
  }>(),
  {
    securityJsCode: '',
    center: () => [104.1954, 35.8617],
    zoom: 2,
    interactive: true,
  },
)

const emit = defineEmits<{
  load: [map: any]
  zoom: []
}>()

const container = ref<HTMLElement | null>(null)
const map = shallowRef<any | null>(null)
const AMap = shallowRef<any | null>(null)
const loadFailed = ref(false)
let destroyed = false

provide(AMAP_CONTEXT_KEY, { map, AMap })

const toGcj = (coordinates: [number, number]) =>
  wgs84ToGcj02(coordinates[0], coordinates[1])

const createAdapter = (nativeMap: any) => {
  const clickWrappers = new Map<
    (...args: any[]) => void,
    (...args: any[]) => void
  >()
  const adapter: any = {
    __provider: 'amap',
    __native: nativeMap,
    setCenter: (center: [number, number]) => nativeMap.setCenter(toGcj(center)),
    setZoom: (zoom: number) => nativeMap.setZoom(zoom),
    getZoom: () => nativeMap.getZoom(),
    getBounds: () => {
      const bounds = nativeMap.getBounds()
      const southWest = bounds.getSouthWest()
      const northEast = bounds.getNorthEast()
      const [west, south] = gcj02ToWgs84(southWest.getLng(), southWest.getLat())
      const [east, north] = gcj02ToWgs84(northEast.getLng(), northEast.getLat())
      return [
        [west, south],
        [east, north],
      ]
    },
    flyTo: (options: { center?: [number, number]; zoom?: number }) => {
      const center = options.center
        ? toGcj(options.center)
        : nativeMap.getCenter()
      nativeMap.setZoomAndCenter(
        options.zoom ?? nativeMap.getZoom(),
        center,
        false,
        400,
      )
    },
    fitBounds: (
      bounds: [[number, number], [number, number]],
      options?: { padding?: number },
    ) => {
      const southWest = toGcj(bounds[0])
      const northEast = toGcj(bounds[1])
      nativeMap.setBounds(new AMap.value.Bounds(southWest, northEast), false, [
        options?.padding ?? 50,
        options?.padding ?? 50,
        options?.padding ?? 50,
        options?.padding ?? 50,
      ])
    },
    zoomIn: () => nativeMap.zoomIn(),
    zoomOut: () => nativeMap.zoomOut(),
    on: (event: string, handler: (...args: any[]) => void) => {
      if (event === 'click') {
        const wrapper = (amapEvent: any) => {
          const lng = amapEvent.lnglat.getLng()
          const lat = amapEvent.lnglat.getLat()
          const [wgsLng, wgsLat] = gcj02ToWgs84(lng, lat)
          handler({ lngLat: { lng: wgsLng, lat: wgsLat } })
        }
        clickWrappers.set(handler, wrapper)
        nativeMap.on(event, wrapper)
      } else {
        nativeMap.on(event, handler)
      }
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      nativeMap.off(event, clickWrappers.get(handler) || handler)
      clickWrappers.delete(handler)
    },
    remove: destroyMap,
  }
  return adapter
}

function destroyMap() {
  if (destroyed) return
  destroyed = true
  map.value?.destroy()
  map.value = null
}

onMounted(async () => {
  if (!container.value || !props.apiKey || !props.securityJsCode) return
  try {
    AMap.value = await loadAMap(props.apiKey, props.securityJsCode)
    if (!container.value || destroyed) return
    const initialCenter = toGcj(props.center)
    const nativeMap = new AMap.value.Map(container.value, {
      center: initialCenter,
      zoom: props.zoom,
      viewMode: '2D',
      resizeEnable: true,
      dragEnable: props.interactive,
      zoomEnable: props.interactive,
      doubleClickZoom: props.interactive,
      keyboardEnable: props.interactive,
      scrollWheel: props.interactive,
    })
    nativeMap.on('zoomchange', () => emit('zoom'))
    map.value = nativeMap
    emit('load', createAdapter(nativeMap))
  } catch (error) {
    loadFailed.value = true
    console.error('Failed to initialize AMap:', error)
  }
})

onBeforeUnmount(destroyMap)
</script>

<template>
  <div class="relative h-full w-full">
    <div
      ref="container"
      class="h-full w-full"
    />
    <div class="absolute inset-0 pointer-events-none">
      <slot />
    </div>
    <div
      v-if="!apiKey || !securityJsCode || loadFailed"
      class="absolute inset-0 flex items-center justify-center bg-neutral-100/90 p-6 text-center text-sm text-neutral-600 dark:bg-neutral-900/90 dark:text-neutral-300"
    >
      {{
        $t(
          loadFailed
            ? 'settings.map.amap.loadError'
            : 'settings.map.amap.missingConfig',
        )
      }}
    </div>
  </div>
</template>
