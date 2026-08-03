<script setup lang="ts">
import { AMAP_CONTEXT_KEY, wgs84ToGcj02 } from '~/utils/amap'

const props = defineProps<{
  lnglat?: [number, number]
}>()

const context = inject(AMAP_CONTEXT_KEY)
const content = shallowRef<HTMLElement | null>(null)
let marker: any = null

const removeMarker = () => {
  if (marker && context?.map.value) {
    context.map.value.remove(marker)
  }
  marker = null
}

const syncMarker = async () => {
  await nextTick()
  if (!props.lnglat) {
    removeMarker()
    return
  }
  if (
    !context?.map.value ||
    !context.AMap.value ||
    !content.value
  ) {
    return
  }
  const coordinates = wgs84ToGcj02(props.lnglat[0], props.lnglat[1])
  if (!marker) {
    marker = new context.AMap.value.Marker({
      position: coordinates,
      content: content.value,
      anchor: 'center',
      offset: new context.AMap.value.Pixel(0, 0),
    })
    context.map.value.add(marker)
  } else {
    marker.setPosition(coordinates)
  }
}

watch(
  [() => context?.map.value, () => context?.AMap.value, () => props.lnglat],
  syncMarker,
  { immediate: true, deep: true },
)

onBeforeUnmount(removeMarker)

onMounted(() => {
  content.value = document.createElement('div')
  content.value.className = 'pointer-events-auto'
  syncMarker()
})
</script>

<template>
  <Teleport v-if="content" :to="content">
    <slot name="marker" />
  </Teleport>
</template>
