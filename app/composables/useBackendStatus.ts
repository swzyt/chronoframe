export type BackendStatusResponse = {
  currentProvider: 'node' | 'go'
  node: {
    status: string
    owned: boolean
  }
  go: {
    configured: boolean
    status: string
    owned: boolean
    upstream: string
    checks: Record<string, string>
    schema: {
      migrationCount?: number
      latestMigrationMillis?: number
    } | null
    error: string
  }
}

export function useBackendStatus() {
  const status = useState<BackendStatusResponse | null>(
    'backend-runtime-status',
    () => null,
  )
  const loading = useState('backend-runtime-status-loading', () => false)

  const refresh = async () => {
    if (loading.value) return status.value

    loading.value = true
    try {
      status.value = await $fetch<BackendStatusResponse>(
        '/api/system/backend/status',
      )
    } catch {
      status.value = null
    } finally {
      loading.value = false
    }

    return status.value
  }

  return {
    status: readonly(status),
    loading: readonly(loading),
    refresh,
  }
}
