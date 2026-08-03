export default defineNuxtRouteMiddleware(async (to) => {
  if (!to.path.startsWith('/dashboard')) return
  const { session } = useUserSession()
  const requestFetch = useRequestFetch()
  let currentUser
  try {
    currentUser = await requestFetch('/api/profile', {
      cache: 'no-store',
      query: { roleCheck: Date.now() },
    })
    session.value = { ...session.value, user: currentUser }
  } catch {
    return navigateTo({ path: '/signin', query: { redirect: to.fullPath } })
  }
  const memberRoutes = ['/dashboard/photos', '/dashboard/albums']
  if (
    !currentUser.isAdmin &&
    to.path !== '/dashboard' &&
    !memberRoutes.some((route) => to.path === route)
  ) {
    return navigateTo('/dashboard')
  }
})
