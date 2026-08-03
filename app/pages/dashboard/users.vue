<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: () => $t('title.users') })

type ManagedUser = {
  id: number
  username: string
  email: string
  isAdmin: number
  isActive: boolean
  photoCount: number
  albumCount: number
}

const toast = useToast()
const { user: currentUser } = useUserSession()
const { data: users, refresh } =
  await useFetch<ManagedUser[]>('/api/admin/users')
const createOpen = ref(false)
const createLoading = ref(false)
const form = reactive({
  username: '',
  email: '',
  password: '',
  isAdmin: false,
})

const createUser = async () => {
  createLoading.value = true
  try {
    await $fetch('/api/admin/users', { method: 'POST', body: form })
    Object.assign(form, {
      username: '',
      email: '',
      password: '',
      isAdmin: false,
    })
    createOpen.value = false
    await refresh()
    toast.add({
      color: 'success',
      title: $t('dashboard.users.messages.created'),
    })
  } catch (error: any) {
    toast.add({
      color: 'error',
      title: $t('dashboard.users.messages.createFailed'),
      description: error?.data?.message || error?.data?.statusMessage,
    })
  } finally {
    createLoading.value = false
  }
}

const updateUser = async (
  user: ManagedUser,
  patch: Record<string, unknown>,
) => {
  try {
    await $fetch(`/api/admin/users/${user.id}`, {
      method: 'PATCH',
      body: patch,
    })
    await refresh()
  } catch (error: any) {
    toast.add({
      color: 'error',
      title: $t('dashboard.users.messages.operationFailed'),
      description: error?.data?.message || error?.data?.statusMessage,
    })
  }
}

const resetPassword = async (user: ManagedUser) => {
  const password = window.prompt(
    $t('dashboard.users.prompts.resetPassword', { username: user.username }),
  )
  if (!password) return
  await updateUser(user, { password })
  toast.add({
    color: 'success',
    title: $t('dashboard.users.messages.passwordReset'),
  })
}

const deleteUser = async (user: ManagedUser) => {
  if (
    !window.confirm(
      $t('dashboard.users.prompts.deleteUser', { username: user.username }),
    )
  )
    return
  try {
    await $fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({
      color: 'success',
      title: $t('dashboard.users.messages.deleted'),
    })
  } catch (error: any) {
    toast.add({
      color: 'error',
      title: $t('dashboard.users.messages.deleteFailed'),
      description: error?.data?.message || error?.data?.statusMessage,
    })
  }
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="$t('title.users')">
        <template #right>
          <UButton
            icon="tabler:user-plus"
            @click="createOpen = true"
          >
            {{ $t('dashboard.users.actions.createUser') }}
          </UButton>
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <div class="mx-auto w-full max-w-6xl space-y-4">
        <div
          v-for="item in users || []"
          :key="item.id"
          class="flex flex-wrap items-center gap-4 rounded-lg border border-default p-4"
        >
          <UAvatar
            :alt="item.username"
            icon="tabler:user"
          />
          <div class="min-w-48 flex-1">
            <div class="flex items-center gap-2">
              <span class="font-medium">{{ item.username }}</span>
              <UBadge
                :color="item.isAdmin ? 'primary' : 'neutral'"
                variant="subtle"
              >
                {{
                  item.isAdmin
                    ? $t('dashboard.users.roles.admin')
                    : $t('dashboard.users.roles.user')
                }}
              </UBadge>
              <UBadge
                v-if="!item.isActive"
                color="error"
                variant="subtle"
              >
                {{ $t('dashboard.users.status.inactive') }}
              </UBadge>
            </div>
            <p class="text-sm text-muted">{{ item.email }}</p>
            <p class="text-xs text-muted">
              {{
                $t('dashboard.users.stats.summary', {
                  photos: item.photoCount,
                  albums: item.albumCount,
                })
              }}
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <UButton
              color="neutral"
              variant="outline"
              @click="resetPassword(item)"
            >
              {{ $t('dashboard.users.actions.resetPassword') }}
            </UButton>
            <UButton
              v-if="item.id !== currentUser?.id"
              color="neutral"
              variant="outline"
              @click="updateUser(item, { isAdmin: !item.isAdmin })"
            >
              {{
                item.isAdmin
                  ? $t('dashboard.users.actions.demote')
                  : $t('dashboard.users.actions.promote')
              }}
            </UButton>
            <UButton
              v-if="item.id !== currentUser?.id"
              :color="item.isActive ? 'warning' : 'success'"
              variant="outline"
              @click="updateUser(item, { isActive: !item.isActive })"
            >
              {{
                item.isActive
                  ? $t('dashboard.users.actions.disable')
                  : $t('dashboard.users.actions.enable')
              }}
            </UButton>
            <UButton
              v-if="item.id !== currentUser?.id && !item.isAdmin"
              color="error"
              variant="outline"
              @click="deleteUser(item)"
            >
              {{ $t('common.actions.delete') }}
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </UDashboardPanel>

  <UModal
    v-model:open="createOpen"
    :title="$t('dashboard.users.create.title')"
  >
    <template #body>
      <form
        id="create-user-form"
        class="space-y-4"
        @submit.prevent="createUser"
      >
        <UFormField
          :label="$t('dashboard.users.fields.username')"
          required
        >
          <UInput
            v-model="form.username"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="$t('dashboard.users.fields.email')"
          required
        >
          <UInput
            v-model="form.email"
            type="email"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="$t('dashboard.users.fields.initialPassword')"
          :description="$t('dashboard.users.fields.passwordHint')"
          required
        >
          <UInput
            v-model="form.password"
            type="password"
            class="w-full"
          />
        </UFormField>
        <USwitch
          v-model="form.isAdmin"
          :label="$t('dashboard.users.fields.createAsAdmin')"
        />
      </form>
    </template>
    <template #footer>
      <UButton
        color="neutral"
        variant="outline"
        @click="createOpen = false"
      >
        {{ $t('common.actions.cancel') }}
      </UButton>
      <UButton
        type="submit"
        form="create-user-form"
        :loading="createLoading"
      >
        {{ $t('dashboard.users.actions.create') }}
      </UButton>
    </template>
  </UModal>
</template>
