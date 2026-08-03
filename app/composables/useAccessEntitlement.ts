export interface AccessEntitlement {
  required: boolean
  granted: boolean
  photoLimit: number
  albumLimit: number
  totalPhotos: number
  totalAlbums: number
  hasMorePhotos: boolean
  hasMoreAlbums: boolean
}

export function useAccessEntitlement() {
  const state = useState<AccessEntitlement>('site-access-entitlement', () => ({
    required: false,
    granted: true,
    photoLimit: 10,
    albumLimit: 1,
    totalPhotos: 0,
    totalAlbums: 0,
    hasMorePhotos: false,
    hasMoreAlbums: false,
  }))
  return {
    accessEntitlement: state,
    canViewAll: computed(() => !state.value.required || state.value.granted),
    unlockUrl: (redirect: string) => ({
      path: '/access',
      query: { redirect },
    }),
  }
}
